/**
 * Match sampler: repeatedly samples the SAME populated Valve casual servers
 * within a time window to build per-player-name score trajectories
 * (match_segments / match_participants).
 *
 * Each cycle runs ROUNDS rounds spaced ROUND_INTERVAL_MS apart. Every round
 * costs 1 GetServerList (valve filter, gives current map + liveness per
 * server steamid) + up to MAX_SERVERS QueryByFakeIP player queries, so a
 * cycle costs ROUNDS * (1 + MAX_SERVERS) = 205 calls. The cycle length is
 * derived from SAMPLER_CALLS_PER_DAY (default 15000):
 *   cycleMs = ceil(86_400_000 * 205 / 15000) = 1_180_800 ms ≈ 19.7 min
 * → ~73.2 cycles/day * 205 calls = ≤ 15,000 calls/day.
 *
 * Consecutive observations of one server (steamid from GetServerList) on the
 * same map form a segment; a map change, the server vanishing/emptying, or
 * cycle end closes it. Rows are upserted after every observation (crash-safe;
 * a closed segment simply stops being updated). Only raw score/time endpoints
 * are persisted — observed points/hour is derived at query time as
 * (last_score - first_score) / (last_seen - first_seen). Because only
 * gametype "valve" servers are sampled, community point-farming servers
 * cannot pollute these rates.
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
const MAX_SERVERS = 40;
const ROUNDS = 5;
const ROUND_INTERVAL_MS = 3 * 60_000;
const MIN_PLAYERS = 12;

const CALLS_PER_DAY = Number(process.env["SAMPLER_CALLS_PER_DAY"] ?? 15000);
if (!Number.isFinite(CALLS_PER_DAY) || CALLS_PER_DAY <= 0) {
  throw new Error("SAMPLER_CALLS_PER_DAY must be a positive number");
}
const CALLS_PER_CYCLE = ROUNDS * (1 + MAX_SERVERS);
/** never sample faster than the round pacing allows, never blow the budget */
const CYCLE_MS = Math.max(
  ROUNDS * ROUND_INTERVAL_MS,
  Math.ceil((86_400_000 * CALLS_PER_CYCLE) / CALLS_PER_DAY),
);

interface Segment {
  /** match_segments.id, assigned on first persisted observation */
  id: number | undefined;
  serverSteamid: string;
  map: string;
  region: number;
  startedAt: Date;
  observations: number;
}

function isPopulatedValve(s: GameServer): boolean {
  return (s.gametype ?? "").split(",").includes("valve") && s.players - s.bots >= MIN_PLAYERS;
}

/**
 * Pick up to MAX_SERVERS servers spread across regions: round-robin over
 * region buckets, each ordered by human player count descending, so no
 * single region monopolises the sample.
 */
function selectServers(servers: GameServer[]): GameServer[] {
  const buckets = new Map<number, GameServer[]>();
  for (const s of servers) {
    const region = s.region ?? 255;
    const bucket = buckets.get(region) ?? [];
    bucket.push(s);
    buckets.set(region, bucket);
  }
  for (const bucket of buckets.values()) {
    bucket.sort((a, b) => b.players - b.bots - (a.players - a.bots));
  }
  const lists = [...buckets.values()];
  const picked: GameServer[] = [];
  for (let i = 0; picked.length < MAX_SERVERS; i++) {
    let any = false;
    for (const list of lists) {
      const s = list[i];
      if (!s) continue;
      picked.push(s);
      any = true;
      if (picked.length >= MAX_SERVERS) break;
    }
    if (!any) break;
  }
  return picked;
}

/**
 * Persist one round of A2S player data for an open segment: insert the
 * segment row on its first observation, then upsert participant endpoints.
 */
async function recordObservation(seg: Segment, now: Date, players: FakeIpPlayer[]): Promise<void> {
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

  // Duplicate names WITHIN one observation: keep the entry with the higher
  // time_played (the longer-connected client is the "real" one; the other is
  // usually a reconnect ghost). Names stay raw unicode, trimmed to 64 chars —
  // they later join probabilistically to players.personaname + stat-delta
  // windows (that fusion is deliberately NOT implemented here).
  const dedup = new Map<string, FakeIpPlayer>();
  for (const p of players) {
    const name = p.name.slice(0, 64);
    if (!name) continue;
    const prev = dedup.get(name);
    if (!prev || p.time_played > prev.time_played) dedup.set(name, p);
  }
  if (dedup.size === 0) return;

  const rows = [...dedup.entries()].map(([name, p]) => ({
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

function makeSegment(s: GameServer): Segment {
  return {
    id: undefined,
    serverSteamid: s.steamid,
    map: normalizeMap(s.map),
    region: s.region ?? 255,
    startedAt: new Date(),
    observations: 0,
  };
}

function normalizeMap(map: string): string {
  return map.toLowerCase().slice(0, 64);
}

async function cycle(): Promise<void> {
  const cycleStart = Date.now();
  /** open segments, keyed by server steamid */
  const tracked = new Map<string, Segment>();
  let segments = 0;

  for (let round = 0; round < ROUNDS; round++) {
    await Bun.sleep(Math.max(0, cycleStart + round * ROUND_INTERVAL_MS - Date.now()));

    const list = await steam.getServerList(VALVE_FILTER, 20000);
    if (list.kind !== "ok") {
      console.warn(`round ${round}: GetServerList failed (${list.kind}), skipping round`);
      if (round === 0) return;
      continue;
    }
    if (list.data.length === 10000) {
      console.error(
        "!!! GetServerList TRUNCATED at 10000 for the valve filter — " +
          "sampling pool is incomplete, the query must be re-split !!!",
      );
    }
    const byId = new Map(list.data.map((s) => [s.steamid, s]));

    if (round === 0) {
      const pool = list.data.filter(isPopulatedValve);
      const picked = selectServers(pool);
      console.log(`cycle start: ${pool.length} populated valve servers, sampling ${picked.length}`);
      for (const s of picked) {
        tracked.set(s.steamid, makeSegment(s));
        segments += 1;
      }
    }

    // snapshot: drops and map-change re-opens mutate `tracked` mid-loop
    const roundIds = Array.from(tracked.keys());
    for (const steamid of roundIds) {
      const current = byId.get(steamid);
      if (!current) {
        // server gone from the master list → segment closed, drop from cycle
        tracked.delete(steamid);
        continue;
      }
      let seg = tracked.get(steamid);
      if (!seg) continue;
      const map = normalizeMap(current.map);
      if (map !== seg.map) {
        // map change closes the segment; keep sampling the server on its new map
        seg = makeSegment(current);
        tracked.set(steamid, seg);
        segments += 1;
      }

      const res = await steam.queryFakeIpPlayers(current.addr);
      if (res.kind !== "ok") {
        // empty (nobody home) or error → segment closed, drop from cycle
        tracked.delete(steamid);
        continue;
      }
      await recordObservation(seg, new Date(), res.data);
    }
  }

  // cycle end closes every remaining segment (already fully persisted)
  console.log(
    `cycle done in ${Math.round((Date.now() - cycleStart) / 1000)}s: ` +
      `${segments} segments, ${tracked.size} still open at cycle end`,
  );
}

console.log(
  `sampler started: ${MAX_SERVERS} servers x ${ROUNDS} rounds = ${CALLS_PER_CYCLE} calls/cycle, ` +
    `cycle ${(CYCLE_MS / 60_000).toFixed(1)} min (budget ${CALLS_PER_DAY}/day)`,
);
for (;;) {
  const start = Date.now();
  try {
    await cycle();
  } catch (err) {
    console.error("cycle failed:", err);
  }
  try {
    await flushMetrics(db);
  } catch (err) {
    console.error("flushMetrics failed:", err);
  }
  await Bun.sleep(Math.max(0, CYCLE_MS - (Date.now() - start)));
}
