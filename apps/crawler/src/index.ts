import { createDbFromEnv, schema } from "@trackertf/db";
import { type SteamResult } from "@trackertf/steam";
import { eq, sql } from "drizzle-orm";
import { flushMetrics } from "./metrics.ts";
import { parseClassStats, parseEquipped } from "./parse.ts";
import { createBudgetedSteamClient } from "./steamBudget.ts";

const db = createDbFromEnv();
const steam = createBudgetedSteamClient(db, "crawler");

/** Queue expansion mirrors styletf: active, high-hours players spread the BFS. */
const EXPAND_MIN_MINUTES = 100_000;
/**
 * Friend fan-out is subsampled per expander. Unbounded fan-out lets a single
 * mega-account (thousands of friends) flood the frontier and bias discovery
 * toward its social cluster; capping keeps the BFS breadth-first. K scales with
 * the expander's lifetime hours (more-invested players seed better leads) and is
 * throttled down for over-represented countries (see countryFanoutFactor).
 */
const MIN_FANOUT = 5;
const MAX_FANOUT = 30;
const FANOUT_BASE = 12;
/** Country-share throttle: at/under TARGET_SHARE a country expands freely. */
const TARGET_SHARE = 0.15;
const COUNTRY_SHARE_TTL_MS = 10 * 60_000;
const LOCK_MINUTES = 10;
const MAX_ATTEMPTS = 3;
const CONCURRENCY = Number(process.env["CRAWLER_CONCURRENCY"] ?? 6);
const BACKOFF_MS = 30_000;

/** Steam is throttling or down — all workers pause, nothing gets recorded. */
class TransientSteamError extends Error {
  constructor(steamid: string, status: number | undefined, message: string) {
    super(`transient steam error for ${steamid} (HTTP ${status ?? "?"}): ${message}`);
  }
}

function unwrapOrThrow<T>(steamid: string, res: SteamResult<T>): SteamResult<T> {
  if (res.kind === "error") throw new TransientSteamError(steamid, res.status, res.message);
  return res;
}

/** Shared across workers: transient failures pause the whole crawler. */
let pausedUntil = 0;

type FrontierItem = { steamid: string; source: (typeof schema.frontierSource.enumValues)[number] };

/**
 * Weighted round-robin service weights per frontier source. Strict priority
 * (the old `order by priority desc`) starved low-priority classes: a flood of
 * recrawls (priority 1) could indefinitely block the friend-BFS backlog
 * (priority 0), freezing discovery. Instead each dequeue runs a weighted
 * lottery over the sources that currently have work, so long-run service share
 * is proportional to weight and EVERY source with a weight > 0 keeps flowing.
 * `priority`/`enqueued_at` still order rows WITHIN a chosen source.
 */
const SOURCE_WEIGHT = sql`case source
  when 'seed' then 8
  when 'recrawl' then 5
  when 'review_sample' then 3
  when 'random_sample' then 3
  when 'friend_bfs' then 4
  else 1
end`;

/**
 * One weighted-fair draw: pick a source by lottery (Efraimidis–Spirakis key
 * random()^(1/weight), so P(pick) ∝ weight among sources with eligible rows),
 * then lock that source's best unlocked row. `for update skip locked` means
 * concurrent workers landing on the same source grab DIFFERENT rows rather than
 * colliding. Returns undefined if the drawn source's rows were all locked.
 */
async function drawOne(): Promise<FrontierItem | undefined> {
  const now = new Date();
  const [row] = await db
    .update(schema.crawlFrontier)
    .set({
      lockedUntil: new Date(now.getTime() + LOCK_MINUTES * 60_000),
      attempts: sql`${schema.crawlFrontier.attempts} + 1`,
    })
    .where(
      eq(
        schema.crawlFrontier.steamid,
        sql`(
          select steamid from crawl_frontier
          where (locked_until is null or locked_until < now())
            and attempts < ${MAX_ATTEMPTS}
            and source = (
              select source from (
                select distinct source from crawl_frontier
                where (locked_until is null or locked_until < now())
                  and attempts < ${MAX_ATTEMPTS}
              ) avail
              order by power(random(), 1.0 / (${SOURCE_WEIGHT})) desc
              limit 1
            )
          order by priority desc, enqueued_at asc
          limit 1
          for update skip locked
        )`,
      ),
    )
    .returning({
      steamid: schema.crawlFrontier.steamid,
      source: schema.crawlFrontier.source,
    });
  return row;
}

async function dequeue(): Promise<FrontierItem | undefined> {
  // A draw can come back empty if the lottery lands on a source whose eligible
  // rows are all locked by peers; redraw a few times before declaring the
  // frontier empty so contention doesn't masquerade as "no work".
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await drawOne();
    if (row) return row;
  }
  return undefined;
}

/** Friends enter the frontier only if never crawled — recrawls are deliberate. */
async function enqueueFriends(steamids: readonly string[]): Promise<void> {
  if (steamids.length === 0) return;
  await db.execute(sql`
    insert into crawl_frontier (steamid, source)
    select t.steamid, 'friend_bfs'::frontier_source
    from jsonb_array_elements_text(${JSON.stringify(steamids)}::jsonb) as t(steamid)
    where not exists (select 1 from players p where p.steamid = t.steamid)
    on conflict (steamid) do nothing
  `);
}

/** Clamp to an inclusive range. */
function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/**
 * Fisher–Yates shuffle (new array). Used to subsample friends without
 * steamid-ordering bias — a head-slice would over-pick the same steamid range.
 */
function shuffle<T>(items: readonly T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * In-memory country-share cache, refreshed lazily by TTL. Built from the same
 * POP-filtered aggregate the /health page uses so expansion throttling tracks
 * the corpus it's rebalancing. Reading players.loccountrycode later is a plain
 * column read (no Steam API call), so the throttle stays off the crawl budget.
 */
let countryShare = new Map<string, number>();
let countryShareRefreshedAt = 0;

async function refreshCountryShare(): Promise<void> {
  if (Date.now() - countryShareRefreshedAt < COUNTRY_SHARE_TTL_MS) return;
  countryShareRefreshedAt = Date.now();
  const rows = (await db.execute(sql`
    select loccountrycode as cc, count(*) as n
    from players
    where loccountrycode is not null
      and personaname is not null
      and vac_banned = false
      and coalesce(botness, 0) < 0.5
    group by loccountrycode
  `)) as unknown as Record<string, unknown>[];
  let total = 0;
  for (const r of rows) total += Number(r["n"]);
  const next = new Map<string, number>();
  if (total > 0) for (const r of rows) next.set(String(r["cc"]), Number(r["n"]) / total);
  countryShare = next;
}

/**
 * Down-weight fan-out for over-represented countries: at/under TARGET_SHARE the
 * factor is 1 (no throttle); above it it falls off ∝ target/share, floored at
 * 0.25 so no country is fully starved. Null country → no signal → factor 1.
 */
function countryFanoutFactor(cc: string | null): number {
  if (cc === null) return 1;
  const share = countryShare.get(cc) ?? 0;
  return clamp(TARGET_SHARE / Math.max(share, TARGET_SHARE), 0.25, 1.0);
}

/** Exhausted frontier rows become error-status players instead of zombies. */
async function sweepDeadLetters(): Promise<void> {
  await db.execute(sql`
    with dead as (
      delete from crawl_frontier
      where attempts >= ${MAX_ATTEMPTS} and (locked_until is null or locked_until < now())
      returning steamid, source
    )
    insert into players (steamid, source, items_status, stats_status)
    select steamid, source, 'error'::fetch_status, 'error'::fetch_status from dead
    on conflict (steamid) do nothing
  `);
}

/** Profile/ban enrichment is batched 100 steamids per call (~1% budget). */
const enrichQueue: string[] = [];

async function flushEnrichment(force = false): Promise<void> {
  if (enrichQueue.length === 0 || (!force && enrichQueue.length < 100)) return;
  const batch = enrichQueue.splice(0, 100);

  const summaries = await steam.getPlayerSummaries(batch);
  if (summaries.kind === "ok") {
    for (const p of summaries.data) {
      await db
        .update(schema.players)
        .set({
          personaname: p.personaname,
          avatarHash: p.avatarhash ?? null,
          visibility: p.communityvisibilitystate,
          loccountrycode: p.loccountrycode ?? null,
        })
        .where(eq(schema.players.steamid, p.steamid));
    }
  }

  const bans = await steam.getPlayerBans(batch);
  if (bans.kind === "ok") {
    for (const b of bans.data) {
      await db
        .update(schema.players)
        .set({ vacBanned: b.VACBanned, gameBans: b.NumberOfGameBans })
        .where(eq(schema.players.steamid, b.SteamId));
    }
  }
}

/** Sum of per-class playtimes — the cheap "did anything happen" fingerprint. */
function classTimeSum(stats: ReadonlyMap<string, number> | Record<string, number>): number {
  const entries = stats instanceof Map ? stats.entries() : Object.entries(stats);
  let sum = 0;
  for (const [name, value] of entries) {
    if (name.endsWith(".accum.iPlayTime") && !name.includes("mvm")) sum += value;
  }
  return sum;
}

async function crawlOne({ steamid, source }: FrontierItem): Promise<void> {
  const fetchedAt = new Date();

  // Transient errors throw before anything is recorded, so the frontier's
  // lock/attempt machinery retries instead of poisoning player statuses.
  const stats = unwrapOrThrow(steamid, await steam.getUserStats(steamid));
  const playtime = unwrapOrThrow(steamid, await steam.getTf2Playtime(steamid));

  // Recrawls with no stat movement skip the expensive GetPlayerItems call
  // (~2 calls per empty window instead of 3+ — the budget lever that makes
  // session-resolution delta tracking viable).
  if (source === "recrawl") {
    const [last] = await db
      .select({ payload: schema.playerStatSnapshots.payload })
      .from(schema.playerStatSnapshots)
      .where(eq(schema.playerStatSnapshots.steamid, steamid))
      .orderBy(sql`fetched_at desc`)
      .limit(1);
    const unchanged =
      stats.kind === "ok" &&
      last !== undefined &&
      classTimeSum(stats.data) === classTimeSum(last.payload as Record<string, number>);

    if (stats.kind !== "ok" || unchanged) {
      await db.transaction(async (tx) => {
        await tx
          .update(schema.players)
          .set({
            lastCrawled: fetchedAt,
            statsStatus: stats.kind === "ok" ? "ok" : stats.kind,
            tf2Minutes: playtime.kind === "ok" ? playtime.data.minutes : undefined,
            tf2Minutes2wk: playtime.kind === "ok" ? playtime.data.minutes2wk : undefined,
          })
          .where(eq(schema.players.steamid, steamid));
        await tx.delete(schema.crawlFrontier).where(eq(schema.crawlFrontier.steamid, steamid));
      });
      return;
    }
  }

  const items = unwrapOrThrow(steamid, await steam.getPlayerItems(steamid));

  await db.transaction(async (tx) => {
    await tx
      .insert(schema.players)
      .values({
        steamid,
        source,
        lastCrawled: fetchedAt,
        itemsStatus: items.kind === "ok" ? "ok" : items.kind,
        statsStatus: stats.kind === "ok" ? "ok" : stats.kind,
        tf2Minutes: playtime.kind === "ok" ? playtime.data.minutes : null,
        tf2Minutes2wk: playtime.kind === "ok" ? playtime.data.minutes2wk : null,
      })
      .onConflictDoUpdate({
        target: schema.players.steamid,
        set: {
          lastCrawled: fetchedAt,
          itemsStatus: sql`excluded.items_status`,
          statsStatus: sql`excluded.stats_status`,
          tf2Minutes: sql`coalesce(excluded.tf2_minutes, players.tf2_minutes)`,
          tf2Minutes2wk: sql`coalesce(excluded.tf2_minutes_2wk, players.tf2_minutes_2wk)`,
          // source intentionally not updated — first provenance wins
        },
      });

    if (items.kind === "ok") {
      await tx
        .insert(schema.playerItemsRaw)
        .values({ steamid, fetchedAt, payload: items.data })
        .onConflictDoUpdate({
          target: schema.playerItemsRaw.steamid,
          set: { fetchedAt, payload: items.data },
        });
      await tx.delete(schema.equippedItems).where(eq(schema.equippedItems.steamid, steamid));
      const equipped = parseEquipped(items.data).map((row) => ({ steamid, ...row }));
      if (equipped.length > 0) await tx.insert(schema.equippedItems).values(equipped);
    }

    if (stats.kind === "ok") {
      await tx
        .insert(schema.playerStatsRaw)
        .values({ steamid, fetchedAt, payload: Object.fromEntries(stats.data) })
        .onConflictDoUpdate({
          target: schema.playerStatsRaw.steamid,
          set: { fetchedAt, payload: Object.fromEntries(stats.data) },
        });
      // append-only history for delta attribution (loadout captured jointly
      // so windows know what was equipped while the stats accrued)
      await tx
        .insert(schema.playerStatSnapshots)
        .values({
          steamid,
          fetchedAt,
          payload: Object.fromEntries(stats.data),
          loadout:
            items.kind === "ok"
              ? parseEquipped(items.data).map((e) => [e.defindex, e.classNum, e.slot])
              : null,
          tf2Minutes: playtime.kind === "ok" ? playtime.data.minutes : null,
        })
        .onConflictDoNothing();
      await tx.delete(schema.playerClassStats).where(eq(schema.playerClassStats.steamid, steamid));
      const classStats = parseClassStats(stats.data).map((row) => ({ steamid, ...row }));
      if (classStats.length > 0) await tx.insert(schema.playerClassStats).values(classStats);
    }

    await tx.delete(schema.crawlFrontier).where(eq(schema.crawlFrontier.steamid, steamid));
  });

  enrichQueue.push(steamid);
  await flushEnrichment();

  const shouldExpand =
    playtime.kind === "ok" &&
    playtime.data.minutes2wk > 0 &&
    playtime.data.minutes > EXPAND_MIN_MINUTES;
  if (shouldExpand) {
    const friends = unwrapOrThrow(steamid, await steam.getFriendList(steamid));
    if (friends.kind === "ok") {
      await db
        .insert(schema.playerFriendsRaw)
        .values({ steamid, fetchedAt, payload: friends.data })
        .onConflictDoUpdate({
          target: schema.playerFriendsRaw.steamid,
          set: { fetchedAt, payload: friends.data },
        });

      // Fan-out cap: value-scale K by the expander's lifetime hours, then throttle
      // by its country's share of the corpus. The FULL friend list is persisted
      // above (the graph edge stays complete); only the ENQUEUE is subsampled.
      await refreshCountryShare();
      const [self] = await db
        .select({ cc: schema.players.loccountrycode })
        .from(schema.players)
        .where(eq(schema.players.steamid, steamid))
        .limit(1);
      const valueScaledK = clamp(
        Math.round(FANOUT_BASE * Math.log2(playtime.data.minutes / EXPAND_MIN_MINUTES + 1)),
        MIN_FANOUT,
        MAX_FANOUT,
      );
      const k = clamp(
        Math.round(valueScaledK * countryFanoutFactor(self?.cc ?? null)),
        MIN_FANOUT,
        MAX_FANOUT,
      );
      await enqueueFriends(shuffle(friends.data.map((f) => f.steamid)).slice(0, k));
    }
  }
}

/**
 * Cohort-based recrawl scheduling (delta design doc §2):
 *  A "hyper"  — active in last 2 weeks → every 8h (session-resolution windows)
 *  C rotation — rest of the public-stats corpus → every 14d
 * Two tiers so high-hours actives don't get starved by the flat backlog: the
 * active tier enqueues at priority 2 ordered by lifetime hours desc (biggest
 * time-sinks first, session windows stay tight), the fairness tier at priority 1
 * ordered by last_crawled asc (starvation guard for the long tail). Recrawls
 * still sit above the (endless) friend-BFS backlog and below manual seeds — the
 * per-tier caps keep discovery fed.
 */
async function scheduleRecrawls(): Promise<void> {
  await db.execute(sql`
    insert into crawl_frontier (steamid, source, priority)
    select steamid, 'recrawl'::frontier_source, priority from (
      select p.steamid, 2 as priority
      from players p
      where p.stats_status = 'ok'
        and coalesce(p.tf2_minutes_2wk, 0) > 0
        and p.last_crawled < now() - interval '8 hours'
        and not exists (select 1 from crawl_frontier f where f.steamid = p.steamid)
      order by coalesce(p.tf2_minutes, 0) desc, p.last_crawled asc
      limit 1500
    ) active
    union all
    select steamid, 'recrawl'::frontier_source, priority from (
      select p.steamid, 1 as priority
      from players p
      where p.stats_status = 'ok'
        and p.last_crawled < now() - interval '14 days'
        and not exists (select 1 from crawl_frontier f where f.steamid = p.steamid)
      order by p.last_crawled asc
      limit 500
    ) fairness
    on conflict (steamid) do nothing
  `);
}

async function schedulerLoop(): Promise<void> {
  for (;;) {
    try {
      await scheduleRecrawls();
    } catch (err) {
      console.error("recrawl scheduler:", err);
    }
    await Bun.sleep(15 * 60_000);
  }
}

async function worker(id: number): Promise<void> {
  for (;;) {
    const pauseLeft = pausedUntil - Date.now();
    if (pauseLeft > 0) await Bun.sleep(pauseLeft);

    const next = await dequeue();
    if (!next) {
      await flushEnrichment(true);
      await sweepDeadLetters();
      await flushMetrics(db).catch((err) => console.error("metrics flush:", err));
      await Bun.sleep(30_000);
      continue;
    }
    try {
      await crawlOne(next);
      if (Math.random() < 0.05) await flushMetrics(db).catch(() => {});
    } catch (err) {
      if (err instanceof TransientSteamError) {
        pausedUntil = Math.max(pausedUntil, Date.now() + BACKOFF_MS);
        console.warn(`[w${id}] pausing all workers: ${err.message}`);
      } else {
        console.error(`[w${id}] crawl failed for ${next.steamid}:`, err);
      }
    }
  }
}

console.log(`crawler started (${CONCURRENCY} workers)`);
await Promise.all([schedulerLoop(), ...Array.from({ length: CONCURRENCY }, (_, i) => worker(i))]);
