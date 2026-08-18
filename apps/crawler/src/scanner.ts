/**
 * Server scanner: GetServerList every 5 minutes → per-(map, region, official)
 * aggregates in server_snapshots. ~576 API calls/day (2 per scan). Valve MM
 * servers are detected via the "valve" gametype tag (SDR-hidden, hence region
 * from the master list rather than IP).
 *
 * GetServerList truncates at exactly 10,000 results and TF2 has more servers
 * than that, so each scan runs two disjoint queries (valve / non-valve
 * gametype) and merges them. If either half ever hits the 10k cap it must be
 * re-split further — the loud warning below is the tripwire.
 */
import { createDbFromEnv, schema } from "@trackertf/db";
import { SteamClient } from "@trackertf/steam";
import { flushMetrics, record } from "./metrics.ts";

const apiKey = process.env["STEAM_API_KEY"];
if (!apiKey) throw new Error("STEAM_API_KEY is not set");

const db = createDbFromEnv();
const steam = new SteamClient({ apiKey, ratePerSecond: 1, onResult: record });
const INTERVAL_MS = 5 * 60_000;

const SCAN_FILTERS = ["\\appid\\440\\gametype\\valve", "\\appid\\440\\nor\\1\\gametype\\valve"];

async function scan(): Promise<void> {
  const servers = [];
  for (const filter of SCAN_FILTERS) {
    const res = await steam.getServerList(filter, 50000);
    if (res.kind !== "ok") {
      console.warn("GetServerList failed:", res.kind, filter);
      return;
    }
    if (res.data.length === 10000) {
      console.error(
        `!!! GetServerList TRUNCATED at 10000 for filter ${filter} — ` +
          "results are incomplete, the query must be re-split !!!",
      );
    }
    servers.push(...res.data);
  }
  const scannedAt = new Date();
  scannedAt.setSeconds(0, 0);

  const agg = new Map<
    string,
    {
      map: string;
      region: number;
      official: boolean;
      serverCount: number;
      players: number;
      bots: number;
    }
  >();
  for (const s of servers) {
    const official = (s.gametype ?? "").split(",").includes("valve");
    const map = s.map.toLowerCase().slice(0, 64);
    const region = s.region ?? 255;
    const key = `${map}|${region}|${official}`;
    const entry = agg.get(key) ?? { map, region, official, serverCount: 0, players: 0, bots: 0 };
    entry.serverCount += 1;
    entry.players += Math.max(0, s.players - s.bots);
    entry.bots += s.bots;
    agg.set(key, entry);
  }

  // keep volume sane: drop empty community map rows (dead server spam)
  const rows = [...agg.values()]
    .filter((r) => r.official || r.players > 0)
    .map((r) => ({ scannedAt, ...r }));

  if (rows.length > 0) {
    for (let i = 0; i < rows.length; i += 1000) {
      await db
        .insert(schema.serverSnapshots)
        .values(rows.slice(i, i + 1000))
        .onConflictDoNothing();
    }
  }
  const totals = rows.reduce((a, r) => a + r.players, 0);
  console.log(
    `scan ${scannedAt.toISOString()}: ${servers.length} servers, ${totals} players, ${rows.length} agg rows`,
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
