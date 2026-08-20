# Steam API budget: intelligent, dynamic scheduling across services

**Status:** design proposal (read-only investigation of current code + concrete plan)
**Budget:** ONE Steam Web API key, hard ceiling ~100,000 calls/day ≈ **1.157 calls/s** sustained.
**Date:** 2026-08

---

## 0. TL;DR / the single most important risk

**The budget is NOT coordinated. It is enforced per-process, and every process
independently thinks it owns ~1 call/s.**

Each of the three Steam-consuming containers builds its own `SteamClient` with
`ratePerSecond: 1`, and `SteamClient` builds a **private in-memory
`TokenBucket`** (`packages/steam/src/index.ts:56`). Separate containers =
separate processes = separate heaps = **separate buckets that never talk to
each other**. There is no shared limiter, no global counter, no broker.

- Crawler bucket: 1/s → up to **86,400/day**
- Sampler bucket: throttled to `SAMPLER_CALLS_PER_DAY` (default **15,000/day**)
- Scanner bucket: 1/s but self-paced by a 5-min loop → **~1,152/day**
- Web `lookupPlayer` vanity resolution: **raw `fetch`, no bucket at all** —
  scales with user traffic, entirely unbudgeted (`apps/web/src/server/player.ts:366`).

**Sum of the three batch services at full tilt ≈ 102,552/day — already over the
100k ceiling before a single user vanity lookup.** Nothing in the system will
stop them collectively blowing the budget; the only reason it hasn't yet is
that the crawler rarely sustains a true 1/s (DB transaction latency between
calls). The ceiling is above budget and unenforced. That is the bug to fix.

**Top recommendation:** introduce a single **Postgres-backed token broker** (a
`steam_budget` lease table + a tiny shared `BudgetedSteamClient` wrapper) that
every service — including the web app — must acquire from before each call.
Allocate the 100k/day across weighted **classes** (crawler / recrawl /
on-demand / sampler / scanner) with guaranteed floors and elastic ceilings, and
make the sampler/scanner intensity track live CCU from `population_snapshots`.
Details below.

---

## 1. How throttling works today

### 1.1 `TokenBucket` (`packages/steam/src/ratelimit.ts`)
Classic leaky/token bucket, in-memory, single process:
- `capacity = burst ?? ceil(ratePerSecond * 5)` (so at 1/s, capacity 5).
- Refills continuously at `ratePerSecond/1000` tokens per ms.
- `take()` spins: refill → if ≥1 token, consume and return; else `setTimeout`
  for the time to accrue the deficit, then retry. So it **blocks the caller**
  until a token is free. It is async-fair-ish (FIFO-ish via the event loop) but
  has **no notion of priority** — every `take()` is equal.

### 1.2 `SteamClient` (`packages/steam/src/index.ts`)
- Constructs one `TokenBucket({ ratePerSecond: opts.ratePerSecond ?? 1 })`.
- **Every** API round-trip calls `await this.#bucket.take()` first
  (`#getInner`, line 80). Granularity is therefore **1 token = 1 HTTP request**,
  including each retry of `getPlayerItems` (up to 3 on 503) and each batched
  `GetPlayerSummaries`/`GetPlayerBans`.
- `onResult(endpoint, outcome)` fires after every round-trip → the crawler's
  `record()` buffers hourly counts into the `api_metrics` table
  (`apps/crawler/src/metrics.ts`). **We already have per-endpoint,
  per-outcome, per-hour telemetry** — the broker can reuse this for feedback.

**Key limitation:** the bucket is per-`SteamClient`-instance, and there is one
instance per process. It cannot see or coordinate with any other process.

---

## 2. The consumers (every `new SteamClient` + the raw path)

| Service | File | Process (docker-compose) | Bucket rate | Notes |
|---|---|---|---|---|
| Player crawler + recrawl scheduler | `apps/crawler/src/index.ts:11` | `crawler` (default CMD) | 1/s | 6 workers **share one bucket** (`CRAWLER_CONCURRENCY=6`). Scheduler loop runs in the **same** process → recrawls compete for the same bucket. |
| Server scanner | `apps/crawler/src/scanner.ts:24` | `scanner` | 1/s | Self-paced 5-min loop; bucket only smooths intra-scan bursts. |
| Match sampler | `apps/crawler/src/sampler.ts:32` | `sampler` | 1/s | Self-paced by `SAMPLER_CALLS_PER_DAY`; bucket only smooths intra-cycle bursts. |
| Web vanity lookup | `apps/web/src/server/player.ts:366` | Vercel (serverless) | **none** | Raw `fetch` to `ResolveVanityURL`. No bucket, no budget accounting. |

The web app's **other** budget interactions are indirect and DO route through
the crawler's bucket, which is good:
- `fetchPlayer` on an unknown steamid inserts `crawl_frontier (source='seed',
  priority 5)` (`player.ts:63`).
- `requestRecrawl` inserts `crawl_frontier (source='recrawl', priority 3)`
  (`player.ts:155`).

These become frontier rows the crawler dequeues, so they consume the crawler's
86,400/day — no extra bucket. **Only the vanity `ResolveVanityURL` call is a
truly uncoordinated, unthrottled path.**

Deployment topology (from `docker-compose.yml`): `crawler`, `scanner`,
`sampler` are three separate containers (all built from the same image, three
different CMDs). `analyser` and `syncer` make **no** Steam calls. Postgres is
RDS; ClickHouse is the analytics mirror. So there are **exactly 3 in-process
buckets on the EC2 box + 1 unbounded serverless path on Vercel.**

---

## 3. Call-rate math (calls/day per service) — do we fit under 100k?

### Scanner (`scanner.ts`)
- `INTERVAL_MS = 5 min` → 288 scans/day.
- Per scan: **3** `getServerList` filters (`SCAN_FILTERS`) + **1**
  `getCurrentPlayers` = **4 calls**.
- **288 × 4 = ~1,152 calls/day.**
  *(NB: the file header comment says "~576 calls/day (2 per scan)" — that is
  stale; the code now has 3 filters + CCU = 4/scan. Cheap either way.)*

### Sampler (`sampler.ts`)
- `CALLS_PER_CYCLE = ROUNDS*(1+MAX_SERVERS) = 5*(1+40) = 205`.
- Cycle length derived from `SAMPLER_CALLS_PER_DAY` (default 15,000):
  `cycleMs = ceil(86.4M * 205 / 15000) ≈ 19.7 min`, ~73 cycles/day.
- **≤ 15,000 calls/day** (hard-capped by env; the floor is the round pacing,
  `ROUNDS*ROUND_INTERVAL_MS = 15 min`, which caps it at ~19,700/day if the env
  were raised absurdly).

### Player crawler (`index.ts`)
- Per player: `getUserStats` + `getTf2Playtime` + `getPlayerItems`
  = **3 calls** (items may retry up to 3× on transient 503, so effective ~3.1).
- BFS expansion: `getFriendList` only when `minutes2wk>0 && minutes>100,000`
  (high-hours active) — a minority, call it +0.1–0.3/player amortized.
- Enrichment: `getPlayerSummaries` + `getPlayerBans` batched per 100 →
  **+0.02/player**.
- **≈ 3.2–3.4 calls per player.**
- But the crawler is **bucket-bound, not player-bound**: 6 workers all
  `await bucket.take()` on a 1/s bucket, so the process tops out at **1/s =
  86,400 calls/day ≈ 25,000–27,000 players/day** when the frontier is full
  (and with a 253k friend-BFS backlog, it is always full).

### Web vanity (`lookupPlayer`)
- 1 `ResolveVanityURL` per non-numeric search that isn't a `/profiles/` URL.
- **Unbounded**; scales with traffic. Today probably small, but it is the one
  path that can spike without limit and is not counted anywhere.

### Totals

| Service | Realistic sustained | Ceiling |
|---|---|---|
| Crawler (incl. recrawls, seeds, on-demand) | ~86,400 (frontier is full) | 86,400 |
| Sampler | 15,000 | ~19,700 |
| Scanner | 1,152 | 1,152 |
| Web vanity | ~unknown small | unbounded |
| **Total** | **~102,552 + web** | **107,252 + web** |

**Verdict: we do NOT fit with headroom.** The three batch services already sum
to ~102.5k/day at their natural operating points, slightly over the 100k
ceiling, with the web vanity path stacked on top and nobody enforcing the
global cap. This is only "working" because the crawler's real throughput is
throttled by DB latency below its 1/s ceiling. That is luck, not design.

---

## 4. Frontier / queue mechanics (`crawl_frontier`)

Schema (`packages/db/src/schema.ts:237`):
`steamid PK, source (enum), priority smallint default 0, enqueued_at,
attempts smallint, locked_until`, index on `(priority, enqueued_at)`.

Dequeue (`index.ts:37`): `UPDATE ... SET locked_until=now()+10min, attempts+1
WHERE steamid = (SELECT steamid ... WHERE (locked_until IS NULL OR <now) AND
attempts<3 ORDER BY priority DESC, enqueued_at ASC LIMIT 1 FOR UPDATE SKIP
LOCKED)`. So: strict **priority DESC, then FIFO**, with a 10-min visibility
lock and a 3-attempt dead-letter (`sweepDeadLetters` turns exhausted rows into
`error` players).

**Priorities in use:**

| Priority | Source | Set by |
|---|---|---|
| 10 | `seed` | `seed.ts` CLI |
| 5 | `seed` | web `fetchPlayer` unknown steamid (`player.ts:63`) |
| 3 | `recrawl` | web `requestRecrawl` (`player.ts:155`) |
| 1 | `recrawl` | scheduler `scheduleRecrawls` (`index.ts:271`) |
| 0 | `friend_bfs`, `review_sample`, `random_sample` | BFS expansion / seeders (default) |

**Current starvation behavior (real problem):** the dequeue is strict priority.
`scheduleRecrawls` inserts up to **2,000 recrawls every 15 min** (up to
192k/day of *demand*) for the active "hyper" cohort (every 8h) + long-tail
(every 14d). Those sit at priority 1, strictly **above** the friend-BFS backlog
(priority 0). Since the crawler can only clear ~25k/day, **recrawl demand
outgrows crawl capacity as the corpus grows and will progressively starve
friend-BFS discovery to zero.** Conversely, a flood of web `requestRecrawl`
(priority 3) or unknown-player seeds (priority 5) jumps ahead of everything —
good for latency, but with no rate limit an abusive burst could monopolize the
crawler (partially mitigated by the INSERT-only + `on conflict do nothing`
web grant, which caps it at one pending row per steamid).

**There is no cross-class fairness and no floor for discovery.** Priority is a
total order, so any higher class fully preempts every lower one.

---

## 5. Design proposal

### 5.1 Goals
1. **Never exceed ~100k/day globally**, across all processes, enforced — not hoped.
2. **Round-robin / weighted-share** the budget across the five work classes:
   `scanner`, `crawler` (discovery), `recrawl` (delta), `sampler`, `on-demand`
   (user recrawl + vanity/profile).
3. **Dynamic**: absorb bursts (user recrawl storms, sampler wanting more at
   peak) by borrowing idle budget, without ever letting one class starve
   another below its floor.
4. **Starvation protection both ways**: on-demand latency stays low; batch
   discovery always makes steady progress; sampler/scanner keep their cadence.
5. **Follow CCU**: sample/scan harder when the playerbase is online.

### 5.2 The coordination mechanism — options weighed

Because services are **separate containers**, an in-memory shared bucket is
impossible. Three viable shared mechanisms:

**Option A — Single "steam-gateway" process.**
One long-lived service owns the *only* `SteamClient` (one bucket at 1.15/s).
Every other service calls it over HTTP/gRPC with a `class` label; the gateway
runs the priority scheduler in memory.
- *Pros:* the bucket stays exactly where it is today (in-memory, simple, fair);
  one place to reason about; trivially exact global rate; can hold a real
  in-memory priority queue.
- *Cons:* new network hop + new single point of failure on the request path;
  Vercel (web) must call it cross-network (adds latency/egress, needs auth);
  every existing `steam.getX()` call site must be rewritten to RPC; if the
  gateway restarts mid-flight, in-flight leases vanish.

**Option B — Postgres-backed token/lease broker (RECOMMENDED).**
We already run RDS Postgres and every service already holds a pool. Add a
`steam_budget` table holding per-class token balances refilled by time, and a
`BudgetedSteamClient` wrapper whose `take()` does an atomic
`UPDATE ... RETURNING` to acquire a token for its class (with borrow rules).
- *Pros:* no new infra, no new SPOF beyond the DB we already depend on;
  durable (survives restarts); the web app already has a DB role (extend it);
  naturally global and exact; the accounting doubles as observability; per-class
  logic lives in SQL, easy to retune with a config row.
- *Cons:* one extra tiny write per API call (~1.15/s of trivial UPDATEs — RDS
  will not notice); need a clean acquire query to avoid contention (solved with
  a per-class row + `SELECT ... FOR UPDATE SKIP LOCKED` or atomic decrement).

**Option C — Distributed token bucket in Redis/Valkey.**
Lua `INCR`/refill script implementing a bucket per class.
- *Pros:* purpose-built, sub-ms, atomic Lua, common pattern.
- *Cons:* **new infra** to run, secure, and back up on the EC2 box (and reach
  from Vercel) purely for ~1 op/s. Not worth it at 1.15/s. Revisit only if we
  ever get multiple API keys and rates jump.

**Recommendation: Option B (Postgres broker).** At 1.15 calls/s the
coordination rate is so low that Postgres is more than adequate, it adds zero
new moving parts, it is durable, and it already sits at the center of the
system. Keep the existing `TokenBucket` as a **local secondary smoother** (so a
service still can't machine-gun the API between broker grants), but make the
**global budget authority** the DB.

### 5.3 Schema to add

```sql
-- One row per work class. Refilled lazily on acquire (like TokenBucket but shared).
create table steam_budget (
  class          text primary key,   -- 'scanner'|'crawler'|'recrawl'|'sampler'|'ondemand'
  tokens         double precision not null,      -- current balance
  capacity       double precision not null,      -- max burst (== a few seconds of rate)
  refill_per_sec double precision not null,      -- this class's *floor* share, tokens/s
  ceil_per_sec   double precision not null,      -- max it may draw when borrowing (elastic)
  updated_at     timestamptz not null default now()
);

-- Shared "spare" pool that idle classes donate into and busy classes borrow from,
-- so the *global* rate never exceeds the key budget while classes flex.
create table steam_budget_global (
  id             int primary key default 1,
  tokens         double precision not null,
  capacity       double precision not null,      -- e.g. 5s * 1.157 ≈ 6
  refill_per_sec double precision not null,       -- 1.157 (the whole key)
  updated_at     timestamptz not null default now()
);
```

Reuse the existing `api_metrics` table (already populated via `onResult` →
`record`) as the **feedback signal**: actual calls/hour/endpoint/outcome. The
scheduler reads it to detect a class under-spending (donate) or a demand spike
(borrow). `population_snapshots.current_players` is the CCU signal for
time-of-day scaling.

### 5.4 Acquire algorithm (the `BudgetedSteamClient.take(class)`)

Two-level bucket: a **global** bucket enforces the hard 1.157/s ceiling; a
**per-class** bucket enforces each class's guaranteed floor + elastic ceiling.
A call needs a token from **both**.

```
take(cls):
  loop:
    # single atomic statement, refill-then-decrement, per class + global
    row := UPDATE steam_budget c
           SET tokens = LEAST(c.capacity,
                              c.tokens + extract(epoch, now()-c.updated_at)*c.refill_per_sec) - 1,
               updated_at = now()
           WHERE c.class = :cls
             AND (c.tokens + extract(epoch, now()-c.updated_at)*c.refill_per_sec) >= 1
             AND (c.tokens + ...) <=  -- rate cap: don't exceed ceil_per_sec window
                 c.ceil_per_sec * WINDOW
           RETURNING tokens
    if row is null:            # class floor exhausted → try to borrow from global spare
       g := <same refill-decrement on steam_budget_global>
       if g is null:
          sleep(deficit / global.refill_per_sec); continue   # global saturated: wait
       else:
          return               # borrowed a global token, proceed
    else:
       # also must consume a global token so the *sum* is capped
       g := <decrement global; if null, refund class token and sleep; continue>
       return
```

Practical simplification that avoids double-bookkeeping bugs: make the **global
bucket the only hard limiter of rate**, and use the per-class rows purely as
**fair-share weights + floors** via a *credit* scheme:

- Each class has a `refill_per_sec` = its guaranteed floor.
- On acquire, a class first spends its own floor tokens. If empty, it may spend
  from the **global spare** (tokens the global bucket accrued that no class
  claimed) — but only up to its `ceil_per_sec`. This gives: guaranteed floor +
  bounded elasticity + a global hard cap. Idle classes' unclaimed refill piles
  up in the global spare for busy classes to borrow. This is weighted fair
  queuing with reservations.

The existing per-process `TokenBucket` stays as a **local jitter smoother** set
to each class's `ceil_per_sec`, so a service can't burst past its own ceiling
between broker polls.

### 5.5 Recommended budget split (numbers)

Total = 100,000/day = **1.157/s**. Reserve ~5% (5,000/day) as global headroom
(retries, clock skew, the vanity path) → schedule against **95,000/day**.

| Class | Floor (guaranteed) | Ceiling (may borrow up to) | Rationale |
|---|---|---|---|
| **scanner** | 1,500/day (~0.017/s) | 2,000/day | Fixed 5-min cadence, tiny; near-constant. |
| **sampler** | 12,000/day | 24,000/day | Real-time sampling cadence; wants MORE at peak CCU (§5.7). Floor keeps segments alive off-peak. |
| **on-demand** (user recrawl + vanity/profile) | 8,000/day (~0.09/s) | 30,000/day | Latency-sensitive. Small floor is plenty at low traffic; big ceiling absorbs bursts by borrowing idle crawler budget. |
| **recrawl** (delta scheduler) | 20,000/day | 45,000/day | Session-resolution deltas for the active cohort. |
| **crawler** (friend-BFS discovery) | 25,000/day | 60,000/day | The 253k backlog. Big floor guarantees discovery **never starves to zero** (fixes §4). |
| _global headroom_ | 5,000/day | — | Absorbs vanity spikes + retries. |
| **Sum of floors** | **66,500/day** | | Leaves ~28,500/day of "spare" to be borrowed dynamically. |

Floors sum to 66.5k < 95k, so ~28.5k/day is always available as borrowable
spare — that is the elasticity budget. Ceilings intentionally overlap and
exceed 95k **individually** because they're borrow limits, not reservations;
the global bucket guarantees the *sum actually consumed* ≤ 1.157/s. Store these
in the `steam_budget` rows so they're retunable live (no redeploy).

### 5.6 Priority queue — do we need one? Yes, but a *fair* one.

Keep `crawl_frontier` and its priority column, but change two things:

1. **Split the single frontier drain into per-class weighted draws** instead of
   strict global priority-DESC. The crawler's dequeue should interleave classes
   by their budget weights so friend-BFS (priority 0) can't be starved to zero
   by recrawls (priority 1). Concretely: run a **weighted round-robin** across
   `source`-classes, where each class's turn frequency = its budget share, and
   within a class keep the existing `priority DESC, enqueued_at ASC`.

   ```
   # deficit-weighted round robin over classes present in the frontier
   for each class c: credit[c] += weight[c]      # weight from steam_budget floor+borrow
   pick class = argmax(credit[c] where frontier has an eligible row)
   credit[class] -= 1
   dequeue one row of that class (existing SKIP LOCKED query, scoped to source-set)
   ```

2. **On-demand gets a fast lane.** User `requestRecrawl` (priority 3) and
   unknown-seed (priority 5) already outrank batch work. Keep that, but bound
   it by the `on-demand` budget class so a burst borrows from spare rather than
   preempting the crawler/recrawl floors. The vanity `ResolveVanityURL` path
   should route through the same `on-demand` broker class (see §5.8).

This gives: latency-sensitive on-demand served promptly (fast lane + generous
borrow ceiling), while discovery and recrawl each keep a guaranteed floor and
make steady progress regardless of how much on-demand or recrawl demand piles
up. Neither can drive the other to zero.

### 5.7 Time-of-day / CCU-adaptive intensity

`population_snapshots.current_players` now records live TF2 CCU every scan. Use
it to scale the classes whose *value* tracks population:

- **sampler**: matches only exist when people play. Scale
  `sampler.ceil_per_sec` (and effectively `SAMPLER_CALLS_PER_DAY`) with
  normalized CCU: `factor = clamp(ccu / ccu_p90, 0.3, 1.6)`. Off-peak (nights),
  the sampler drops toward its floor and **donates** its unused budget to the
  global spare — which the crawler/recrawl classes then borrow to burn down the
  BFS backlog while nobody's playing. At peak, sampler borrows back up.
- **scanner**: keep flat (population structure is cheap to track and useful
  even off-peak). Optionally stretch `INTERVAL_MS` to 10 min overnight to shave
  a few hundred calls — low value, low priority.
- **crawler/recrawl**: naturally counter-cyclical — they soak up the sampler's
  off-peak donations. No explicit schedule needed; the borrow mechanism does it.

Implement as a small periodic job (extend the crawler's `schedulerLoop` or a
new tick) that, every ~15 min, reads the latest CCU vs a trailing 7-day p90 and
rewrites the `refill_per_sec`/`ceil_per_sec` of the `sampler` (and optionally
`scanner`) rows. Everything else flexes automatically through borrowing.

### 5.8 Fixing the unbudgeted vanity path

`lookupPlayer` in `apps/web/src/server/player.ts:366` must stop calling Steam
raw. Two options:
- **Preferred:** route it through the `on-demand` broker class. Since the web
  app already has a Postgres role, add a `BudgetedSteamClient` (or a thin
  `resolveVanity` server fn that does the `steam_budget` acquire, then fetches).
  If the on-demand budget is exhausted, fail soft (return `{steamid:null}` /
  "try again") rather than silently overspending.
- Cache resolved vanity→steamid mappings in a small table (vanity names are
  stable) so repeat lookups cost 0 calls.

### 5.9 Processes / files to add or change (implementation map)

- **New:** `packages/steam` gains a `BudgetedSteamClient` (or a `Broker`
  wrapper around `SteamClient`) that takes a `class` + a `Db` handle and does
  the acquire in §5.4 before delegating to the existing client. Keep
  `TokenBucket` as the local smoother.
- **New migration:** `steam_budget`, `steam_budget_global` tables + seed rows
  with the §5.5 numbers. Grant the web role `UPDATE` on these.
- **Change:** `index.ts`, `scanner.ts`, `sampler.ts` construct
  `new BudgetedSteamClient({ apiKey, class: 'crawler'|'scanner'|'sampler', db })`.
  Recrawl vs discovery both run in the crawler process — tag the *acquire* with
  the dequeued row's class (`recrawl` vs `crawler`) so they draw from different
  budget rows.
- **Change:** crawler `dequeue` → weighted-round-robin across source-classes
  (§5.6) instead of pure `priority DESC`.
- **Change:** web `lookupPlayer` → budgeted (§5.8).
- **New tick:** CCU-adaptive re-weighting job (§5.7), reading
  `population_snapshots` + `api_metrics`.
- **Observability:** the scheduler already writes `api_metrics`; add a tiny
  view/dashboard of calls-per-class-per-hour vs floor/ceiling to confirm we
  track under 100k and to retune.

### 5.10 Migration path (low-risk, incremental)
1. Ship the tables + `BudgetedSteamClient` with **global bucket only** (single
   hard 1.157/s cap shared across all processes). This alone kills the
   over-budget risk immediately, even before per-class fairness.
2. Add per-class floors/ceilings + borrowing.
3. Add weighted-RR frontier dequeue (fixes friend-BFS starvation).
4. Add CCU-adaptive re-weighting + budget the vanity path.

Steps 1–2 are the safety fix; 3–4 are the "intelligent/dynamic" upgrade.

---

## 6. Answers to the specific questions

- **Coordinated today?** No. Three independent in-memory buckets (crawler,
  scanner, sampler) each at 1/s + an unthrottled web vanity path. They can and
  do collectively target ~102.5k/day, over the 100k ceiling.
- **Priority queue needed?** Yes, but a *weighted-fair* one with per-class
  floors — strict priority (today) starves friend-BFS as recrawl demand grows.
- **Single limiter vs per-service vs broker?** A **Postgres-backed token
  broker** (Option B) — no new infra, durable, global, reachable from Vercel,
  cheap at 1.15/s. A steam-gateway process is the runner-up; Redis is overkill.
- **Starvation protection:** guaranteed per-class floors (crawler 25k, recrawl
  20k, sampler 12k, on-demand 8k, scanner 1.5k) + a shared borrowable spare
  (~28.5k) + an on-demand fast lane. Nothing starves to zero; bursts borrow
  spare instead of preempting floors.
- **Time-of-day:** yes — scale sampler (and lightly scanner) with live CCU from
  `population_snapshots`; off-peak sampler donations auto-feed the BFS backlog.
