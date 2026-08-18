import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { chQuery } from "@trackertf/clickhouse";
import { z } from "zod";
import { getCh } from "./ch.ts";

/**
 * Observed casual matches, from ClickHouse `match_obs` (one row per player
 * NAME seen within a sampler match segment). The sampler only ever queries
 * gametype "valve" servers, so these rates are the real observed scoring pace
 * on casual and cannot be inflated on community point-farm servers.
 *
 * Observed points/hour for a participant is derived here, never stored:
 *   (last_score - first_score) * 3600 / (last_seen - first_seen)
 * guarded to require >= 2 observations and a positive time window. This is a
 * DIRECT observation, distinct from (and not farmable like) Valve lifetime
 * stats. `name` is an in-game display name only, not a linked Steam profile.
 */

const num = (v: unknown): number => (v == null ? 0 : Number(v));

export interface SegmentRow {
  segmentId: string;
  map: string;
  region: number;
  /** unix seconds */
  startedAt: number;
  endedAt: number;
  durationSec: number;
  participants: number;
  /** sampling rounds folded into the segment (max per-participant observations) */
  rounds: number;
}

export const fetchRecentSegments = createServerFn({ method: "GET" })
  .validator(z.object({ limit: z.number().int().min(1).max(200).catch(80) }))
  .handler(async ({ data }): Promise<SegmentRow[]> => {
    const rows = await chQuery<Record<string, unknown>>(
      getCh(),
      `select toString(segment_id) as segment_id,
        any(map) as map,
        any(region) as region,
        toUnixTimestamp(any(started_at)) as started_at,
        toUnixTimestamp(max(last_seen)) as ended_at,
        toUInt32(count()) as participants,
        toUInt32(max(observations)) as rounds
      from match_obs
      group by segment_id
      order by started_at desc
      limit {limit:UInt32}`,
      { limit: data.limit },
    );
    return rows.map((r: Record<string, unknown>) => {
      const startedAt = num(r["started_at"]);
      const endedAt = num(r["ended_at"]);
      return {
        segmentId: String(r["segment_id"]),
        map: String(r["map"]),
        region: num(r["region"]),
        startedAt,
        endedAt,
        durationSec: Math.max(0, endedAt - startedAt),
        participants: num(r["participants"]),
        rounds: num(r["rounds"]),
      };
    });
  });

export const recentSegmentsQueryOptions = (limit = 80) =>
  queryOptions({
    queryKey: ["matchSegments", limit],
    queryFn: () => fetchRecentSegments({ data: { limit } }),
  });

export interface Participant {
  name: string;
  /** unix seconds */
  firstSeen: number;
  lastSeen: number;
  firstScore: number;
  lastScore: number;
  maxScore: number;
  firstTimePlayed: number;
  lastTimePlayed: number;
  observations: number;
  windowSec: number;
  /** observed points/hour, or null when the window is too thin to trust */
  pointsPerHour: number | null;
}

export interface SegmentDetail {
  segmentId: string;
  map: string;
  region: number;
  startedAt: number;
  endedAt: number;
  participants: Participant[];
}

/** derive observed points/hour with the divide-by-zero + min-observation guards */
function pointsPerHour(p: {
  firstScore: number;
  lastScore: number;
  windowSec: number;
  observations: number;
}): number | null {
  if (p.observations < 2 || p.windowSec <= 0) return null;
  return ((p.lastScore - p.firstScore) * 3600) / p.windowSec;
}

export const fetchSegment = createServerFn({ method: "GET" })
  .validator(z.object({ segmentId: z.string().regex(/^\d+$/) }))
  .handler(async ({ data }): Promise<SegmentDetail | null> => {
    const rows = await chQuery<Record<string, unknown>>(
      getCh(),
      `select name,
        any(map) over () as map,
        any(region) over () as region,
        toUnixTimestamp(started_at) as started_at,
        toUnixTimestamp(first_seen) as first_seen,
        toUnixTimestamp(last_seen) as last_seen,
        first_score, last_score, max_score,
        first_time_played, last_time_played, observations
      from match_obs
      where segment_id = {segmentId:UInt64}`,
      { segmentId: data.segmentId },
    );
    if (rows.length === 0) return null;

    const participants: Participant[] = rows.map((r: Record<string, unknown>) => {
      const firstSeen = num(r["first_seen"]);
      const lastSeen = num(r["last_seen"]);
      const windowSec = Math.max(0, lastSeen - firstSeen);
      const firstScore = num(r["first_score"]);
      const lastScore = num(r["last_score"]);
      const observations = num(r["observations"]);
      return {
        name: String(r["name"]),
        firstSeen,
        lastSeen,
        firstScore,
        lastScore,
        maxScore: num(r["max_score"]),
        firstTimePlayed: num(r["first_time_played"]),
        lastTimePlayed: num(r["last_time_played"]),
        observations,
        windowSec,
        pointsPerHour: pointsPerHour({ firstScore, lastScore, windowSec, observations }),
      };
    });
    // rank by observed pts/hour; unrankable (thin-window) rows sink to the end
    participants.sort((a, b) => (b.pointsPerHour ?? -1) - (a.pointsPerHour ?? -1));

    const first = rows[0] as Record<string, unknown>;
    return {
      segmentId: data.segmentId,
      map: String(first["map"]),
      region: num(first["region"]),
      startedAt: num(first["started_at"]),
      endedAt: Math.max(...participants.map((p) => p.lastSeen)),
      participants,
    };
  });

export const segmentQueryOptions = (segmentId: string) =>
  queryOptions({
    queryKey: ["matchSegment", segmentId],
    queryFn: () => fetchSegment({ data: { segmentId } }),
  });

export interface LeaderRow {
  name: string;
  segmentId: string;
  map: string;
  region: number;
  startedAt: number;
  firstScore: number;
  lastScore: number;
  maxScore: number;
  observations: number;
  windowSec: number;
  pointsPerHour: number;
}

export const matchLeaderFiltersSchema = z.object({
  /** only segments started within the last N days */
  days: z.number().int().min(1).max(14).catch(3).default(3),
  /** minimum sampling observations per participant */
  minObs: z.number().int().min(2).max(20).catch(3).default(3),
  /** minimum observed window, minutes */
  minWindowMin: z.number().int().min(0).max(60).catch(5).default(5),
});
export type MatchLeaderFilters = z.infer<typeof matchLeaderFiltersSchema>;

/**
 * Top observed points/hour across recent segments — "who actually scores
 * fastest on casual right now". Requires a real observation window so a single
 * lucky sample can't top the board. Names are display names only.
 */
export const fetchMatchLeaderboard = createServerFn({ method: "GET" })
  .validator(matchLeaderFiltersSchema)
  .handler(async ({ data }): Promise<LeaderRow[]> => {
    const rows = await chQuery<Record<string, unknown>>(
      getCh(),
      `select name,
        toString(segment_id) as segment_id,
        map, region,
        toUnixTimestamp(started_at) as started_at,
        first_score, last_score, max_score, observations,
        (toUnixTimestamp(last_seen) - toUnixTimestamp(first_seen)) as window_sec,
        (last_score - first_score) * 3600.0
          / (toUnixTimestamp(last_seen) - toUnixTimestamp(first_seen)) as pph
      from match_obs
      where observations >= {minObs:UInt16}
        and last_seen > first_seen
        and (toUnixTimestamp(last_seen) - toUnixTimestamp(first_seen)) >= {minWin:UInt32}
        and last_score >= first_score
        and started_at > now() - toIntervalDay({days:UInt16})
      order by pph desc
      limit 100`,
      { minObs: data.minObs, minWin: data.minWindowMin * 60, days: data.days },
    );
    return rows.map((r: Record<string, unknown>) => ({
      name: String(r["name"]),
      segmentId: String(r["segment_id"]),
      map: String(r["map"]),
      region: num(r["region"]),
      startedAt: num(r["started_at"]),
      firstScore: num(r["first_score"]),
      lastScore: num(r["last_score"]),
      maxScore: num(r["max_score"]),
      observations: num(r["observations"]),
      windowSec: num(r["window_sec"]),
      pointsPerHour: num(r["pph"]),
    }));
  });

export const matchLeaderboardQueryOptions = (filters: MatchLeaderFilters) =>
  queryOptions({
    queryKey: ["matchLeaderboard", filters],
    queryFn: () => fetchMatchLeaderboard({ data: filters }),
  });
