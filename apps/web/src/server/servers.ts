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
  official: number;
  community: number;
}

export interface ServerTotals {
  players: number;
  bots: number;
  servers: number;
  officialPlayers: number;
  officialServers: number;
  /** sum of max_players across populated servers (seat capacity) */
  capacity: number;
  /** empty community servers in the latest scan (Valve empties are unmeasurable) */
  emptyCommunityServers: number;
}

/** Count of populated servers carrying a given gametype tag, latest scan. */
export interface TagStat {
  key: string;
  count: number;
}

/** Community players grouped into a real continent (Valve/SDR excluded). */
export interface ContinentRow {
  continent: string;
  players: number;
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
  /** gametype-tag prevalence across populated servers (mostly community) */
  tags: TagStat[];
  /** community players by continent (real region codes only; SDR excluded) */
  byContinent: ContinentRow[];
}

const ZERO_TOTALS: ServerTotals = {
  players: 0,
  bots: 0,
  servers: 0,
  officialPlayers: 0,
  officialServers: 0,
  capacity: 0,
  emptyCommunityServers: 0,
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
        tags: [],
        byContinent: [],
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

    // Rush hour: average concurrent players per hour-of-day over the trailing
    // 7 days, split official vs community. Inner query totals each scan so the
    // outer average is over scans (concurrent players), not a sum of scans.
    const rushHourRaw = (await db.execute(sql`
      select hr,
        round(avg(off))::int official,
        round(avg(comm))::int community
      from (
        select extract(hour from scanned_at at time zone 'UTC')::int hr,
          scanned_at,
          coalesce(sum(players) filter (where official), 0) off,
          coalesce(sum(players) filter (where not official), 0) comm
        from server_snapshots
        where scanned_at > now() - interval '7 days'
        group by scanned_at
      ) s
      group by hr
      order by hr
    `)) as unknown as Record<string, unknown>[];

    const [totalsRaw] = (await db.execute(sql`
      with latest as (select max(scanned_at) t from server_snapshots)
      select
        sum(players)::int players,
        sum(bots)::int bots,
        sum(server_count)::int servers,
        coalesce(sum(players) filter (where official), 0)::int official_players,
        coalesce(sum(server_count) filter (where official), 0)::int official_servers,
        coalesce(sum(capacity), 0)::int capacity,
        coalesce(sum(alltalk_servers), 0)::int alltalk,
        coalesce(sum(nocrits_servers), 0)::int nocrits,
        coalesce(sum(respawntimes_servers), 0)::int respawntimes,
        coalesce(sum(maxplayers_servers), 0)::int maxplayers,
        coalesce(sum(highlander_servers), 0)::int highlander
      from server_snapshots, latest
      where scanned_at = latest.t
    `)) as unknown as [Record<string, unknown> | undefined];

    // Empty community servers: their own table (Valve empties excluded — the
    // master list truncates to 10k phantom reservations, so no true count).
    const [emptyRaw] = (await db.execute(sql`
      with latest as (select max(scanned_at) t from server_empty_snapshots)
      select coalesce(sum(servers), 0)::int servers
      from server_empty_snapshots, latest
      where scanned_at = latest.t
    `)) as unknown as [Record<string, unknown> | undefined];

    // Community players by continent — only real region codes (0-7). Valve
    // casual is SDR-hidden (region 255) and cannot be geolocated, so it's
    // deliberately excluded rather than dumped into a fake "World" bucket.
    const byContinentRaw = (await db.execute(sql`
      with latest as (select max(scanned_at) t from server_snapshots)
      select
        case region
          when 0 then 'North America' when 1 then 'North America'
          when 2 then 'South America' when 3 then 'Europe'
          when 4 then 'Asia' when 5 then 'Oceania'
          when 6 then 'Middle East' when 7 then 'Africa'
        end continent,
        sum(players)::int players
      from server_snapshots, latest
      where scanned_at = latest.t and official = false and region between 0 and 7
      group by continent
      order by players desc
    `)) as unknown as Record<string, unknown>[];

    const tags: TagStat[] = [
      { key: "alltalk", count: num(totalsRaw?.["alltalk"]) },
      { key: "nocrits", count: num(totalsRaw?.["nocrits"]) },
      { key: "respawntimes", count: num(totalsRaw?.["respawntimes"]) },
      { key: "maxplayers", count: num(totalsRaw?.["maxplayers"]) },
      { key: "highlander", count: num(totalsRaw?.["highlander"]) },
    ];

    return {
      scannedAt,
      totals: {
        players: num(totalsRaw?.["players"]),
        bots: num(totalsRaw?.["bots"]),
        servers: num(totalsRaw?.["servers"]),
        officialPlayers: num(totalsRaw?.["official_players"]),
        officialServers: num(totalsRaw?.["official_servers"]),
        capacity: num(totalsRaw?.["capacity"]),
        emptyCommunityServers: num(emptyRaw?.["servers"]),
      },
      tags,
      byContinent: byContinentRaw
        .filter((r) => r["continent"] != null)
        .map((r) => ({ continent: String(r["continent"]), players: num(r["players"]) })),
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
        hour: num(r["hr"]),
        official: num(r["official"]),
        community: num(r["community"]),
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
