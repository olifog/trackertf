# Botness / outlier signals

A per-player **botness float in `[0, 1]`** used to exclude junk accounts (idle
bots, stat-hackers, corrupted profiles, zero-effort loadouts) from usage stats
and leaderboards. Higher = less trustworthy.

This is a design spike — empirically grounded in production ClickHouse
(`trackertf` db) as of 2026-08. No code was changed; this documents the signals,
the thresholds measured from real data, the combining formula, and how the
analyser/site should apply the cutoff.

## Why it matters (the one number)

- Corpus with class stats: **22,713 players, 23,625,117 lifetime hours.**
- The stat-based flags below (impossible rates + playtime ceiling + idle + hack
  markers) fire on **481 players — 2.1% of the corpus** — but those 481 hold
  **6,994,617 hours = 29.6% of ALL corpus playtime.**

Nearly a third of the total playtime weight in the corpus belongs to ~2% of
accounts that are almost certainly not real, engaged humans. Anything weighted
by playtime, or any "4000h+" experience bucket, or any playtime/strange
leaderboard, is dominated by them unless we exclude them.

## Data facts this relies on

- ClickHouse `trackertf` tables: `equipped` (2,001,474 rows / 31,326 players),
  `player_class` (196,496 rows / 22,713 players). ~8.6k players have loadouts
  but no class stats (private/empty stats).
- **`equipped` slot encoding is raw TF2 slots**: `slot 0`=primary, `1`=secondary,
  `2`=melee, `3/4/5/6`=sapper/watch/PDA/etc. (Not the semantic remap used in the
  Postgres/web layer.) Confirmed: scout melee top def 0 (Bat), soldier 6 (Shovel),
  heavy 5 (Fists), etc.
- **Stock is fully backfilled**: every player has a row for every (class, slot),
  filled with the stock defindex when they equipped nothing. Proof: spy sapper
  (class 8, slot 3, def 27) appears for exactly 31,326 players = the entire
  corpus; melee slot has 281,934 rows = 31,326 × 9 classes. **Consequence: "on
  stock melee" is meaningless alone — it's contaminated by "never played that
  class." Loadout signals MUST be gated on real per-class playtime.**

### Stock melee defindex per class (`class_num` → melee `defindex`)

| class | class_num | stock melee | defindex |
|---|---|---|---|
| Scout | 1 | Bat | 0 |
| Sniper | 2 | Kukri | 3 |
| Soldier | 3 | Shovel | 6 |
| Demo | 4 | Bottle | 1 |
| Medic | 5 | Bonesaw | 8 |
| Heavy | 6 | Fists | 5 |
| Pyro | 7 | Fire Axe | 2 |
| Spy | 8 | Knife | 4 |
| Engineer | 9 | Wrench | 7 |

"Real stock" = exactly these defindexes. Reskins (different defindex, same
`gid`) are NOT stock — equipping a reskin is still a deliberate choice, so
reskins must not count toward the stock tell. Use raw `defindex`, never `gid`.

## Signals (measured)

### 1. Impossible / physically-implausible rate stats (strongest)

Per-class rates for `playtime_seconds >= 3600` (kills/hour = `kph`,
damage/min = `dpm`, points/min = `ppm`). Real human play sits at/below p99.9;
above that the tail is non-physical.

Kills/hour percentiles by class:

| class_num | p50 | p95 | p99 | p99.9 | max |
|---|---|---|---|---|---|
| 1 Scout | 43 | 111 | 191 | 945 | **2,942,203** |
| 3 Soldier | 59 | 124 | 220 | 809 | 246,192 |
| 6 Heavy | 62 | 143 | 379 | 2,408 | 10,610 |
| 7 Pyro | 54 | 115 | 289 | 1,317 | 56,392 |

Damage/min: p99 711, p99.9 2,005, **max 496,639**. Points/min: p99 5.5,
p99.9 29, **max 280,162**. No human sustains 2.9M kills/hour.

**Thresholds** (hard-impossible, class-independent, conservative — above the
worst class p99.9):
- `kph > 1500` OR `dpm > 3000` OR `ppm > 30` → hard flag.
- Softer suspicion band: rate between class p99 and the hard cap ramps 0→1.

Coverage: `kph>600 or dpm>3000 or ppm>30` → 395 players (1.7%) holding
2,807,956 hours.

### 2. Hack-marker saturation values (cheap, exact, unambiguous)

Stat-hacker tools set counters to a fixed base. Two signatures in the data:
- **INT32 saturation** — value pinned at `2,147,483,647` (2³¹−1). Example:
  scout with 596,523 h and `kills = points = 2147483647`.
- **~1e9 offset** — hacked stats show `1,000,000,000 + real`. Examples:
  scout `kills = 1,000,005,636` in 340 h; engineer `kills 1,000,002,163`,
  `points 1,000,004,275`.

**Threshold:** any of kills/points/damage/kill_assists `>= 1_000_000_000` OR
`= 2_147_483_647` → hard flag. Only 8 players, but zero false positives and it
catches the most egregious corruption.

### 3. Impossible playtime ceiling

Total lifetime hours: p50 370, p95 2,949, p99 5,428, p99.9 33,970,
**max 1,429,858 h** (163 years of continuous play). Above ~15k h is deeply
suspect; above ~30k h is impossible. Single-class playtime is even more
damning — 40 class-rows exceed 15k h on ONE class (sniper idle averages
41,875 h/class, spy 32,621 h).

**Thresholds:**
- `total_hours > 30000` OR `any_single_class_hours > 30000` → hard flag.
- `total_hours` in `[15000, 30000]` → ramp 0.5→1.0.

Coverage: 39 players > 15k total h, 21 > 30k. Single-class > 15k: 28 players.

### 4. Idle shape (AFK / idle-server bots)

High playtime with near-zero output. **Must be points-based, not kills-based**,
because medics legitimately have `kph < 2` (they heal, not kill) — a kills-only
idle filter false-flags 77 real pocket medics.

**Threshold:** `playtime_seconds >= 360000` (100 h) AND
`points_per_hour < 2` → strong idle flag; ramp from `points_per_hour < 5`.

Coverage (points-based): 89 players holding 4,593,483 hours.

### 5. Zero-effort loadout on engaged classes (loadout tell)

The class-specific tell the user described: real stock Fire Axe on a pyro with
hundreds of hours, stock Fists on a heavy, stock Shovel on a soldier, etc. —
engaged players near-universally swap these.

Gated on real playtime to avoid the backfill contamination. Among players whose
played classes (`>= 10 h`) are ALL on stock melee, the stock-melee fraction
falls monotonically with total hours — i.e. engagement predicts customization:

| total hours | players | avg played classes | frac stock melee | all-stock % |
|---|---|---|---|---|
| <50 h | 614 | 1.2 | 0.216 | 20.5% |
| 50–200 | 3,131 | 4.4 | 0.167 | 6.1% |
| 200–500 | 4,066 | 7.9 | 0.140 | 2.2% |
| 500–1k | 3,786 | 8.7 | 0.119 | 1.3% |
| 1k–3k | 4,094 | 8.9 | 0.101 | 1.1% |
| 3k+ | 888 | 8.9 | 0.090 | 0.8% |

So "all-stock melee" is normal for a <50 h newbie (20%) but a strong tell for a
500 h+ multi-class player (~1%). **Engaged all-stock population** (≥300 h total,
≥3 played classes ≥10 h each, every one on stock melee): **144 players.** This
is a soft signal — it catches disengaged/farm accounts the stat flags miss, but
must never be a hard flag (some real players genuinely melee-stock).

**Score:** `stock_frac` = (played classes ≥10 h on stock melee) / (played
classes ≥10 h), only counted when `total_hours >= 300` (else 0, to exempt new
players). Contributes with a modest weight.

## Combining into one float

```
botness(player):
  # ---- hard flags: any → 1.0, always excluded ----
  if any class kills/points/damage/assists >= 1e9 or == 2147483647:      return 1.0
  if total_hours > 30000 or max_single_class_hours > 30000:              return 1.0
  if any class (pt>=1h) has kph>1500 or dpm>3000 or ppm>30:              return 1.0

  # ---- graded sub-scores in [0,1] ----
  s_rate   = ramp(max_class_rate_percentile, from=p99, to=hardcap)   # signal 1
  s_time   = ramp(total_hours, 15000 -> 30000)                       # signal 3
  s_idle   = (max_class_hours>=100) ? ramp(min_points_per_hour, 5 -> 0) : 0   # signal 4
  s_stock  = (total_hours>=300) ? stock_frac_on_played_classes : 0    # signal 5

  # weighted, saturating combine (noisy-OR keeps any strong signal decisive)
  botness = 1 - (1 - w_rate*s_rate)(1 - w_time*s_time)(1 - w_idle*s_idle)(1 - w_stock*s_stock)
```

Suggested weights: `w_rate 0.9, w_time 0.8, w_idle 0.9, w_stock 0.4`. Rate/idle
dominate; loadout is a nudge, never decisive on its own.

**Cutoff:** exclude from usage aggregates and leaderboards when
`botness >= 0.5`. Hard-flagged (1.0) always excluded. The 0.5 cutoff is tunable;
start conservative (only stat-corrupt accounts) and tighten once validated.

### False-positive guards (built in above)

- Medic idle uses **points/hr**, not kills/hr.
- Loadout tell only above **300 h** (new players equip stock — expected).
- Single strong loadout stock ≠ exclusion; needs another signal to cross 0.5.
- Rate flags require `playtime >= 1 h` so tiny-denominator noise can't spike.

## Integration proposal

The analyser (Postgres-only, delete+insert every 15 min, already reads
`player_class_stats` + `equipped_items`) is the natural owner:

1. **Compute** botness per player in a new analyser pass, reading
   `player_class_stats` (rates, playtime, hack markers) + `equipped_items`
   melee rows (slot=2 in the Postgres semantic layer — verify the semantic-slot
   value there; CH uses raw slot 2). Stock defindex map hardcoded per the table
   above.
2. **Persist** as a nullable `players.botness real` column (add via migration),
   or a dedicated `player_botness` table keyed by steamid with the component
   sub-scores for debuggability. Recomputed each analyser run.
3. **Apply in usage**: the usage recompute already filters a population; add
   `AND (botness IS NULL OR botness < 0.5)` to the player set feeding
   `usage_stats` and `usage_stats_history`. `botness IS NULL` (uncrawled stats)
   stays included — absence of evidence is not a flag.
4. **Apply in leaderboards** (`boards.ts` POP filter, currently
   `personaname is not null and vac_banned = false`): add `and coalesce(
   botness,0) < 0.5`. This also fixes playtime/strange boards being topped by
   idle bots.
5. **Strange leaderboards (ClickHouse path)**: CH has no botness column. Either
   (a) push the excluded steamid set (only ~500 ids — trivially small) into the
   CH query as `steamid NOT IN (...)`, or (b) have the syncer carry a `botness`
   column onto the CH `player_class`/`equipped` tables during its 15-min rebuild.
   (a) is simplest given the tiny flagged set.

### Validation before rollout

- Dump the top-200 by botness with component breakdown; eyeball for real players
  caught (expect ~none above 0.5 given the guards).
- Confirm usage headline shares barely move for popular items but full-stock
  combos / high-hour buckets drop their inflated deltas (the original motivation).
- Track flagged count over time; a sudden jump means a threshold or a new hack
  signature needs attention.

## Open items / future signals

- **Playtime consistency**: `players.tf2Minutes` (Steam total) vs
  `sum(player_class.playtime_seconds)` — large divergence is another corruption
  tell. Needs a Postgres join (players table not in CH); not yet quantified.
- **VAC / game bans** (`players.vac_banned`, `game_bans`) — already used as a
  leaderboard filter; could feed a small botness term rather than a hard gate.
- **F2P / no-inventory** accounts — correlated with bot farms; not yet measured.
- Class-specific rate ceilings (per-class p99.9) instead of one global cap would
  tighten signal 1 (heavy's real p99.9 is 2,408 kph vs scout's 945).
