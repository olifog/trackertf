import { createDbFromEnv, schema } from "@trackertf/db";
import { SteamClient, type SteamResult } from "@trackertf/steam";
import { eq, sql } from "drizzle-orm";
import { flushMetrics, record } from "./metrics.ts";
import { parseClassStats, parseEquipped } from "./parse.ts";

const apiKey = process.env["STEAM_API_KEY"];
if (!apiKey) throw new Error("STEAM_API_KEY is not set");

const db = createDbFromEnv();
const steam = new SteamClient({ apiKey, ratePerSecond: 1, onResult: record });

/** Queue expansion mirrors styletf: active, high-hours players spread the BFS. */
const EXPAND_MIN_MINUTES = 100_000;
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

async function dequeue(): Promise<FrontierItem | undefined> {
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
          where (locked_until is null or locked_until < now()) and attempts < ${MAX_ATTEMPTS}
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
      await enqueueFriends(friends.data.map((f) => f.steamid));
    }
  }
}

/**
 * Cohort-based recrawl scheduling (delta design doc §2):
 *  A "hyper"  — active in last 2 weeks → every 8h (session-resolution windows)
 *  C rotation — rest of the public-stats corpus → every 14d
 * Recrawls run at priority 1: above the (endless) friend-BFS backlog, below manual seeds — the scheduler cap keeps discovery fed.
 */
async function scheduleRecrawls(): Promise<void> {
  await db.execute(sql`
    insert into crawl_frontier (steamid, source, priority)
    select p.steamid, 'recrawl'::frontier_source, 1
    from players p
    where p.stats_status = 'ok'
      and not exists (select 1 from crawl_frontier f where f.steamid = p.steamid)
      and (
        (coalesce(p.tf2_minutes_2wk, 0) > 0 and p.last_crawled < now() - interval '8 hours')
        or p.last_crawled < now() - interval '14 days'
      )
    order by p.last_crawled asc
    limit 2000
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
