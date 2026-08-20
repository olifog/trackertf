import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "./db.ts";
import { asGamemodeKey, gamemodeExpr, type GamemodeKey } from "./servers.ts";

/**
 * How long casual matches actually take, per map and per gamemode, derived
 * from the sampler's match_segments (Postgres). A segment's span is a REAL
 * match length only when we witnessed BOTH ends: it closed on a true boundary
 * (score_reset / map_change) AND the immediately preceding segment on the same
 * server also closed on a boundary and flowed straight into it (contiguous
 * within a couple of sampling rounds). That pair condition means we saw the
 * match start (right after the previous match's boundary) and its end — so the
 * span isn't truncated by us starting to track mid-match. server_gone closes
 * are ambiguous and never counted. See apps/crawler/src/sampler.ts.
 *
 * Durations are aggregated in Postgres (percentile_cont) so only summary rows
 * cross the wire, never the raw per-match set.
 */

const num = (v: unknown): number => (v == null ? 0 : Number(v));

export interface DurationRow {
  /** map name for a per-map row; null for a gamemode-summary row */
  map: string | null;
  gamemode: GamemodeKey;
  matches: number;
  medianSec: number;
  p25Sec: number;
  p75Sec: number;
}

export interface MatchDurations {
  /** one row per gamemode (all maps of that mode pooled) */
  byGamemode: DurationRow[];
  /** one row per map with enough completed matches, most-sampled first */
  byMap: DurationRow[];
  /** total completed (both-ends-witnessed) matches in the window */
  totalMatches: number;
  windowDays: number;
}

const filters = z.object({
  days: z.number().int().min(1).max(30).catch(14).default(14),
  /** a map needs at least this many completed matches to get its own row */
  minMatches: z.number().int().min(1).max(50).catch(5).default(5),
});

export const fetchMatchDurations = createServerFn({ method: "GET" })
  .validator(filters)
  .handler(async ({ data }): Promise<MatchDurations> => {
    const db = getDb();
    // GROUPING SETS gives per-(gamemode,map) and per-gamemode rows in one pass;
    // grouping(map)=1 flags the gamemode-only summary rows.
    const rows = (await db.execute(sql`
      with ordered as (
        select server_steamid, map, started_at, ended_at, reason_closed,
          lag(reason_closed) over w as prev_reason,
          lag(ended_at) over w as prev_ended
        from match_segments
        where started_at > now() - make_interval(days => ${data.days})
          and observations >= 2
        window w as (partition by server_steamid order by started_at)
      ),
      full_matches as (
        select map, ${gamemodeExpr} as gamemode,
          extract(epoch from (ended_at - started_at))::float8 as dur_sec
        from ordered
        where reason_closed in ('score_reset', 'map_change')
          and prev_reason in ('score_reset', 'map_change')
          and prev_ended is not null
          and started_at - prev_ended < interval '9 minutes'
          and ended_at > started_at
      )
      select
        grouping(map) as is_gm,
        gamemode,
        map,
        count(*)::int as matches,
        percentile_cont(0.5) within group (order by dur_sec) as median_sec,
        percentile_cont(0.25) within group (order by dur_sec) as p25_sec,
        percentile_cont(0.75) within group (order by dur_sec) as p75_sec
      from full_matches
      group by grouping sets ((gamemode, map), (gamemode))
    `)) as unknown as Record<string, unknown>[];

    const byGamemode: DurationRow[] = [];
    const byMap: DurationRow[] = [];
    let totalMatches = 0;
    for (const r of rows) {
      const row: DurationRow = {
        map: r["is_gm"] === 1 || r["is_gm"] === true ? null : String(r["map"]),
        gamemode: asGamemodeKey(r["gamemode"]),
        matches: num(r["matches"]),
        medianSec: num(r["median_sec"]),
        p25Sec: num(r["p25_sec"]),
        p75Sec: num(r["p75_sec"]),
      };
      if (row.map === null) {
        byGamemode.push(row);
        totalMatches += row.matches;
      } else if (row.matches >= data.minMatches) {
        byMap.push(row);
      }
    }
    byGamemode.sort((a, b) => b.matches - a.matches);
    byMap.sort((a, b) => b.matches - a.matches);

    return { byGamemode, byMap, totalMatches, windowDays: data.days };
  });

export const matchDurationsQueryOptions = (days = 14, minMatches = 5) =>
  queryOptions({
    queryKey: ["matchDurations", days, minMatches],
    queryFn: () => fetchMatchDurations({ data: { days, minMatches } }),
  });
