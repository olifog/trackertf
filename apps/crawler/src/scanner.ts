/**
 * Server scanner: GetServerList every 5 minutes → per-(map, region, official)
 * aggregates in server_snapshots. ~288 API calls/day. Valve MM servers are
 * detected via the "valve" gametype tag (SDR-hidden, hence region from the
 * master list rather than IP).
 */
import { createDbFromEnv, schema } from "@trackertf/db";
import { SteamClient } from "@trackertf/steam";
import { flushMetrics, record } from "./metrics.ts";

const apiKey = process.env["STEAM_API_KEY"];
if (!apiKey) throw new Error("STEAM_API_KEY is not set");

const db = createDbFromEnv();
const steam = new SteamClient({ apiKey, ratePerSecond: 1, onResult: record });
const INTERVAL_MS = 5 * 60_000;

async function scan(): Promise<void> {
  const res = await steam.getServerList("\\appid\\440", 50000);
  if (res.kind !== "ok") {
    console.warn("GetServerList failed:", res.kind);
    return;
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
  for (const s of res.data) {
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
    `scan ${scannedAt.toISOString()}: ${res.data.length} servers, ${totals} players, ${rows.length} agg rows`,
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
