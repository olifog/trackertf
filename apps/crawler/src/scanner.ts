/**
 * Server scanner: GetServerList every 5 minutes → per-(map, region, official)
 * aggregates in server_snapshots. ~576 API calls/day (2 per scan). Valve MM
 * servers are detected via the "valve" gametype tag (SDR-hidden, hence region
 * from the master list rather than IP).
 *
 * GetServerList truncates at exactly 10,000 results. Post-SDR, TF2 reports
 * 10,000+ valve servers but almost all are phantom empty matchmaking
 * reservations (only ~400 valve servers actually hold players at any time), so
 * an unfiltered valve query truncates and the count is meaningless. We only
 * care about servers where players actually are, so both queries add `\empty\1`
 * ("not empty") — that captures every occupied server (valve + community) in a
 * few hundred rows each, well under the cap. If either half ever hits 10k it
 * must be re-split further — the loud warning below is the tripwire.
 */
import { createDbFromEnv, schema } from "@trackertf/db";
import { SteamClient } from "@trackertf/steam";
import { flushMetrics, record } from "./metrics.ts";

const apiKey = process.env["STEAM_API_KEY"];
if (!apiKey) throw new Error("STEAM_API_KEY is not set");

const db = createDbFromEnv();
const steam = new SteamClient({ apiKey, ratePerSecond: 1, onResult: record });
const INTERVAL_MS = 5 * 60_000;

// Populated Valve, populated community, and EMPTY community. We never query
// empty Valve servers: \gametype\valve\noplayers\1 returns 10k+ phantom
// matchmaking reservations and truncates, so a true empty-Valve count is
// impossible. Empty community is bounded and meaningful (occupancy ratio).
const SCAN_FILTERS = [
  "\\appid\\440\\gametype\\valve\\empty\\1",
  "\\appid\\440\\nor\\1\\gametype\\valve\\empty\\1",
  "\\appid\\440\\nor\\1\\gametype\\valve\\noplayers\\1",
];

/** sv_tags flags we count per bucket. Keys are the JS/DB column stems. */
const TAG_FLAGS = {
  alltalk: "alltalk",
  nocrits: "nocrits",
  respawntimes: "respawntimes",
  maxplayers: "increased_maxplayers",
  highlander: "highlander",
} as const;
type TagKey = keyof typeof TAG_FLAGS;

async function scan(): Promise<void> {
  const servers = [];
  let ok = 0;
  for (const filter of SCAN_FILTERS) {
    const res = await steam.getServerList(filter, 50000);
    if (res.kind !== "ok") {
      // Don't abort the whole scan on one filter's failure — write what the
      // other filters returned rather than leaving a hole in the timeline.
      console.warn("GetServerList failed:", res.kind, filter);
      continue;
    }
    ok += 1;
    if (res.data.length === 10000) {
      console.error(
        `!!! GetServerList TRUNCATED at 10000 for filter ${filter} — ` +
          "results are incomplete, the query must be re-split !!!",
      );
    }
    servers.push(...res.data);
  }
  if (ok === 0) {
    console.warn("scan skipped: every GetServerList filter failed");
    return;
  }
  const scannedAt = new Date();
  scannedAt.setSeconds(0, 0);

  interface Bucket {
    map: string;
    region: number;
    official: boolean;
    serverCount: number;
    players: number;
    bots: number;
    capacity: number;
    tags: Record<TagKey, number>;
  }
  const zeroTags = (): Record<TagKey, number> => ({
    alltalk: 0,
    nocrits: 0,
    respawntimes: 0,
    maxplayers: 0,
    highlander: 0,
  });
  const agg = new Map<string, Bucket>();
  // Empty community servers, kept coarse (region only) to avoid per-map explosion.
  const empty = new Map<number, { region: number; servers: number; capacity: number }>();

  for (const s of servers) {
    const tags = (s.gametype ?? "").split(",");
    const official = tags.includes("valve");
    const humans = Math.max(0, s.players - s.bots);
    // Community server with no humans -> coarse empty aggregate. Valve servers
    // (and any populated server) go to the per-map buckets.
    if (!official && humans === 0) {
      const region = s.region ?? 255;
      const e = empty.get(region) ?? { region, servers: 0, capacity: 0 };
      e.servers += 1;
      e.capacity += s.max_players;
      empty.set(region, e);
      continue;
    }
    const map = s.map.toLowerCase().slice(0, 64);
    const region = s.region ?? 255;
    const key = `${map}|${region}|${official}`;
    const entry =
      agg.get(key) ??
      ({
        map,
        region,
        official,
        serverCount: 0,
        players: 0,
        bots: 0,
        capacity: 0,
        tags: zeroTags(),
      } satisfies Bucket);
    entry.serverCount += 1;
    entry.players += humans;
    entry.bots += s.bots;
    entry.capacity += s.max_players;
    for (const [key2, token] of Object.entries(TAG_FLAGS)) {
      if (tags.includes(token)) entry.tags[key2 as TagKey] += 1;
    }
    agg.set(key, entry);
  }

  const rows = [...agg.values()].map((r) => ({
    scannedAt,
    map: r.map,
    region: r.region,
    official: r.official,
    serverCount: r.serverCount,
    players: r.players,
    bots: r.bots,
    capacity: r.capacity,
    alltalkServers: r.tags.alltalk,
    nocritsServers: r.tags.nocrits,
    respawntimesServers: r.tags.respawntimes,
    maxplayersServers: r.tags.maxplayers,
    highlanderServers: r.tags.highlander,
  }));

  if (rows.length > 0) {
    for (let i = 0; i < rows.length; i += 1000) {
      await db
        .insert(schema.serverSnapshots)
        .values(rows.slice(i, i + 1000))
        .onConflictDoNothing();
    }
  }

  const emptyRows = [...empty.values()].map((e) => ({ scannedAt, ...e }));
  if (emptyRows.length > 0) {
    await db.insert(schema.serverEmptySnapshots).values(emptyRows).onConflictDoNothing();
  }

  // TF2's live global CCU — the ground-truth denominator for crawl coverage,
  // independent of the server scan. One extra API call per scan.
  const ccu = await steam.getCurrentPlayers();
  if (ccu.kind === "ok") {
    await db
      .insert(schema.populationSnapshots)
      .values({ scannedAt, currentPlayers: ccu.data })
      .onConflictDoNothing();
  }

  const totals = rows.reduce((a, r) => a + r.players, 0);
  const emptyCount = emptyRows.reduce((a, e) => a + e.servers, 0);
  console.log(
    `scan ${scannedAt.toISOString()}: ${servers.length} servers, ${totals} players, ` +
      `${rows.length} agg rows, ${emptyCount} empty community servers, ` +
      `ccu ${ccu.kind === "ok" ? ccu.data : ccu.kind}`,
  );
}

console.log("scanner started");
for (;;) {
  const start = Date.now();
  try {
    await scan();
    await flushMetrics(db);
  } catch (err) {
    console.error("scan failed:", err);
  }
  await Bun.sleep(Math.max(0, INTERVAL_MS - (Date.now() - start)));
}
