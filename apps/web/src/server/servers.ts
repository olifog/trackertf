import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "./db.ts";

/**
 * Live + historical player counts derived from server_snapshots (Postgres):
 * 5-minute aggregates of GetServerList, one row per (scan, map, region,
 * official). "official" is the Valve casual/MvM matchmaking pool (the "valve"
 * gametype tag); everything else is community-hosted.
 */

export interface RegionRow {
  region: number;
  players: number;
  servers: number;
  officialPlayers: number;
  officialServers: number;
}

export interface MapRow {
  map: string;
  players: number;
  servers: number;
  officialPlayers: number;
}

export interface ServerTotals {
  players: number;
  bots: number;
  servers: number;
  officialPlayers: number;
  officialServers: number;
}

export interface ServerOverview {
  /** timestamp of the most recent scan, ISO; null before the scanner runs */
  scannedAt: string | null;
  totals: ServerTotals;
  byRegion: RegionRow[];
  byMap: MapRow[];
}

const ZERO_TOTALS: ServerTotals = {
  players: 0,
  bots: 0,
  servers: 0,
  officialPlayers: 0,
  officialServers: 0,
};

const num = (v: unknown): number => (v == null ? 0 : Number(v));

export const fetchServerOverview = createServerFn({ method: "GET" }).handler(
  async (): Promise<ServerOverview> => {
    const db = getDb();

    const [latest] = (await db.execute(
      sql`select max(scanned_at) t from server_snapshots`,
    )) as unknown as [{ t: string | Date | null } | undefined];
    const scannedAt = latest?.t ? new Date(latest.t).toISOString() : null;
    if (!scannedAt) return { scannedAt: null, totals: ZERO_TOTALS, byRegion: [], byMap: [] };

    // CTE pins the latest scan so the breakdowns can't straddle two scans.
    const byRegionRaw = (await db.execute(sql`
      with latest as (select max(scanned_at) t from server_snapshots)
      select region,
        sum(players)::int players,
        sum(server_count)::int servers,
        coalesce(sum(players) filter (where official), 0)::int official_players,
        coalesce(sum(server_count) filter (where official), 0)::int official_servers
      from server_snapshots, latest
      where scanned_at = latest.t
      group by region
      order by players desc
    `)) as unknown as Record<string, unknown>[];

    const byMapRaw = (await db.execute(sql`
      with latest as (select max(scanned_at) t from server_snapshots)
      select map,
        sum(players)::int players,
        sum(server_count)::int servers,
        coalesce(sum(players) filter (where official), 0)::int official_players
      from server_snapshots, latest
      where scanned_at = latest.t
      group by map
      order by players desc
      limit 30
    `)) as unknown as Record<string, unknown>[];

    const [totalsRaw] = (await db.execute(sql`
      with latest as (select max(scanned_at) t from server_snapshots)
      select
        sum(players)::int players,
        sum(bots)::int bots,
        sum(server_count)::int servers,
        coalesce(sum(players) filter (where official), 0)::int official_players,
        coalesce(sum(server_count) filter (where official), 0)::int official_servers
      from server_snapshots, latest
      where scanned_at = latest.t
    `)) as unknown as [Record<string, unknown> | undefined];

    return {
      scannedAt,
      totals: {
        players: num(totalsRaw?.["players"]),
        bots: num(totalsRaw?.["bots"]),
        servers: num(totalsRaw?.["servers"]),
        officialPlayers: num(totalsRaw?.["official_players"]),
        officialServers: num(totalsRaw?.["official_servers"]),
      },
      byRegion: byRegionRaw.map((r) => ({
        region: num(r["region"]),
        players: num(r["players"]),
        servers: num(r["servers"]),
        officialPlayers: num(r["official_players"]),
        officialServers: num(r["official_servers"]),
      })),
      byMap: byMapRaw.map((r) => ({
        map: String(r["map"]),
        players: num(r["players"]),
        servers: num(r["servers"]),
        officialPlayers: num(r["official_players"]),
      })),
    };
  },
);

export const serverOverviewQueryOptions = () =>
  queryOptions({ queryKey: ["serverOverview"], queryFn: () => fetchServerOverview() });

export interface TrendPoint {
  /** bucket time, unix seconds */
  t: number;
  players: number;
  official: number;
}

export const trendRangeSchema = z.enum(["24h", "7d"]);
export type TrendRange = z.infer<typeof trendRangeSchema>;

export const fetchServerTrend = createServerFn({ method: "GET" })
  .validator(z.object({ range: trendRangeSchema.catch("24h") }))
  .handler(async ({ data }): Promise<TrendPoint[]> => {
    const db = getDb();
    // 24h: raw 5-minute scan totals. 7d: hourly, averaging the per-scan totals
    // within each hour so both ranges stay on the same "concurrent players"
    // scale rather than summing scans together.
    const rows =
      data.range === "24h"
        ? ((await db.execute(sql`
            select extract(epoch from scanned_at)::bigint t,
              sum(players)::int players,
              coalesce(sum(players) filter (where official), 0)::int official
            from server_snapshots
            where scanned_at > now() - interval '24 hours'
            group by scanned_at
            order by scanned_at
          `)) as unknown as Record<string, unknown>[])
        : ((await db.execute(sql`
            select extract(epoch from bucket)::bigint t,
              round(avg(total))::int players,
              round(avg(off))::int official
            from (
              select date_trunc('hour', scanned_at) bucket,
                sum(players) total,
                coalesce(sum(players) filter (where official), 0) off
              from server_snapshots
              where scanned_at > now() - interval '7 days'
              group by scanned_at
            ) s
            group by bucket
            order by bucket
          `)) as unknown as Record<string, unknown>[]);

    return rows.map((r) => ({
      t: num(r["t"]),
      players: num(r["players"]),
      official: num(r["official"]),
    }));
  });

export const serverTrendQueryOptions = (range: TrendRange) =>
  queryOptions({
    queryKey: ["serverTrend", range],
    queryFn: () => fetchServerTrend({ data: { range } }),
  });
