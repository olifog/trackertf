# tracker.tf — resurrection plan

Successor to style.tf (2022, MongoDB + friend-graph crawler + Next.js on Vercel; DB lost,
site still serving one ISR-cached filter combo — snapshot preserved in
`data/styletf-cached-usage-2026-08-16.json`).

## Verified facts (2026-08-16)

**Steam API — all core endpoints alive, tested with the tracker.tf key:**

- `IEconItems_440/GetPlayerItems` works (200/status 1 on a public backpack; private backpacks
  surface as HTTP 503/status 15 — treat any status≠1 or 4xx/5xx as "unusable, record why").
- `ISteamUserStats/GetUserStatsForGame` (appid 440) returns ~489 stats incl.
  `<Class>.accum.iPlayTime/iNumberOfKills/iKillAssists/iDamageDealt/iPointsScored/...`
  (lifetime cumulative), `<Class>.max.*` (best-single-life records), MvM variants, and
  `<mapname>.accum.iPlayTime`. Private "game details" → HTTP 400/empty.
- `ISteamUser/GetFriendList` works; 401 when friends list is private.
- `IGameServersService/GetServerList` works (filter `\appid\440`) — server names, maps,
  player counts, gametype. A2S/GetServerList give NO steamids; discovery = friend BFS,
  sequential steamid-space sampling via `GetPlayerSummaries` (100 ids/call), and
  logs.tf / league APIs (RGL, ETF2L) as richer seed sources.
- Rate limit: 100,000 calls/day per key (~1.15 req/s sustained); throttling is 429s, no
  documented key bans for compliant volume. `GetPlayerSummaries` batches 100 steamids/call.
- Item schema: pull `items_game.txt` + schema from `SteamDatabase/GameTracking-TF2` (updated
  through Summer 2026) instead of burning API calls on `GetSchemaItems`.

## Data source map (research completed 2026-08-16)

**Core (build on these):**

- Per-player Web API crawl (items/stats/friends) — the only way to get weapon/class aggregates;
  Valve publishes NO global TF2 stats (all 758 schema stats tested: none aggregated).
- `IGameServersService/QueryByFakeIP` — live scoreboards + rules on official Valve casual
  servers (see scanner section). Semi-secret; teamwork.tf doesn't appear to use it.
- Keyless playerbase endpoints: `GetNumberOfCurrentPlayers`, `ISteamChartsService/
GetGamesByConcurrentPlayers` (CCU + daily peak).
- Steamid seeding: friend BFS + `store.steampowered.com/appreviews/440` (keyless, 740k
  reviews with author steamid AND TF2 playtime — casual-skewed, counters BFS bias) +
  random steamid-space sampling. Kaggle steam-reviews dumps as offline seed backup.
- `SteamDatabase/GameTracking-TF2` — items_game.txt, tf_english.txt (map display names,
  localization), protobufs; updated every TF2 patch. Use instead of API schema calls.

**Useful enrichment:**

- teamwork.tf API (free key, 90 req/min, 10-min ban on excess) — official-vs-community
  population split per gamemode; poll for cross-validation of our scanner.
- `ISteamUser/GetPlayerBans` — bulk VAC/game-ban flags; exclude bot accounts from stats.
- `GetGlobalAchievementPercentagesForApp` (keyless) — engagement proxies.
- `steamcommunity.com/miniprofile/<accountid>` — public, unauthenticated rich presence
  ("playing Casual on X") for any public profile; niche per-player live features.
- Public inventory endpoint MvM tour badges — tour progress for MvM pages (community
  endpoint is datacenter-IP-hostile; low volume only).
- ITFSystem_440/GetWorldStatus, ITFItems_440/GetGoldenWrenches — trivia.

**Dead ends (confirmed — don't revisit):**

- TF2 Game Coordinator: NO player-lookup API exists (exhaustive ETFGCMsg enum read —
  unlike Dota/CS). Bot accounts learn others' badge_level/rating only inside their own
  party/lobby. GCPD pages (`/my/gcpd/440` — casual Glicko MMR, match history) and
  friends/coplay are strictly own-account. Only path: opt-in user import via browser
  extension (Leetify pattern) — viable Stage 5 feature for consenting users.
- GetGlobalStatsForGame (no aggregated stats), Wayback backfill of style.tf (/usage never
  captured), SteamDB (no API, scraping banned), BattleMetrics (paywalled ~Jul 2026),
  direct SDR queries (ticket-gated), `<Class>.accum.iNumDeaths`/iNumShots* (defined in
  schema, never uploaded by client — verify at scale in pilot, expect absent).
- Old droplet snapshot = the ONLY source of 2022 historical data. Recover it early.

**Capacity math:** ~3 calls/player (items + stats + owned-games) + amortized friend-list
calls ≈ 3.3/player → **~28k players/day, ~850k/month** on one key, leaving headroom for the
server scanner (GetServerList every 5 min ≈ 300/day).

**Infra:**

- VPS `UBUNTU-MAIN`: 16 cores / 61GB RAM / 879GB free, Docker + nginx-proxy + acme already
  running. Runs Postgres + crawler + analyser.
- Web on Vercel. TanStack Start is v1 RC (Aug 2026: `@tanstack/react-start` 1.168.x), Vite
  based, officially documented by Vercel via the Nitro plugin. ISR equivalent: Nitro
  `routeRules: { "/x/**": { isr: { expiration: 3600 } } }` — direct replacement for the old
  `revalidate: 3600`. Skip RSC (TanStack themselves backed off it, Jul 2026).
- Data layer: TanStack Query + `@tanstack/react-router-ssr-query`, server functions as
  transport (no tRPC needed), **Drizzle ORM** (SQL-first fits the aggregate-heavy workload).

## Architecture

```
VPS (Docker)                                  Vercel
┌──────────────────────────────┐              ┌──────────────────────┐
│ crawler ── writes ─▶ Postgres│◀─ Drizzle ── │ TanStack Start (SSR) │
│ analyser ─ reads/writes ──▲  │  (pgbouncer, │  ISR 1h on stat pages│
│ server-scanner (5 min) ───┘  │   TLS, ro    │                      │
│ frontier queue = pg table    │   user)      │                      │
└──────────────────────────────┘              └──────────────────────┘
```

- One Postgres for everything; web reads only small precomputed aggregate tables through a
  read-only role via pgbouncer. ISR keeps query volume trivial.
- Crawl frontier persisted in Postgres (fixes old in-memory queue lost on restart).
- Store raw API responses (JSONB, compressed) alongside parsed rows so later features never
  require a recrawl.
- Redis optional later (leaderboard sorted sets); not needed for v1.

## Schema sketch (raw layer)

- `players(steamid pk, first_seen, last_crawled, personaname, avatar, visibility,
tf2_minutes, active_2wk, items_status, stats_status, friends_status)`
- `player_items_raw(steamid, fetched_at, payload jsonb)` / `player_stats_raw(...)`
- `equipped_items(steamid, defindex, class, slot)` — parsed, stock backfilled (port old logic)
- `player_class_stats(steamid, class, playtime_s, kills, assists, deaths?*, damage, points, ...)`
  (*no deaths stat exists — K/D must be kills/playtime or points-based; note on site)
- `item_schema(defindex, name, item_name, used_by_classes, slot, image_url, equip_region,
reskin_group)` — reskin_group hand-curated + prefab-derived, enables "merge reskins"
- `crawl_frontier(steamid pk, source, priority, enqueued_at, attempts)`
- `server_snapshots(ts, region?, map, gametype, players, bots, server_count)` (aggregated
  per scan, not per-server rows, to keep volume sane)

## Stages

### Stage 0 — Foundations (repo + infra)

- Rebuild monorepo: `apps/web` (TanStack Start, replaces the Next 14 stub), `apps/crawler`,
  `packages/db` (Drizzle schema + client), `packages/tf2-schema` (items_game sync from
  GameTracking-TF2, reskin grouping).
- Postgres + pgbouncer containers on the VPS behind the existing nginx/acme setup;
  Drizzle migrations; API key in `.env`/Vercel env only (never committed).
- Recover the old droplet snapshot if it still exists → mongodump → import as a
  `styletf_2022` historical dataset (usage-over-4-years comparisons later).

### Stage 1 — Crawler v2 + pilot measurement

- Persistent-frontier crawler: friend BFS + random steamid-space sampling (NOT logs.tf
  seeding — comp bias conflicts with the official-casual focus); token-bucket rate limiter
  budgeting the whole key (crawler + scanner share it); per-endpoint outcome recording.
- **Pilot run (~5–10k players) to measure**: GetPlayerItems private/error rate,
  GetFriendList 401 rate, stats-private rate — the old "is this feasible" question,
  answered with data. Decide recrawl cadence from this.
  GetPlayerItems 503 = private AND transient GC stress (backpack.tf: ~40% failures
  in busy periods; client retries 3x spaced) — pilot must recrawl a sample of
  "private" verdicts later to measure residual misclassification.
- Server scanner cron: GetServerList every 5 min → `server_snapshots` (playerbase +
  map/gamemode popularity accrues from day one — it's cheap, don't defer it).
  Tag rows valve-official vs community (`\nor\1\gametype\valve` filter distinguishes);
  dashboards default to official casual, community view is a free later feature.
- **QueryByFakeIP** (verified 2026-08-16): `IGameServersService/QueryByFakeIP/v1`
  (`fake_ip` as packed uint32, `query_type` 1=info/2=players/3=rules) proxies A2S to
  SDR-hidden Valve MM servers — live scoreboards (name/score/time_played) + full cvars on
  official casual. teamwork.tf lost this visibility in the July-2023 SDR migration and
  appears not to have adopted it → differentiators: gamemode detection on Valve servers
  (rules), bot detection (player lists), per-map score/min distributions on official casual.
  Scanner split: community servers via free direct UDP A2S from the VPS; Valve servers via
  GetServerList baseline (5 min) + QueryByFakeIP players/rules on a budgeted rotating sample
  (~1 sweep/hr of populated servers; shares the 100k/day key budget with the crawler).
  Do NOT pursue direct SDR connections (ticket-gated via GC, requires queueing into real
  matches — disruptive dead end, confirmed by teamwork.tf community research).
- Let the crawler run continuously from here on; data accumulates while UI gets built.

### Stage 2 — styletf parity → launch tracker.tf

- Analyser: SQL aggregation job (replaces the 400-combo Mongo cartesian product) writing
  `usage_stats(defindex, class, slot, active, minutes_threshold, usage, sample_size)`.
  Add: sample sizes shown in UI, reskin-merged variant of every stat.
- Web: usage explorer (class/slot/active/experienced/ignore-PDAs filters, item images,
  shareable filter URLs — TanStack Router typed search params are ideal), ISR 1h.
- Launch: tracker.tf live with old functionality + reskin merge + visible methodology page.

**Lessons from the 2022 Reddit feedback (r/tf2 + r/truetf2 comment archive):**

- #1 complaint: quality/reskin splitting corrupted headline numbers. Strange/renamed stock
  items are SEPARATE defindexes ("Upgradeable TF_WEAPON_*" — construction PDA showed 90%
  instead of 100%; stock shotgun looked unpopular vs a dozen <1% variants). Functional-group
  merging (strange/renamed/festive/botkiller/skins/true reskins; watch the Vintage
  Lugermorph separate-defindex case) must be the DEFAULT view at launch, with expandable
  per-variant breakdown ("Stock & reskins: xx%" → rows). The merge=false view is the toggle.
- Requested and promised in 2022: all-slots-at-once view with ignore-cosmetics/taunts
  toggles (not just per-slot); weapon-overlap correlations ("if ubersaw, what else?") —
  now Stage 3 loadout combos.
- Biases users caught, to document on the methodology page: friend-BFS skews rich/active
  (gold frying pan at 1% on sniper; 27% "active" rate was implausible); equip data is the
  ACTIVE loadout preset only (troll-loadout noise assumed to cancel out); renamed-unique vs
  strange indistinguishable within Upgradeable defindexes.

### Stage 3 — The new stats (the interesting part)

- Owner-equip rates (equipped | owned — needs ownership from the same GetPlayerItems data).
- Weapon pair/loadout combination stats (size-2/3 combos per class).
- Per-class playtime & K-proxy stats from GetUserStatsForGame: class-main distribution,
  kills/hour and points/minute per class, "best weapons by points/min" (loadout × stats join).
  Caveat for methodology page: accum stats span ALL servers (no casual-only filter exists);
  check `GCStat.MatchWins/MatchCompletion/MatchPoints_Casual` coverage in the pilot —
  if widely populated, casual winrate is possible.
- Leaderboards: playtime overall/per class, headshots, backstabs, heals, etc.

### Stage 4 — Time series & player pages

- Periodic recrawl of known players → delta snapshots → usage-over-time charts
  ("ship daily quantized stats to client, interpolate" per old notes).
- Playerbase-over-time + map/gamemode popularity dashboards from `server_snapshots`.
- Individual player pages (steamid lookup / vanity URL): class playtimes, stats history,
  strange item progress ("time to Hale's Own"), loadout vs. meta comparison.

### Stage 5 — Stretch

- Redis sorted-set live leaderboards; taunt/cosmetic combo stats; MvM stats.
- Community-server data (out of scope for core — site is official-casual-first):
  logs.tf ingestion (community/comp servers only — Valve servers never upload there)
  for true K/D on that subset + calibrated K/D estimates; community server dashboards
  from the already-tagged `server_snapshots`.

## Methodology notes (carry over the r/truetf2 lessons)

- Friend-BFS is biased toward connected/veteran players — mitigate with steamid-space
  random sampling as a second discovery mode, and publish sample composition.
- Always show sample sizes; keep the active/experienced filters (they were the site's
  credibility feature).
- No deaths stat exists in Steam's TF2 stats — never present "K/D" as such; use kills/hour
  or points/minute.

## Analytics engine policy (decided 2026-08-18)

Postgres stays the transactional source of truth permanently (frontier SKIP LOCKED,
players upserts, sessions, item schema). For "incredibly fast" dynamic
leaderboards/percentiles:

- NOW: `board_distributions` in the analyser — ~1000-point quantile arrays per
  (metric, class, threshold bucket) every 15 min; percentile lookup = array binary
  search (microseconds, no scans). Sliders snap to buckets.
- ADD CLICKHOUSE as an analytics sidecar (docker on VPS, Vercel queries its HTTPS
  interface) when ANY of: stat_windows + match_participants > ~10M rows; want truly
  arbitrary-threshold interactive leaderboards; player-page analytics p95 > 100ms.
  Migrate ONLY append-only streams (snapshots, windows, match observations,
  server_snapshots) — never the mutable tables. CH primitives that map 1:1:
  AggregatingMergeTree + quantileTDigest sketches per board.
