import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { chQuery } from "@trackertf/clickhouse";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { getCh } from "./ch.ts";
import { getDb } from "./db.ts";

/**
 * "Where has this player actually been seen playing?" — the reverse of
 * matches.ts `resolveParticipant`. That resolves one sampled NAME to profile
 * candidates; this takes a known profile and finds the casual match segments
 * whose sampled name matches this player's persona AND that we can corroborate
 * they were playing through, via the same stat-delta signal.
 *
 * A sighting only surfaces when BOTH hold:
 *   - stat-delta corroborated — a tf2_minutes snapshot pair for THIS player
 *     brackets the segment start, proving they were playing TF2 then; and
 *   - unique — no OTHER same-named profile is likewise corroborated for that
 *     segment, so the name can't plausibly be someone else's.
 * That's the "100% strong match" bar: name + provable concurrent play + no
 * same-name ambiguity. Ambiguous-but-corroborated segments are counted, never
 * shown as this player. Names are in-game display names, not linked steamids —
 * this is the strongest inference we can make, not an assertion.
 */

const num = (v: unknown): number => (v == null ? 0 : Number(v));

/** how far back to look for sightings, and the candidate-segment ceiling */
const WINDOW_DAYS = 30;
const CANDIDATE_LIMIT = 400;

export interface Sighting {
  segmentId: string;
  map: string;
  region: number;
  /** unix seconds */
  startedAt: number;
  /** observed score gain over the sampling window (context, not a match key) */
  scoreGain: number | null;
}

export interface PlayerSightings {
  /** false when the player has no persona name to match on */
  hasName: boolean;
  /** strong (corroborated + unique) sightings, newest first */
  sightings: Sighting[];
  /** candidate segments examined (name matched, within the window) */
  scanned: number;
  /** corroborated but shared with another same-named profile — not shown */
  ambiguous: number;
}

/** lowercase, trim, collapse internal whitespace, strip zero-width/control junk.
 * Mirrors normalizeName in matches.ts so both sides key on the same string. */
function normalizeName(raw: string): string {
  return raw
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

const EMPTY: PlayerSightings = { hasName: false, sightings: [], scanned: 0, ambiguous: 0 };

export const fetchPlayerSightings = createServerFn({ method: "GET" })
  .validator(z.object({ steamid: z.string().regex(/^\d{17}$/) }))
  .handler(async ({ data }): Promise<PlayerSightings> => {
    const db = getDb();
    const [p] = (await db.execute(sql`
      select personaname from players where steamid = ${data.steamid}
    `)) as unknown as [{ personaname: string | null } | undefined];
    if (!p?.personaname) return EMPTY;
    const norm = normalizeName(p.personaname);
    if (norm.length === 0) return EMPTY;

    // Candidate segments: recent sampler segments whose (normalized) observed
    // name equals this player's persona. Normalization mirrors normalizeName —
    // strip zero-width, collapse whitespace, lower, trim (RE2 in that order).
    const candRows = await chQuery<Record<string, unknown>>(
      getCh(),
      `select toString(segment_id) as segment_id,
        any(map) as map,
        any(region) as region,
        toUnixTimestamp(any(started_at)) as started_at,
        any(first_score) as first_score,
        any(last_score) as last_score
      from match_obs
      where trimBoth(
              replaceRegexpAll(
                replaceRegexpAll(lowerUTF8(name),
                  '[\\x{200B}-\\x{200F}\\x{202A}-\\x{202E}\\x{2060}\\x{FEFF}]', ''),
                '\\s+', ' ')) = {norm:String}
        and started_at > now() - toIntervalDay({days:UInt16})
      group by segment_id
      order by started_at desc
      limit {lim:UInt32}`,
      { norm, days: WINDOW_DAYS, lim: CANDIDATE_LIMIT },
    );
    if (candRows.length === 0) return { hasName: true, sightings: [], scanned: 0, ambiguous: 0 };

    const cands = candRows.map((r) => {
      const startedAt = num(r["started_at"]);
      const first = num(r["first_score"]);
      const last = num(r["last_score"]);
      return {
        segmentId: String(r["segment_id"]),
        map: String(r["map"]),
        region: num(r["region"]),
        startedAt,
        scoreGain: startedAt > 0 ? Math.max(0, last - first) : null,
      };
    });

    // Corroboration + uniqueness in one pass. For every same-named profile,
    // build lifetime-playtime-increase intervals from snapshot pairs, then for
    // each candidate segment count how many of those profiles were provably
    // playing at the segment start — and whether THIS player is one of them.
    const segs = cands
      .filter((c) => c.startedAt > 0)
      .map((c) => ({ sid: c.segmentId, ts: new Date(c.startedAt * 1000).toISOString() }));
    if (segs.length === 0) {
      return { hasName: true, sightings: [], scanned: cands.length, ambiguous: 0 };
    }

    const corrRows = (await db.execute(sql`
      with segs as (
        select value ->> 'sid' as segment_id,
               (value ->> 'ts')::timestamptz as started_at
        from jsonb_array_elements(${JSON.stringify(segs)}::jsonb)
      ),
      named as (
        select steamid from players
        where personaname is not null
          and regexp_replace(lower(btrim(personaname)), '\\s+', ' ', 'g') = ${norm}
      ),
      snaps as (
        select s.steamid, s.fetched_at, s.tf2_minutes,
          lead(s.tf2_minutes) over w as next_min,
          lead(s.fetched_at) over w as next_at
        from player_stat_snapshots s
        join named n using (steamid)
        window w as (partition by s.steamid order by s.fetched_at)
      ),
      intervals as (
        select steamid, fetched_at as lo, next_at as hi
        from snaps
        where tf2_minutes is not null and next_min is not null
          and next_at is not null and next_min > tf2_minutes
      )
      select seg.segment_id,
        bool_or(i.steamid = ${data.steamid}) as me,
        count(distinct i.steamid)::int as players
      from segs seg
      left join intervals i
        on seg.started_at >= i.lo and seg.started_at <= i.hi
      group by seg.segment_id
    `)) as unknown as Record<string, unknown>[];

    const corr = new Map(
      corrRows.map((r) => [
        String(r["segment_id"]),
        { me: r["me"] === true, players: num(r["players"]) },
      ]),
    );

    const sightings: Sighting[] = [];
    let ambiguous = 0;
    for (const c of cands) {
      const hit = corr.get(c.segmentId);
      if (!hit?.me) continue; // not provably this player playing → drop
      if (hit.players > 1) {
        ambiguous++; // corroborated but another same-named profile also was
        continue;
      }
      sightings.push({
        segmentId: c.segmentId,
        map: c.map,
        region: c.region,
        startedAt: c.startedAt,
        scoreGain: c.scoreGain,
      });
    }

    return { hasName: true, sightings, scanned: cands.length, ambiguous };
  });

export const playerSightingsQueryOptions = (steamid: string) =>
  queryOptions({
    queryKey: ["player-sightings", steamid],
    queryFn: () => fetchPlayerSightings({ data: { steamid } }),
  });
