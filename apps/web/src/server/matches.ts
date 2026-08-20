import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { chQuery } from "@trackertf/clickhouse";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { getCh } from "./ch.ts";
import { getDb } from "./db.ts";

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
      // Bound the scan by the table's sort-key prefix (started_at): grouping the
      // full, ever-growing match_obs before ordering meant the cost climbed with
      // history even though we only ever show the newest N. 30 days always
      // covers the display window (max 200 rows, days filter ≤ 14 elsewhere).
      `select toString(segment_id) as segment_id,
        any(map) as map,
        any(region) as region,
        toUnixTimestamp(any(started_at)) as started_at,
        toUnixTimestamp(max(last_seen)) as ended_at,
        toUInt32(count()) as participants,
        toUInt32(max(observations)) as rounds
      from match_obs
      where started_at > now() - toIntervalDay(30)
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

/* -------------------------------------------------------------------------- */
/* Probabilistic name → profile matching                                       */
/* -------------------------------------------------------------------------- */

/**
 * Sampled names are in-game display names, never linked steamids. We surface
 * ranked PROFILE CANDIDATES, never a single asserted identity. Evidence, in
 * order of weight:
 *   - name        : exact normalized match, else pg_trgm similarity (the only
 *                   hard key we have; TF2 names are highly non-unique).
 *   - stat-delta  : did the candidate's tracked lifetime playtime increase
 *                   across a stat-snapshot pair that brackets the segment start?
 *                   If so they were provably playing TF2 during the window —
 *                   the strongest corroborating signal we can compute.
 *   - recent play : tf2_minutes_2wk > 0 (segments are recent, so an active
 *                   player is a better fit than a dormant same-name account).
 *   - uniqueness  : a sole exact-name profile is far likelier than one of many.
 * Map/region are deliberately NOT scored: casual is SDR/region-hidden and we
 * hold no per-profile map history, so neither can disambiguate.
 */
export type MatchTier = "strong" | "possible" | "weak";

export interface ProfileCandidate {
  steamid: string;
  personaname: string | null;
  avatarHash: string | null;
  loccountrycode: string | null;
  tf2Minutes2wk: number | null;
  /** trigram name similarity, 0..1 (1 = exact normalized match) */
  similarity: number;
  /** combined confidence, 0..1 — ranked evidence, never a certainty */
  confidence: number;
  tier: MatchTier;
  signals: {
    exactName: boolean;
    recentlyActive: boolean;
    /** playtime provably accrued across a snapshot pair spanning the segment */
    deltaCorroborated: boolean;
  };
}

export interface ParticipantMatch {
  observedName: string;
  segment: { segmentId: string; map: string; region: number; startedAt: number };
  /** observed score gain over the sampling window (context, not a match key) */
  observedScoreGain: number | null;
  candidates: ProfileCandidate[];
}

/** lowercase, trim, collapse internal whitespace, strip zero-width/control junk */
function normalizeName(raw: string): string {
  // strip zero-width spaces/joiners, BOM and bidi controls, then fold case
  return raw
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

export const resolveParticipant = createServerFn({ method: "GET" })
  .validator(
    z.object({
      segmentId: z.string().regex(/^\d+$/),
      name: z.string().min(1).max(64),
    }),
  )
  .handler(async ({ data }): Promise<ParticipantMatch> => {
    const norm = normalizeName(data.name);
    const db = getDb();

    // The segment context (ClickHouse) and the candidate-profile lookup
    // (Postgres) are independent round trips against different stores — issue
    // them concurrently. Candidate lookup is skipped when the name normalizes
    // empty (nothing to match), matching the original early-return semantics.
    // The GIN pg_trgm index on lower(personaname) serves the `%` fuzzy
    // predicate; exact normalized matches always pass it.
    const [ctxRows, candRows] = await Promise.all([
      chQuery<Record<string, unknown>>(
        getCh(),
        `select any(map) as map, any(region) as region,
          toUnixTimestamp(any(started_at)) as started_at,
          any(first_score) as first_score, any(last_score) as last_score
        from match_obs
        where segment_id = {segmentId:UInt64} and name = {name:String}`,
        { segmentId: data.segmentId, name: data.name },
      ),
      norm.length === 0
        ? Promise.resolve([] as Record<string, unknown>[])
        : (db.execute(sql`
            select steamid, personaname, avatar_hash, loccountrycode, tf2_minutes_2wk,
              similarity(lower(personaname), ${norm}) as sim,
              (regexp_replace(lower(btrim(personaname)), '\\s+', ' ', 'g') = ${norm}) as exact
            from players
            where personaname is not null
              and lower(personaname) % ${norm}
            order by exact desc, sim desc
            limit 50
          `) as unknown as Promise<Record<string, unknown>[]>),
    ]);

    const ctx = ctxRows[0];
    const startedAt = num(ctx?.["started_at"]);
    const firstScore = ctx == null ? null : num(ctx["first_score"]);
    const lastScore = ctx == null ? null : num(ctx["last_score"]);
    const observedScoreGain =
      firstScore == null || lastScore == null ? null : Math.max(0, lastScore - firstScore);

    const empty: ParticipantMatch = {
      observedName: data.name,
      segment: {
        segmentId: data.segmentId,
        map: String(ctx?.["map"] ?? ""),
        region: num(ctx?.["region"]),
        startedAt,
      },
      observedScoreGain,
      candidates: [],
    };
    if (norm.length === 0) return empty;

    if (candRows.length === 0) return empty;

    const steamids = candRows.map((r) => String(r["steamid"]));
    const exactCount = candRows.filter((r) => r["exact"] === true).length;

    // Stat-delta corroboration: for each candidate, did a snapshot pair that
    // brackets the segment START show lifetime playtime (tf2_minutes) increase?
    // That proves they were playing TF2 through the window the name was seen.
    const corroborated = new Set<string>();
    if (startedAt > 0) {
      const startIso = new Date(startedAt * 1000).toISOString();
      const deltaRows = (await db.execute(sql`
        with snaps as (
          select steamid, fetched_at, tf2_minutes,
            lead(tf2_minutes) over w as next_min,
            lead(fetched_at) over w as next_at
          from player_stat_snapshots
          where steamid in (
            select value from jsonb_array_elements_text(${JSON.stringify(steamids)}::jsonb)
          )
          window w as (partition by steamid order by fetched_at)
        )
        select distinct steamid
        from snaps
        where fetched_at <= ${startIso}::timestamptz
          and next_at >= ${startIso}::timestamptz
          and tf2_minutes is not null and next_min is not null
          and next_min > tf2_minutes
      `)) as unknown as Record<string, unknown>[];
      for (const r of deltaRows) corroborated.add(String(r["steamid"]));
    }

    const candidates: ProfileCandidate[] = candRows.map((r) => {
      const steamid = String(r["steamid"]);
      const similarity = clamp01(num(r["sim"]));
      const exactName = r["exact"] === true;
      const tf2Minutes2wk = r["tf2_minutes_2wk"] == null ? null : num(r["tf2_minutes_2wk"]);
      const recentlyActive = (tf2Minutes2wk ?? 0) > 0;
      const deltaCorroborated = corroborated.has(steamid);

      const confidence = clamp01(
        0.45 * similarity +
          (exactName ? 0.15 : 0) +
          (recentlyActive ? 0.15 : 0) +
          (deltaCorroborated ? 0.35 : 0) +
          (exactName && exactCount === 1 ? 0.15 : 0) +
          (candRows.length > 20 ? -0.1 : 0),
      );
      const tier: MatchTier =
        deltaCorroborated && confidence >= 0.7
          ? "strong"
          : confidence >= 0.45
            ? "possible"
            : "weak";

      return {
        steamid,
        personaname: (r["personaname"] as string | null) ?? null,
        avatarHash: (r["avatar_hash"] as string | null) ?? null,
        loccountrycode: (r["loccountrycode"] as string | null) ?? null,
        tf2Minutes2wk,
        similarity,
        confidence,
        tier,
        signals: { exactName, recentlyActive, deltaCorroborated },
      };
    });

    candidates.sort((a, b) => b.confidence - a.confidence || b.similarity - a.similarity);
    return { ...empty, candidates };
  });

export const resolveParticipantQueryOptions = (segmentId: string, name: string) =>
  queryOptions({
    queryKey: ["resolveParticipant", segmentId, name],
    queryFn: () => resolveParticipant({ data: { segmentId, name } }),
  });

/* -------------------------------------------------------------------------- */
/* Forward attribution (>= 0.9) — asserted identities from the attributor       */
/* -------------------------------------------------------------------------- */

/**
 * High-confidence (>= 0.9) name→profile attributions the offline attributor
 * asserted for a batch of segments (Postgres `segment_attributions`, written by
 * apps/crawler/src/attributor.ts using the SAME scoring as resolveParticipant).
 * Unlike the on-demand candidate list this is a committed identity, so the page
 * can link straight to the profile. Batched by segment id so one query annotates
 * both the leaderboard and the expanded segment tables.
 */
export interface SegmentAttribution {
  segmentId: string;
  name: string;
  steamid: string;
  personaname: string | null;
  avatarHash: string | null;
  confidence: number;
  strong: boolean;
}

export const fetchAttributionsForSegments = createServerFn({ method: "GET" })
  .validator(z.object({ segmentIds: z.array(z.string().regex(/^\d+$/)).max(400) }))
  .handler(async ({ data }): Promise<SegmentAttribution[]> => {
    if (data.segmentIds.length === 0) return [];
    const db = getDb();
    const rows = (await db.execute(sql`
      select sa.segment_id, sa.name, sa.steamid, sa.confidence, sa.strong,
        p.personaname, p.avatar_hash
      from segment_attributions sa
      join players p on p.steamid = sa.steamid
      where sa.confidence >= 0.9
        and sa.segment_id in (
          select value::bigint
          from jsonb_array_elements_text(${JSON.stringify(data.segmentIds)}::jsonb)
        )
    `)) as unknown as Record<string, unknown>[];
    return rows.map((r) => ({
      segmentId: String(r["segment_id"]),
      name: String(r["name"]),
      steamid: String(r["steamid"]),
      personaname: (r["personaname"] as string | null) ?? null,
      avatarHash: (r["avatar_hash"] as string | null) ?? null,
      confidence: num(r["confidence"]),
      strong: r["strong"] === true,
    }));
  });

export const attributionsForSegmentsQueryOptions = (segmentIds: string[]) => {
  const key = [...segmentIds].sort();
  return queryOptions({
    queryKey: ["segmentAttributions", key],
    queryFn: () => fetchAttributionsForSegments({ data: { segmentIds: key } }),
    enabled: segmentIds.length > 0,
  });
};
