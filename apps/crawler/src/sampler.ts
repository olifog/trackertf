/**
 * Match sampler: continuously tracks a fixed-size set of the SAME populated
 * Valve casual servers, building per-player-name score trajectories
 * (match_segments / match_participants).
 *
 * DESIGN (rebuilt 2026-08-20 — was a bursty 12-min cycle before):
 * The sampler runs one observation ROUND every ROUND_INTERVAL_MS, forever.
 * Each round costs 1 GetServerList (valve filter → current map + liveness per
 * server steamid) + up to TARGET_SERVERS QueryByFakeIP player queries. The
 * round interval is derived from SAMPLER_CALLS_PER_DAY so the steady rate stays
 * under budget:
 *   roundMs = ceil(86_400_000 * (1 + TARGET_SERVERS) / CALLS_PER_DAY)
 *   e.g. 40 servers, 15000/day → 41 calls/round, round ≈ 3.9 min.
 *
 * Unlike the old design, tracked servers are KEPT across rounds — a segment
 * lives for the real duration of play (20, 40, 90 min) with an observation
 * every ~4 min, instead of a 12-min burst then an 8-min blind gap. This gives
 * low-variance points/hour (full-match windows) and lets us see matches
 * start-to-finish. A slot is refilled (regional round-robin) only when its
 * server empties/dies.
 *
 * A segment closes on a real MATCH BOUNDARY:
 *   - score_reset — a clear majority of RETURNING players' scores dropped
 *     between two observations. Casual score is monotonic within a match, so a
 *     simultaneous drop only happens when the scoreboard resets for a new
 *     match. This catches back-to-back matches on the SAME map, which a
 *     map-change check alone misses.
 *   - map_change — the server rolled to a different map.
 * Both are stamped in match_segments.reason_closed, so segment span = a real
 * match length for duration stats. server_gone (emptied/vanished) is ambiguous
 * and stamped too, but excluded from duration aggregates.
 *
 * Rows are upserted after every observation (crash-safe; a closed segment just
 * stops being updated). Only raw score/time endpoints are persisted — observed
 * points/hour is derived at query time. Because only gametype "valve" servers
 * are sampled, community point-farming servers cannot pollute these rates.
 */
import { createDbFromEnv, schema } from "@trackertf/db";
import { type FakeIpPlayer, type GameServer, SteamClient } from "@trackertf/steam";
import { eq, sql } from "drizzle-orm";
import { flushMetrics, record } from "./metrics.ts";

const apiKey = process.env["STEAM_API_KEY"];
if (!apiKey) throw new Error("STEAM_API_KEY is not set");

const db = createDbFromEnv();
const steam = new SteamClient({ apiKey, ratePerSecond: 1, onResult: record });

// \empty\1 (has players) keeps the list under GetServerList's hard 10k
// truncation — the bare valve filter returns >10k thanks to idle SDR standby
// servers. Tracked-but-emptied servers dropping off this list is fine: an
// empty server ends its segment anyway.
const VALVE_FILTER = "\\appid\\440\\gametype\\valve\\empty\\1";
/** how many servers to track concurrently (the sample width) */
const TARGET_SERVERS = 40;
/** min human players to START tracking a server */
const MIN_PLAYERS = 12;
/** below this human count a tracked server is dropped so the slot can refill */
const MIN_KEEP = 4;
/** reset detection: min returning players needed to trust the score signal */
const RESET_MIN_OVERLAP = 4;
/** ...and the fraction of them whose score must have dropped */
const RESET_DROP_FRACTION = 0.6;
/** never sample a single server faster than this, whatever the budget allows */
const MIN_ROUND_MS = 60_000;

const CALLS_PER_DAY = Number(process.env["SAMPLER_CALLS_PER_DAY"] ?? 15000);
if (!Number.isFinite(CALLS_PER_DAY) || CALLS_PER_DAY <= 0) {
  throw new Error("SAMPLER_CALLS_PER_DAY must be a positive number");
}
const CALLS_PER_ROUND = 1 + TARGET_SERVERS;
const ROUND_INTERVAL_MS = Math.max(
  MIN_ROUND_MS,
  Math.ceil((86_400_000 * CALLS_PER_ROUND) / CALLS_PER_DAY),
);

type CloseReason = "score_reset" | "map_change" | "server_gone";

interface Segment {
  /** match_segments.id, assigned on the first persisted observation */
  id: number | undefined;
  serverSteamid: string;
  map: string;
  region: number;
  startedAt: Date;
  observations: number;
  /** last observation's per-name score, for reset detection */
  lastScores: Map<string, number>;
}

/** open segments, keyed by server steamid — persists across rounds */
const tracked = new Map<string, Segment>();

function isPopulatedValve(s: GameServer): boolean {
  return (s.gametype ?? "").split(",").includes("valve") && s.players - s.bots >= MIN_PLAYERS;
}

function normalizeMap(map: string): string {
  return map.toLowerCase().slice(0, 64);
}

function makeSegment(s: GameServer): Segment {
  return {
    id: undefined,
    serverSteamid: s.steamid,
    map: normalizeMap(s.map),
    region: s.region ?? 255,
    startedAt: new Date(),
    observations: 0,
    lastScores: new Map(),
  };
}

/**
 * Duplicate names WITHIN one observation: keep the entry with the higher
 * time_played (the longer-connected client is the "real" one; the other is
 * usually a reconnect ghost). Names stay raw unicode, trimmed to 64 chars.
 */
function dedupPlayers(players: FakeIpPlayer[]): Map<string, FakeIpPlayer> {
  const dedup = new Map<string, FakeIpPlayer>();
  for (const p of players) {
    const name = p.name.slice(0, 64);
    if (!name) continue;
    const prev = dedup.get(name);
    if (!prev || p.time_played > prev.time_played) dedup.set(name, p);
  }
  return dedup;
}

/**
 * A scoreboard reset (new match on the same server) shows up as a simultaneous
 * score DROP for the players who stayed. During normal play casual score only
 * increases, so a clear majority of returning players dropping their score is
 * an unambiguous reset. Conservative: requires enough returning players and a
 * strong majority, so churn (players leaving/joining) never false-triggers.
 */
function isReset(prev: Map<string, number>, cur: Map<string, FakeIpPlayer>): boolean {
  let overlap = 0;
  let dropped = 0;
  for (const [name, p] of cur) {
    const ps = prev.get(name);
    if (ps === undefined) continue;
    overlap += 1;
    if (p.score < ps) dropped += 1;
  }
  return overlap >= RESET_MIN_OVERLAP && dropped / overlap >= RESET_DROP_FRACTION;
}

/** Stamp reason_closed on a persisted segment so duration stats can trust it. */
async function closeSegment(seg: Segment, reason: CloseReason): Promise<void> {
  if (seg.id === undefined) return; // never persisted (server died before obs)
  await db
    .update(schema.matchSegments)
    .set({ reasonClosed: reason })
    .where(eq(schema.matchSegments.id, seg.id));
}

/**
 * Persist one round of A2S player data for an open segment: insert the segment
 * row on its first observation, then upsert participant endpoints and refresh
 * the segment's lastScores for the next round's reset check.
 */
async function recordObservation(
  seg: Segment,
  now: Date,
  players: Map<string, FakeIpPlayer>,
): Promise<void> {
  seg.observations += 1;

  if (seg.id === undefined) {
    const [inserted] = await db
      .insert(schema.matchSegments)
      .values({
        serverSteamid: seg.serverSteamid,
        map: seg.map,
        region: seg.region,
        startedAt: seg.startedAt,
        endedAt: now,
        observations: seg.observations,
      })
      .returning({ id: schema.matchSegments.id });
    if (!inserted) throw new Error("match_segments insert returned no row");
    seg.id = inserted.id;
  } else {
    await db
      .update(schema.matchSegments)
      .set({ endedAt: now, observations: seg.observations })
      .where(eq(schema.matchSegments.id, seg.id));
  }

  seg.lastScores = new Map([...players].map(([name, p]) => [name, p.score]));

  const rows = [...players.entries()].map(([name, p]) => ({
    segmentId: seg.id as number,
    name,
    firstSeen: now,
    lastSeen: now,
    firstScore: p.score,
    lastScore: p.score,
    maxScore: p.score,
    firstTimePlayed: p.time_played,
    lastTimePlayed: p.time_played,
    observations: 1,
  }));
  // A name already seen in this segment (PK conflict) keeps its first_*
  // endpoints; only last_*/max/observations advance.
  await db
    .insert(schema.matchParticipants)
    .values(rows)
    .onConflictDoUpdate({
      target: [schema.matchParticipants.segmentId, schema.matchParticipants.name],
      set: {
        lastSeen: sql`excluded.last_seen`,
        lastScore: sql`excluded.last_score`,
        maxScore: sql`greatest(${schema.matchParticipants.maxScore}, excluded.max_score)`,
        lastTimePlayed: sql`excluded.last_time_played`,
        observations: sql`${schema.matchParticipants.observations} + 1`,
      },
    });
}

/**
 * Top up the tracked set toward TARGET_SERVERS with populated valve servers not
 * already tracked, spread across regions: bucket candidates by region, visit
 * region buckets ordered by how few we already track (favours under-represented
 * regions), round-robin taking the most-populated server from each.
 */
function refill(list: GameServer[]): number {
  if (tracked.size >= TARGET_SERVERS) return 0;
  const regionCounts = new Map<number, number>();
  for (const seg of tracked.values()) {
    regionCounts.set(seg.region, (regionCounts.get(seg.region) ?? 0) + 1);
  }

  const buckets = new Map<number, GameServer[]>();
  for (const s of list) {
    if (!isPopulatedValve(s) || tracked.has(s.steamid)) continue;
    const region = s.region ?? 255;
    const bucket = buckets.get(region) ?? [];
    bucket.push(s);
    buckets.set(region, bucket);
  }
  for (const bucket of buckets.values()) {
    bucket.sort((a, b) => b.players - b.bots - (a.players - a.bots));
  }
  // visit sparsest-tracked regions first
  const order = [...buckets.keys()].sort(
    (a, b) => (regionCounts.get(a) ?? 0) - (regionCounts.get(b) ?? 0),
  );

  let added = 0;
  for (let i = 0; tracked.size < TARGET_SERVERS; i++) {
    let any = false;
    for (const region of order) {
      const s = buckets.get(region)?.[i];
      if (!s || tracked.has(s.steamid)) continue;
      tracked.set(s.steamid, makeSegment(s));
      added += 1;
      any = true;
      if (tracked.size >= TARGET_SERVERS) break;
    }
    if (!any) break;
  }
  return added;
}

async function round(): Promise<void> {
  const list = await steam.getServerList(VALVE_FILTER, 20000);
  if (list.kind !== "ok") {
    console.warn(`round: GetServerList failed (${list.kind}), skipping`);
    return;
  }
  if (list.data.length === 10000) {
    console.error(
      "!!! GetServerList TRUNCATED at 10000 for the valve filter — " +
        "sampling pool is incomplete, the query must be re-split !!!",
    );
  }
  const byId = new Map(list.data.map((s) => [s.steamid, s]));

  let closed = 0;
  let observed = 0;
  // snapshot keys: the loop mutates `tracked` (drops + boundary re-opens)
  for (const steamid of [...tracked.keys()]) {
    const current = byId.get(steamid);
    let seg = tracked.get(steamid);
    if (!seg) continue;
    if (!current) {
      // gone from the master list → emptied or vanished
      await closeSegment(seg, "server_gone");
      tracked.delete(steamid);
      closed += 1;
      continue;
    }

    const res = await steam.queryFakeIpPlayers(current.addr);
    if (res.kind !== "ok") {
      await closeSegment(seg, "server_gone");
      tracked.delete(steamid);
      closed += 1;
      continue;
    }
    const players = dedupPlayers(res.data);
    if (players.size < MIN_KEEP) {
      // match effectively over / server draining → free the slot
      await closeSegment(seg, "server_gone");
      tracked.delete(steamid);
      closed += 1;
      continue;
    }

    const map = normalizeMap(current.map);
    const boundary: CloseReason | null =
      map !== seg.map ? "map_change" : isReset(seg.lastScores, players) ? "score_reset" : null;
    if (boundary) {
      await closeSegment(seg, boundary);
      closed += 1;
      seg = makeSegment(current); // continue sampling the server's next match
      tracked.set(steamid, seg);
    }

    await recordObservation(seg, new Date(), players);
    observed += 1;
  }

  const added = refill(list.data);
  console.log(
    `round: ${observed} observed, ${closed} closed, ${added} added, ` +
      `${tracked.size} tracked (${list.data.length} valve servers listed)`,
  );
}

console.log(
  `sampler started: continuous tracking of ${TARGET_SERVERS} servers, ` +
    `round every ${(ROUND_INTERVAL_MS / 60_000).toFixed(1)} min ` +
    `(${CALLS_PER_ROUND} calls/round, budget ${CALLS_PER_DAY}/day)`,
);
for (;;) {
  const start = Date.now();
  try {
    await round();
  } catch (err) {
    console.error("round failed:", err);
  }
  try {
    await flushMetrics(db);
  } catch (err) {
    console.error("flushMetrics failed:", err);
  }
  await Bun.sleep(Math.max(0, ROUND_INTERVAL_MS - (Date.now() - start)));
}
