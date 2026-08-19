import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "./db.ts";

/**
 * Live + historical player counts derived from server_snapshots (Postgres):
 * 5-minute aggregates of GetServerList, one row per (scan, map, region,
 * official). "official" is the Valve casual/MvM matchmaking pool (the "valve"
 * gametype tag); everything else is community-hosted. Empty official rows are
 * kept by the scanner; empty community rows are dropped at scan time.
 */

/**
 * Gamemode is derived from the map-name prefix. The scanner lowercases maps, so
 * these comparisons are already case-folded. Keys are stable identifiers used
 * as chart series keys; labels live in the page. `plr_`/`tc_`/`sd_`/`arena_`/…
 * and all community maps fold into "other" to keep the charts legible.
 */
export const GAMEMODE_KEYS = [
  "payload",
  "cp",
  "koth",
  "ctf",
  "mvm",
  "pd",
  "other",
] as const;
export type GamemodeKey = (typeof GAMEMODE_KEYS)[number];

/** SQL expression mapping the `map` column to a GamemodeKey. */
const gamemodeExpr = sql`case
  when left(map, 4) = 'plr_' then 'other'
  when left(map, 3) = 'pl_'  then 'payload'
  when left(map, 5) = 'koth_' then 'koth'
  when left(map, 4) = 'ctf_' then 'ctf'
  when left(map, 3) = 'cp_'  then 'cp'
  when left(map, 4) = 'mvm_' then 'mvm'
  when left(map, 3) = 'pd_'  then 'pd'
  else 'other'
end`;

function asGamemodeKey(v: unknown): GamemodeKey {
  return (GAMEMODE_KEYS as readonly string[]).includes(String(v))
    ? (String(v) as GamemodeKey)
    : "other";
}

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

export interface GamemodeRow {
  gamemode: GamemodeKey;
  players: number;
  servers: number;
}

export interface RushHourPoint {
  /** hour of day, 0-23, UTC */
  hour: number;
  players: number;
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
  byGamemode: GamemodeRow[];
  /** average concurrent players per UTC hour over the trailing 7 days */
  rushHour: RushHourPoint[];
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
    if (!scannedAt) {
      return {
        scannedAt: null,
        totals: ZERO_TOTALS,
        byRegion: [],
        byMap: [],
        byGamemode: [],
        rushHour: [],
      };
    }

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

    const byGamemodeRaw = (await db.execute(sql`
      with latest as (select max(scanned_at) t from server_snapshots)
      select ${gamemodeExpr} gm,
        sum(players)::int players,
        sum(server_count)::int servers
      from server_snapshots, latest
      where scanned_at = latest.t
      group by gm
      order by players desc
    `)) as unknown as Record<string, unknown>[];

    const rushHourRaw = (await db.execute(sql`
      select extract(hour from scanned_at)::int as hour,
        round(avg(p))::int players
      from (
        select scanned_at, sum(players) p
        from server_snapshots
        where scanned_at > now() - interval '7 days'
        group by scanned_at
      ) s
      group by 1
      order by 1
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
      byGamemode: byGamemodeRaw.map((r) => ({
        gamemode: asGamemodeKey(r["gm"]),
        players: num(r["players"]),
        servers: num(r["servers"]),
      })),
      rushHour: rushHourRaw.map((r) => ({
        hour: num(r["hour"]),
        players: num(r["players"]),
      })),
    };
  },
);

export const serverOverviewQueryOptions = () =>
  queryOptions({ queryKey: ["serverOverview"], queryFn: () => fetchServerOverview() });

/** One time bucket of the trend, with concurrent players split by gamemode. */
export interface TrendPoint {
  /** bucket time, unix seconds */
  t: number;
  payload: number;
  cp: number;
  koth: number;
  ctf: number;
  mvm: number;
  pd: number;
  other: number;
  total: number;
  official: number;
}

export const trendRangeSchema = z.enum(["24h", "7d", "14d"]);
export type TrendRange = z.infer<typeof trendRangeSchema>;

const RANGE_INTERVAL: Record<TrendRange, string> = {
  "24h": "24 hours",
  "7d": "7 days",
  "14d": "14 days",
};

export const fetchServerTrend = createServerFn({ method: "GET" })
  .validator(z.object({ range: trendRangeSchema.catch("24h") }))
  .handler(async ({ data }): Promise<TrendPoint[]> => {
    const db = getDb();
    const interval = RANGE_INTERVAL[data.range];
    // 24h: raw 5-minute scans. 7d/14d: hourly, averaging the per-scan totals
    // within each hour so every range stays on the same "concurrent players"
    // scale rather than summing scans together. Each row is one (bucket,
    // gamemode) pair carrying that gamemode's players plus, redundantly, the
    // scan's official split (summed once per bucket after the pivot).
    const rows =
      data.range === "24h"
        ? ((await db.execute(sql`
            select extract(epoch from scanned_at)::bigint t,
              ${gamemodeExpr} gm,
              sum(players)::int players,
              coalesce(sum(players) filter (where official), 0)::int official
            from server_snapshots
            where scanned_at > now() - interval '24 hours'
            group by scanned_at, gm
            order by scanned_at
          `)) as unknown as Record<string, unknown>[])
        : ((await db.execute(sql`
            select extract(epoch from bucket)::bigint t, gm,
              round(avg(players))::int players,
              round(avg(official))::int official
            from (
              select date_trunc('hour', scanned_at) bucket, scanned_at,
                ${gamemodeExpr} gm,
                sum(players) players,
                coalesce(sum(players) filter (where official), 0) official
              from server_snapshots
              where scanned_at > now() - interval '${sql.raw(interval)}'
              group by bucket, scanned_at, gm
            ) s
            group by bucket, gm
            order by bucket
          `)) as unknown as Record<string, unknown>[]);

    // Pivot the long (bucket, gamemode) rows into one wide point per bucket.
    const byT = new Map<number, TrendPoint>();
    for (const r of rows) {
      const t = num(r["t"]);
      let pt = byT.get(t);
      if (!pt) {
        pt = {
          t,
          payload: 0,
          cp: 0,
          koth: 0,
          ctf: 0,
          mvm: 0,
          pd: 0,
          other: 0,
          total: 0,
          official: 0,
        };
        byT.set(t, pt);
      }
      const gm = asGamemodeKey(r["gm"]);
      const players = num(r["players"]);
      pt[gm] += players;
      pt.total += players;
      // `official` is the official-player count for THIS gamemode row, so sum
      // it across the bucket's gamemode rows to get total official players.
      pt.official += num(r["official"]);
    }
    return [...byT.values()].sort((a, b) => a.t - b.t);
  });

export const serverTrendQueryOptions = (range: TrendRange) =>
  queryOptions({
    queryKey: ["serverTrend", range],
    queryFn: () => fetchServerTrend({ data: { range } }),
  });
