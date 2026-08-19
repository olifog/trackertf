import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "./db.ts";

/**
 * TF2 ecosystem overview — high-level playerbase and live-server stats derived
 * entirely from Postgres:
 *   - `players`            the crawled player corpus (playtime, active-2wk)
 *   - `server_snapshots`   5-minute GetServerList aggregates (players/servers
 *                          per map+region+official)
 *   - `player_class_stats` parsed per-class lifetime accumulators
 *
 * Gamemode is derived from the map-name prefix (pl_/koth_/cp_/ctf_/mvm_/…),
 * the only signal GetServerList exposes. This classifier is intentionally
 * self-contained (the /servers page keeps its own).
 */

const num = (v: unknown): number => (v == null ? 0 : Number(v));

/** ordered gamemode keys — also the stacked-area series order */
export const GAMEMODES = [
  "payload",
  "koth",
  "controlPoint",
  "ctf",
  "mvm",
  "other",
] as const;
export type Gamemode = (typeof GAMEMODES)[number];

/**
 * Map first-token → gamemode bucket. Kept identical in SQL (below) and here so
 * server aggregation and any client-side reuse agree.
 */
const PREFIX_TO_GAMEMODE: Record<string, Gamemode> = {
  pl: "payload",
  plr: "payload",
  koth: "koth",
  cp: "controlPoint",
  tc: "controlPoint",
  ctf: "ctf",
  mvm: "mvm",
};

export function gamemodeOf(map: string): Gamemode {
  const prefix = map.split("_")[0] ?? "";
  return PREFIX_TO_GAMEMODE[prefix] ?? "other";
}

// Postgres CASE mirroring PREFIX_TO_GAMEMODE, applied to the `map` column.
const GM_CASE = sql`case split_part(map, '_', 1)
    when 'pl' then 'payload'
    when 'plr' then 'payload'
    when 'koth' then 'koth'
    when 'cp' then 'controlPoint'
    when 'tc' then 'controlPoint'
    when 'ctf' then 'ctf'
    when 'mvm' then 'mvm'
    else 'other'
  end`;

export interface GamemodeSlice {
  gamemode: Gamemode;
  players: number;
  servers: number;
}

export interface HourBucket {
  /** hour of day, 0-23 (UTC) */
  hour: number;
  official: number;
  community: number;
}

export interface ClassSlice {
  classNum: number;
  playtimeHours: number;
  kills: number;
  players: number;
}

export interface EcosystemOverview {
  scannedAt: string | null;
  /** playerbase corpus */
  playersTracked: number;
  activePlayers2wk: number;
  totalTrackedHours: number;
  /** most-recent scan */
  livePlayers: number;
  liveServers: number;
  officialPlayers: number;
  officialServers: number;
  byGamemode: GamemodeSlice[];
  rushHour: HourBucket[];
  byClass: ClassSlice[];
}

const EMPTY: EcosystemOverview = {
  scannedAt: null,
  playersTracked: 0,
  activePlayers2wk: 0,
  totalTrackedHours: 0,
  livePlayers: 0,
  liveServers: 0,
  officialPlayers: 0,
  officialServers: 0,
  byGamemode: [],
  rushHour: [],
  byClass: [],
};

export const fetchEcosystemOverview = createServerFn({ method: "GET" }).handler(
  async (): Promise<EcosystemOverview> => {
    const db = getDb();

    const [corpus] = (await db.execute(sql`
      select count(*)::int total,
        count(*) filter (where tf2_minutes_2wk > 0)::int active,
        coalesce(sum(tf2_minutes), 0)::bigint minutes
      from players
    `)) as unknown as [Record<string, unknown> | undefined];

    const [latest] = (await db.execute(
      sql`select max(scanned_at) t from server_snapshots`,
    )) as unknown as [{ t: string | Date | null } | undefined];
    const scannedAt = latest?.t ? new Date(latest.t).toISOString() : null;

    const playersTracked = num(corpus?.["total"]);
    const activePlayers2wk = num(corpus?.["active"]);
    const totalTrackedHours = Math.round(num(corpus?.["minutes"]) / 60);

    // Per-class lifetime accumulators — "which classes get played".
    const classRaw = (await db.execute(sql`
      select class_num,
        coalesce(sum(playtime_seconds), 0)::bigint secs,
        coalesce(sum(kills), 0)::bigint kills,
        count(*)::int players
      from player_class_stats
      group by class_num
      order by class_num
    `)) as unknown as Record<string, unknown>[];
    const byClass: ClassSlice[] = classRaw.map((r) => ({
      classNum: num(r["class_num"]),
      playtimeHours: Math.round(num(r["secs"]) / 3600),
      kills: num(r["kills"]),
      players: num(r["players"]),
    }));

    if (!scannedAt) {
      return {
        ...EMPTY,
        playersTracked,
        activePlayers2wk,
        totalTrackedHours,
        byClass,
      };
    }

    const [totals] = (await db.execute(sql`
      with latest as (select max(scanned_at) t from server_snapshots)
      select coalesce(sum(players), 0)::int players,
        coalesce(sum(server_count), 0)::int servers,
        coalesce(sum(players) filter (where official), 0)::int off_players,
        coalesce(sum(server_count) filter (where official), 0)::int off_servers
      from server_snapshots, latest
      where scanned_at = latest.t
    `)) as unknown as [Record<string, unknown> | undefined];

    const gmRaw = (await db.execute(sql`
      with latest as (select max(scanned_at) t from server_snapshots)
      select ${GM_CASE} gm,
        sum(players)::int players,
        sum(server_count)::int servers
      from server_snapshots, latest
      where scanned_at = latest.t
      group by gm
    `)) as unknown as Record<string, unknown>[];
    const gmMap = new Map(gmRaw.map((r) => [String(r["gm"]), r]));
    const byGamemode: GamemodeSlice[] = GAMEMODES.map((gamemode) => {
      const r = gmMap.get(gamemode);
      return {
        gamemode,
        players: num(r?.["players"]),
        servers: num(r?.["servers"]),
      };
    }).filter((g) => g.players > 0 || g.servers > 0);

    // Rush hour: average concurrent players per hour-of-day over the last 7d,
    // split official vs community. Inner query totals each scan so the outer
    // average is over scans (concurrent players), not a sum of scans.
    const rushRaw = (await db.execute(sql`
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
    const rushHour: HourBucket[] = rushRaw.map((r) => ({
      hour: num(r["hr"]),
      official: num(r["official"]),
      community: num(r["community"]),
    }));

    return {
      scannedAt,
      playersTracked,
      activePlayers2wk,
      totalTrackedHours,
      livePlayers: num(totals?.["players"]),
      liveServers: num(totals?.["servers"]),
      officialPlayers: num(totals?.["off_players"]),
      officialServers: num(totals?.["off_servers"]),
      byGamemode,
      rushHour,
      byClass,
    };
  },
);

export const ecosystemOverviewQueryOptions = () =>
  queryOptions({
    queryKey: ["ecosystemOverview"],
    queryFn: () => fetchEcosystemOverview(),
  });

export interface GamemodeTrendPoint {
  /** bucket time, unix seconds */
  t: number;
  payload: number;
  koth: number;
  controlPoint: number;
  ctf: number;
  mvm: number;
  other: number;
}

export const trendRangeSchema = z.enum(["7d", "14d"]);
export type TrendRange = z.infer<typeof trendRangeSchema>;

/**
 * Concurrent players by gamemode over time. Hourly buckets; within each bucket
 * we average the per-scan per-gamemode totals so the y-axis stays "concurrent
 * players" rather than summing the ~12 scans/hour together.
 */
export const fetchGamemodeTrend = createServerFn({ method: "GET" })
  .validator(z.object({ range: trendRangeSchema.catch("7d") }))
  .handler(async ({ data }): Promise<GamemodeTrendPoint[]> => {
    const db = getDb();
    const interval = data.range === "14d" ? sql`interval '14 days'` : sql`interval '7 days'`;

    const rows = (await db.execute(sql`
      select extract(epoch from bucket)::bigint t, gm, round(avg(p))::int players
      from (
        select date_trunc('hour', scanned_at) bucket,
          scanned_at,
          ${GM_CASE} gm,
          sum(players) p
        from server_snapshots
        where scanned_at > now() - ${interval}
        group by scanned_at, gm
      ) s
      group by bucket, gm
      order by bucket
    `)) as unknown as Record<string, unknown>[];

    const buckets = new Map<number, GamemodeTrendPoint>();
    for (const r of rows) {
      const t = num(r["t"]);
      let point = buckets.get(t);
      if (!point) {
        point = { t, payload: 0, koth: 0, controlPoint: 0, ctf: 0, mvm: 0, other: 0 };
        buckets.set(t, point);
      }
      const gm = String(r["gm"]) as Gamemode;
      if (gm in point) point[gm] = num(r["players"]);
    }
    return [...buckets.values()].sort((a, b) => a.t - b.t);
  });

export const gamemodeTrendQueryOptions = (range: TrendRange) =>
  queryOptions({
    queryKey: ["gamemodeTrend", range],
    queryFn: () => fetchGamemodeTrend({ data: { range } }),
  });
