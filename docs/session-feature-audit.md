# tracker.tf — Session Feature Audit

**Date:** 2026-08-20 (updated post Wave-4 deploy)
**Scope:** Every distinct idea, feature, correction, or direction olifog raised across the entire (heavily compacted) Claude Code session, cross-checked against the memory log and the actual codebase.

Sources: the session transcript (`31ad068c-…jsonl`, ~64 genuine user messages spanning 2026-08-16 → 2026-08-20), the project memory files (`trackertf-resurrection.md`, `deploy-ops.md`, `botness-exclusion.md`), and the live code under `apps/web/src`, `apps/crawler/src`, `packages/*`.

Legend: ✅ Done · 🟡 Partial · ❌ Missing / not started · 🚫 Cancelled by user · 🔧 In progress (this session's second wave)

> **Wave 4 (deployed 2026-08-20):** forward attribution (`segment_attributions`), the `stat_windows` builder, map×class playtime attribution (`map_class_playtime`), match/map duration stats, the sampler rethink (longer windows + **points-reset** boundary detection), and item-page strange distribution all shipped to prod. Items below updated to reflect this.
>
> **Second wave (in progress, NOT yet deployed):** sessions section on the player page, per-map best-weapons/leaderboards UI, winrate instrumentation, a player-page prod-error fix, and a cross-cutting query-performance pass. Marked 🔧. Final recount happens after this wave deploys.

---

## Summary counts

| Status | Count |
|---|---|
| ✅ Done | 65 |
| 🟡 Partial | 16 |
| ❌ Missing / not started | 10 |
| 🚫 Cancelled | 4 |

(Counts are of the de-duplicated line items below; a handful of "impossible per Steam API" items are folded into ❌/🟡 with a note. 🔧 in-progress items keep their pre-deploy status in the counts until they ship.)

---

## 1. Core data / analytics (the style.tf parity + original PLAN)

- [x] ✅ **Overall weapon usage rates** — `/usage` (`apps/web/src/server/usage.ts`, `routes/usage.tsx`).
- [x] ✅ **Weapon owner-equip rates** — usage populations / equip-rate denominators (`lib/slots.ts` slot-aware denominators).
- [x] ✅ **Paired-weapon combinations** — `/combos` (2/3/N-weapon per class, `server/combos.ts`).
- [x] ✅ **Optionally accumulate reskins into same stats** — merge-reskins toggle on `/usage` (default ON); reskin grouping via `items_game.txt` prefab resolution + manual merges.
- [x] ✅ **Players over time + favourite game modes (teamwork.tf-style)** — `/ecosystem` + `/servers` (players-over-time by gamemode 24h/7d/14d, gamemode donut).
- [x] ✅ **Individual player pages (class stats, active loadouts)** — `/player/$steamid`.
- [x] ✅ **"Most popular class mains" / player-type distribution** — class-playtime surfaced on `/ecosystem`. (Not a dedicated "class mains" leaderboard, but the distribution is exposed.)
- [ ] 🔧 **Score/min paired with equipped weapon AND map → best weapons per map** — `/performance` ranks best weapons/combos by pts-hr / kills-hr / dmg-min; the map-attribution backend (`map_class_playtime` + `segment_attributions`) now ships, and the **per-MAP** best-weapons/leaderboards UI is being built this wave.
- [ ] 🔧 **Player stats over time / best classes over time** — class-stats table + sightings timeline exist; the `stat_windows` builder now ships (§8), and the **sessions section** consuming it on the player page is being built this wave.
- [ ] ❌ **K/D tracking + per-class K/D + K/D leaderboards** — **impossible via Steam API** (verified: `iNumDeaths` defined in schema but never uploaded; "never present K/D"). Effectively cancelled by API reality.
- [ ] 🔧 **Winrates** — being instrumented this wave (GCStat win/loss-counter measurement across recrawls; verifying the counters actually move before building trends).
- [ ] 🟡 **Time played on specific weapons** — no per-weapon playtime from the API; approximated only via equipped-experience thresholds (lifetime / active-2wk minutes on the item).
- [ ] ❌ **Recover old style.tf droplet-snapshot data** — data remains lost; only the single ISR-cached usage combo (`data/styletf-cached-usage-*.json`) was preserved.

### Brainstorm list extras (msg 0)

- [x] ✅ **Strange items + approx time to Hale's Own on player page** — shipped (helper `haleOwnPct`, wave 2).
- [ ] 🟡 **Leaderboards for playtime overall / per-class / per-map + distribution graphs** — overall + per-class boards exist (151-board engine, `packages/db/src/boards.ts`); **per-MAP boards ❌** and **distribution graphs ❌**.
- [ ] 🟡 **Leaderboard for most Hale's-Own / Mann-Co items, with each player's top item shown** — overall "Hale's Own" strange board + strange-kills boards shipped; "top item per player" display and Mann-Co-specific board are partial/absent.
- [x] ✅ **Usage tracker for most-used size-N weapon combos** — `/combos`.
- [ ] 🟡 **Most-used taunts tracker** — taunts selectable as a usage slot filter, but no dedicated taunt tracker/board.
- [ ] ❌ **Most-used size-N cosmetic combos** — combos are weapons only; cosmetic-combo tracking not built.
- [x] ✅ **TF2 playerbase tracker over time** — `population_snapshots` (scanner samples `GetNumberOfCurrentPlayers` every 5 min) surfaced on `/health`.
- [ ] 🚫 **Ship daily quantized stats to client + client-side interpolation/filtering** — superseded by the Postgres/ClickHouse server-side architecture (fast server queries instead of shipping raw data to the browser).

---

## 2. Player page

- [x] ✅ **Fix 30-second load time** — 30s → ~1.6s (rank-query rewrite, commit `a05aac9`).
- [x] ✅ **Show user inventory** — inventory surfaced (defindex/quality/count).
- [x] ✅ **Show user friends** — friends surfaced.
- [x] ✅ **Equipped items colored by item quality** — `lib/quality.ts` (`qualityColor`).
- [x] ✅ **Rank among friends** — `fetchFriendRanks` scopes ranking to `player_friends_raw ∪ self`.
- [x] ✅ **Strange weapons + % to Hale's Own** — shipped.
- [x] ✅ **Real "sightings" from server crawler (100% strong, unique-name matches)** — `server/sightings.ts` + `SightingsSection` (reverse of `resolveParticipant`).
- [x] ✅ **Request-recrawl button + recrawl queue visibility** — `requestRecrawl` (priority-3 frontier insert) + `/health` "Crawl queue" section.
- [ ] 🟡 **Player shows position on EVERY leaderboard for EVERY stat** — shows top-20 rank positions + percentile, but not literally all 151 boards / all delta-derived stats.
- [ ] 🔧 **Sessions on the player page** — `stat_windows` builder now ships (§8); the sessions UI consuming it is being built this wave.
- [ ] ❌ **MVM data on player page** — mentioned in original brainstorm; not surfaced.
- [ ] 🔧 **Prod error when loading a player page (msg 192, 2026-08-20 19:24)** — screenshot bug report; being hunted + fixed this wave (reproduce on live `/player/$steamid` edge cases → guard the defect).

---

## 3. Usage page UX (largely from the reddit-feedback replay)

- [x] ✅ Merge-reskins toggle default ON.
- [x] ✅ Hide-PDAs toggle default ON.
- [x] ✅ Defindex shown as small transparent `#XXXX` next to the icon (not a column).
- [x] ✅ Click a `+reskins` row to expand and see the constituent reskins (expandable variant groups + kind badges).
- [x] ✅ Fix reskins that weren't combining (Original/Rocket Launcher 18↔205, botkillers, festive crossbow, AWPer Hand, Rainblower, Iron Curtain, Robo/Festive Sandvich, Fishcake, Bread Bite, etc.). *Cow Mangler intentionally NOT merged; Shooting Star merges to Machina by design.*
- [x] ✅ Class picker: drop class names, zero-gap icon segments (one extended button).
- [x] ✅ Clean up the "wall of toggle buttons" UI → labeled filter bars / segmented controls.
- [x] ✅ Expose variant quality via color (stock vs Unique/Uncraftable/Untradeable).
- [x] ✅ Merge all-class melees into stock on class-specific filters (pan folds into stock melee on class views).
- [x] ✅ Warpaint display (names from `tf_proto_obj_defs_english.txt`).
- [x] ✅ Separate strange vs renamed in variants (strange-share bars, `strangeSharesQueryOptions`).
- [x] ✅ Usage delta-compare mode (noobs vs experienced) — commit `e537ed4`.
- [x] ✅ 2000h+ / active-2wk / leaderboard thresholds as sliders (population sliders), not hardcoded.
- [x] ✅ `useInfiniteQuery` instead of "show 100 then load all".
- [x] ✅ Loading states — immediate navigation + skeletons + spinner overlay on filter change.
- [x] ✅ Fix right-hand probability being cut off at 3–4-digit counts (bars removed / layout fixed).

---

## 4. Leaderboards

- [x] ✅ **A leaderboard for (nearly) every stat** — 151-board engine, top-100 precomputed by analyser.
- [x] ✅ **Dynamic thresholds from precomputed distributions** (not hardcoded 50h).
- [x] ✅ **Filter by class**; friend-scoped boards.
- [x] ✅ **Usage-page-style UX: pick all/single class, then stat-type pills** (not a dropdown).
- [x] ✅ **Percentile / top-X% column** — `routes/leaderboards.tsx` renders a Percentile column.
- [ ] 🟡 **Strange leaderboards** — overall "Hale's Own" board + strange-kills / top-single-counter boards shipped; **per-item strange boards deferred** (fit `item.$defindex` better); "most unique weapons to Hale's Own" partial.

---

## 5. Item pages

- [x] ✅ **Item stats/info page** — `/item/$defindex`.
- [x] ✅ **Most-commonly-paired weapons, filterable by experience** — `fetchItemPairs` (CH ARRAY JOIN on `weapon_gids`).
- [x] ✅ **Ap-Sap kept as a variant** (correct per user).
- [x] ✅ **Strange distribution on the item page** — `fetchStrangeDist` + `StrangeDistribution` component (materialized `equipped_items.strange_kills`, botness<0.5, percentiles + strange-tier breakdown). Shipped Wave 4.

---

## 6. Combos / Performance pages

- [x] ✅ 2/3/N-weapon combos per class + experience delta.
- [x] ✅ Performance page ranks weapons AND combos by pts-hr / kills-hr / dmg-min.
- [x] ✅ Remove overlapping/near-empty proportion bars.
- [x] ✅ Remove PDAs from both combos AND performance (msg 159).
- [x] ✅ Consistent slot ordering across combos & performance (`bySlot`).
- [x] ✅ Name-search box on the combos + performance tables (client-side `filter` input, both routes).
- [x] ✅ Slot picker on the performance page (`SLOTS` segmented control).
- [x] ✅ Outlier / farming-server controls — median (`quantileExact(0.5)`) + per-metric hard caps in `server/performance.ts`.
- [x] ✅ 4000h+ warning + default compare 100h→2000h (commit `0d7daee`).
- [ ] 🚫 **"Combine reskins" toggle default-ON for combos/performance** — user explicitly cancelled ("i dont need to do the combos reskin unmerge", msg 128). Needs a `weapon_defindex` array on the CH loadout; do NOT build.

---

## 7. Servers / ecosystem / matches

- [x] ✅ `/servers` + `/matches` surface scanner + sampler data (was zero UI).
- [x] ✅ Much of the teamwork.tf-parity set: players-over-time by gamemode, gamemode donut/pie, rush hour, region/map tables, seat-fill %, community occupancy (populated vs empty), 7d/14d trends.
- [x] ✅ Gametype-flag server stats: alltalk / no-respawn-time / **disabled-crits (nocrits)** / highlander / maxplayers (parsed from the `sv_tags` string; migration 0008).
- [ ] 🟡 **Match ALL teamwork.tf stats and more** — **missing:** competitive-provider stats, official-vs-unofficial map split. Per-server empty/non-empty occupancy is only coarse for community servers.
- [ ] 🟡 **Resolve real continents (not "World/SDR")** — **verified impossible for Valve servers** (A2S probe: SDR-hidden, region uniformly 255, fake 169.254 IPs). Done for community servers (real region codes 0-7 geolocated); Valve continents cannot be recovered.
- [ ] 🟡 **Per-server empty/non-empty occupancy + max_players** — community empties tracked coarsely (`server_empty_snapshots`, region only); **per-Valve-server rows NOT stored** (data is aggregated per map/region/official).
- [ ] 🟡 **Consolidate ecosystem/health/matches/servers** — `/ecosystem` overview created, but all four routes still exist separately; consolidation only partial.

---

## 8. Sampling / delta architecture (the "big scientific build")

- [x] ✅ **Windowed match sampler** — re-query same Valve servers to get ACTUAL pts/hr separate from Valve stats (`apps/crawler/src/sampler.ts`; farming servers can't pollute since only `gametype\valve` sampled).
- [x] ✅ **Matches table** tracking which player-names scored what (`match_segments` / `match_participants` → CH `match_obs`).
- [x] ✅ **Delta foundation** — append-only `player_stat_snapshots`, recrawl scheduler, delta-aware crawl (skips `GetPlayerItems` when class-time unchanged).
- [x] ✅ **Reverse profile matching** (sightings): match-segment name → profile, corroborated by stat-delta intervals + name-uniqueness.
- [x] ✅ **FORWARD attribution (≥90% confidence): segment participant name → steamid, persisted** — `apps/crawler/src/attributor.ts` (15-min loop, mirrors `resolveParticipant` scoring in SQL) writes ≥0.9 rows to `segment_attributions`. Shipped Wave 4. *(Linking these into the `/matches` UI is a follow-up.)*
- [x] ✅ **Full stat-window builder (`stat_windows` table: reset / upload-lag / pure-class / pure-map flags)** — `stat_windows` table + builder shipped Wave 4 (producing windows in prod). Sessions UI consuming it is 🔧 this wave (§2).
- [ ] ❌ **NNLS map-rate regression** — not built.
- [x] ✅ **Map×class playtime attribution ("what classes people play on koth_lakeside")** — `map_class_playtime` table populated by the attributor; basic map×class section on `/matches`. Shipped Wave 4. Richer per-map UI is 🔧 this wave.
- [ ] ❌ **Attribute a player's Valve-stat growth to the opponents they played against** — proposed msg 91; not built.
- [x] ✅ **Match/map duration stat via scanner map-tenure** (median match length by map/gamemode) — shipped Wave 4 (`matchDurations.ts`; segment span = real match length via `reason_closed`).
- [x] ✅ **Rethink sampler window architecture (msg 187)** — sampler rebuilt (`sampler.ts`): continuous same-server tracking, segments live the real match duration with ~4-min observations instead of a bursty 12-min cycle. Shipped Wave 4.
- [x] ✅ **Close segments by points-reset, not map-change (msg 190)** — `sampler.ts` `isReset()` closes segments on a majority score-drop (`score_reset`) as well as map-change, so back-to-back matches on the same map are caught. Shipped Wave 4.

---

## 9. Bot / outlier detection

- [x] ✅ **Botness float per player** from signals (stock fire-axe on pyro, stock fists on heavy, impossible stats, etc.) — `recomputeBotness()` in `analyser.ts`, documented in `docs/botness-signals.md`.
- [x] ✅ **Use botness to adjust usage AND combo calculations** (the "pretty huge deal", msg 180) — Wave-3 Phase A: exclusion applied at the PG→CH sync boundary + PG usage/boards; `coalesce(botness,0) < 0.5`.
- [x] ✅ **More aggressive exclusion** (full across-the-board stock + low playtime given hours) — broadened stock signal to all slots + added idle-engagement signal (~2.2% → ~8.5% flagged).
- [x] ✅ **Statistical significance shown in compare-experience places** — `lib/stats.ts` + wired into usage/combos/performance.
- [ ] 🟡 **Re-examine statistical significance (msg 177, 2026-08-20 08:49)** — user suspected the n values don't respect the active filters. **No clear evidence this was re-audited/fixed after being raised.**

---

## 10. Infra / deploy / platform

- [x] ✅ Type-safe, dockerized, tsgo, bun, oxlint, oxfmt, TanStack Query.
- [x] ✅ *(deviation)* Query-param state — used TanStack Router **native** typed search params + `stripSearchParams` instead of **nuqs** (its TSR-Start adapter is unsupported). User asked for nuqs; outcome is equivalent.
- [x] ✅ Single Postgres on the VPS (not a two-Postgres / Neon split).
- [x] ✅ TanStack Start on Vercel (Next.js dropped).
- [x] ✅ Hidden-API research (QueryByFakeIP scoreboards, appreviews seeds, confirmed dead ends).
- [x] ✅ Cloudflare DNS + DB behind TLS (grey-cloud, self-signed cert).
- [x] ✅ R2 nightly pg_dump backups.
- [x] ✅ Steam OpenID login (cookie `tf_session`, HMAC).
- [x] ✅ Enable Vercel Analytics (commit `c277e1e`).
- [x] ✅ Global ⌘K search + per-table filter box.
- [x] ✅ Logo cropped (Pillow) without the "style.tf" text.
- [ ] 🟡 **Move to AWS with Aurora + AWS ClickHouse, multi-AZ / read-replica, low latency in EU AND US** (msg 100) — migrated to **AWS us-east-1: RDS Postgres (single-AZ) + one EC2 running ClickHouse**. NOT Aurora, NOT multi-AZ, NO read replicas, single region (Vercel pinned iad1). The "fast in both Europe and US" goal is unmet.
- [x] 🚫 (kept, not cancelled) London Lightsail intentionally retained (user's other projects) — do not retire.
- [ ] ⚠️ Deploy is script-only (`scripts/deploy.sh`), no CI — this is the user's explicit choice, not a gap.

---

## 11. MMR / homepage / login flow

- [x] ✅ User sign-in + homepage shows the logged-in player ("me").
- [ ] ❌ **MMR** (msg 79: "user sign in → homepage → MMR") — **not built; effectively blocked** (TF2 GC exposes no player-lookup/MMR API; the only path is an opt-in browser-extension import, which was researched but not implemented).

---

## 12. Copy / branding / mobile

- [x] ✅ Remove all style.tf references from webapp copy.
- [x] ✅ Methodology page → `METHODOLOGY.md` at repo root + GitHub icon in navbar (route deleted).
- [x] ✅ De-AI-ify copy, remove em-dashes, trim unnecessary copy.
- [x] ✅ Make everything mobile-friendly (`docs/mobile-responsiveness.md`, commit `e537ed4`).
- [x] ✅ Use more page width app-wide (`max-w-7xl`).
- [x] ✅ All charts hoverable/nicer — shared shadcn/Recharts wrapper (`components/ui/chart.tsx`). *(deviation: user said "TanStack charts"; there is no such lib — Recharts used to match the mauve/amber dark theme.)*

---

## Possibly dropped / needs attention (prioritized)

These are the items most worth doing next — either the user's latest un-actioned asks, explicit bug reports with no fix evidence, or high-value ideas that were planned but never built.

**Shipped since this list was first written (Wave 4 + second wave in progress):** sampler rethink + points-reset boundary (✅), forward attribution (✅), `stat_windows` builder (✅), map×class attribution (✅), match/map duration (✅), item-page strange distribution (✅). Player-page prod error, sessions UI, per-map best-weapons/boards, and winrates are 🔧 in progress this wave.

Still open / next:

1. **🔧 Player-page prod error (msg 192).** Being hunted + fixed this wave (reproduce live edge cases → guard).
2. **🔧 Sessions on the player page** — consuming the now-shipped `stat_windows`.
3. **🔧 Map×class per-map UI + per-map best-weapons/leaderboards** — the backend (`map_class_playtime`, attribution) shipped; the richer UI is being built.
4. **🔧 Winrates** — GCStat win/loss-counter measurement pass, being instrumented.
5. **🔧 Query-performance pass** — profiling every user-facing PG/CH query against prod and applying + reporting fixes (indexes, materialized aggregates, collapsed round-trips).
6. **🟡 Statistical-significance re-audit (msg 177).** User flagged that the two n-values may not respect the active filters; no evidence it was re-checked. Still open.
7. **➡️ Link attributed players into the `/matches` UI.** Forward attribution now persists ≥0.9 `segment_attributions`, but `/matches` doesn't yet render the resolved steamids.
8. **❌ NNLS map-rate regression** and **❌ opponent-growth attribution (msg 91)** — still not built.
9. **🟡 Per-item strange leaderboards** (deferred) — small self-contained win.
10. **🟡 Remaining teamwork.tf-parity gaps:** competitive-provider stats, official-vs-unofficial map split, and per-Valve-server occupancy (needs per-server rows). Plus **distribution graphs on leaderboards** and **cosmetic/taunt combo trackers** from the original brainstorm.

**Confirmed cancelled (do not build):** combos/performance reskin-unmerge toggle (msg 128); logs.tf / community-server sourcing (demoted to stretch, official Valve only); client-side quantized-stats interpolation (superseded by ClickHouse); retiring London Lightsail (explicitly kept).
