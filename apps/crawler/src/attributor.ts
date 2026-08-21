/**
 * Attribution service (Postgres-only, no Steam API calls). Runs every cycle and
 * builds three derived tables from the sampler's name-based observations plus the
 * crawler's stat snapshots:
 *
 *  1. segment_attributions — FORWARD attribution. Each sampled participant NAME
 *     (match_participants) is resolved to a real steamid using the EXACT same
 *     evidence-weighted scoring as the on-demand resolver in
 *     apps/web/src/server/matches.ts (resolveParticipant). Only matches with
 *     confidence >= 0.9 are written, so a row asserts an identity.
 *
 *  2. stat_windows — delta windows between consecutive stat snapshots of the
 *     attributed players, flagged reset / upload-lag / pure-map / pure-class.
 *     A window is pure-map when the player's attributed segments across it
 *     covered exactly one map; pure-class when exactly one class's playtime moved.
 *
 *  3. map_class_playtime — per-class playtime delta summed over pure-map windows
 *     and attributed to that map ("how much <class> time happens on <map>").
 *
 * Everything is idempotent (upsert / delete+insert) and scoped to a trailing
 * window so it self-heals as attributions improve and snapshots accrue. Bounds
 * are logged so truncation is never silent.
 */
import { createDbFromEnv, schema } from "@trackertf/db";
import { type ClassStatsRow, parseClassStats } from "./parse.ts";
import { sql } from "drizzle-orm";

const db = createDbFromEnv();
const INTERVAL_MS = 15 * 60_000;

/** only attribute participants from segments started within this window */
const ATTRIBUTE_LOOKBACK_DAYS = 14;
/** cap participants scored per pass (self-heals across passes; logged) */
const MAX_ATTRIBUTE_PER_PASS = 4000;
/** confidence at/above which a name→steamid attribution is asserted */
const ATTRIBUTION_THRESHOLD = 0.9;
/** build stat windows from snapshots within this trailing window */
const WINDOW_LOOKBACK_DAYS = 21;

/** lowercase, trim, collapse internal whitespace, strip zero-width/control junk.
 * Mirrors normalizeName in apps/web/src/server/matches.ts. */
function normalizeName(raw: string): string {
  return raw
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));
const num = (v: unknown): number => (v == null ? 0 : Number(v));

interface Scored {
  steamid: string;
  similarity: number;
  exactName: boolean;
  recentlyActive: boolean;
  deltaCorroborated: boolean;
  confidence: number;
  strong: boolean;
}

/**
 * Resolve one participant NAME to its best profile candidate, replicating
 * resolveParticipant's scoring 1:1 (see matches.ts). Reads only Postgres.
 * Returns null when there is no candidate at all.
 */
async function scoreParticipant(name: string, startedAt: Date): Promise<Scored | null> {
  const norm = normalizeName(name);
  if (norm.length === 0) return null;

  // Candidate profiles by name — GIN pg_trgm index on lower(personaname) serves
  // the `%` fuzzy predicate; exact normalized matches always pass it.
  const candRows = (await db.execute(sql`
    select steamid, tf2_minutes_2wk,
      similarity(lower(personaname), ${norm}) as sim,
      (regexp_replace(lower(btrim(personaname)), '\\s+', ' ', 'g') = ${norm}) as exact
    from players
    where personaname is not null
      and lower(personaname) % ${norm}
    order by exact desc, sim desc
    limit 50
  `)) as unknown as Record<string, unknown>[];
  if (candRows.length === 0) return null;

  const steamids = candRows.map((r) => String(r["steamid"]));
  const exactCount = candRows.filter((r) => r["exact"] === true).length;

  // Stat-delta corroboration: did a snapshot pair bracketing the segment START
  // show lifetime playtime (tf2_minutes) increase? Proves they were playing TF2
  // through the window the name was seen. Identical query to matches.ts.
  const corroborated = new Set<string>();
  const startIso = startedAt.toISOString();
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

  let best: Scored | null = null;
  for (const r of candRows) {
    const steamid = String(r["steamid"]);
    const similarity = clamp01(num(r["sim"]));
    const exactName = r["exact"] === true;
    const recentlyActive = num(r["tf2_minutes_2wk"]) > 0;
    const deltaCorroborated = corroborated.has(steamid);

    const confidence = clamp01(
      0.45 * similarity +
        (exactName ? 0.15 : 0) +
        (recentlyActive ? 0.15 : 0) +
        (deltaCorroborated ? 0.35 : 0) +
        (exactName && exactCount === 1 ? 0.15 : 0) +
        (candRows.length > 20 ? -0.1 : 0),
    );
    const strong = deltaCorroborated && confidence >= 0.7;

    if (
      !best ||
      confidence > best.confidence ||
      (confidence === best.confidence && similarity > best.similarity)
    ) {
      best = {
        steamid,
        similarity,
        exactName,
        recentlyActive,
        deltaCorroborated,
        confidence,
        strong,
      };
    }
  }
  return best;
}

/** Attribute recent, not-yet-attributed participants; write >= 0.9 matches. */
async function attributeParticipants(): Promise<void> {
  const pending = (await db.execute(sql`
    select mp.segment_id, mp.name, ms.started_at
    from match_participants mp
    join match_segments ms on ms.id = mp.segment_id
    left join segment_attributions sa
      on sa.segment_id = mp.segment_id and sa.name = mp.name
    where ms.started_at > now() - make_interval(days => ${ATTRIBUTE_LOOKBACK_DAYS})
      and sa.segment_id is null
    order by ms.started_at desc
    limit ${MAX_ATTRIBUTE_PER_PASS}
  `)) as unknown as { segment_id: string | number; name: string; started_at: string | Date }[];

  let written = 0;
  for (const p of pending) {
    const segmentId = Number(p.segment_id);
    const startedAt = new Date(p.started_at);
    let scored: Scored | null;
    try {
      scored = await scoreParticipant(p.name, startedAt);
    } catch (err) {
      console.error(`attribute failed for segment ${segmentId} name "${p.name}":`, err);
      continue;
    }
    if (!scored || scored.confidence < ATTRIBUTION_THRESHOLD) continue;

    await db
      .insert(schema.segmentAttributions)
      .values({
        segmentId,
        name: p.name,
        steamid: scored.steamid,
        confidence: scored.confidence,
        similarity: scored.similarity,
        exactName: scored.exactName,
        recentlyActive: scored.recentlyActive,
        deltaCorroborated: scored.deltaCorroborated,
        strong: scored.strong,
      })
      .onConflictDoUpdate({
        target: [schema.segmentAttributions.segmentId, schema.segmentAttributions.name],
        set: {
          steamid: scored.steamid,
          confidence: scored.confidence,
          similarity: scored.similarity,
          exactName: scored.exactName,
          recentlyActive: scored.recentlyActive,
          deltaCorroborated: scored.deltaCorroborated,
          strong: scored.strong,
          computedAt: new Date(),
        },
      });
    written += 1;
  }
  const capped = pending.length === MAX_ATTRIBUTE_PER_PASS;
  console.log(
    `attributor: scored ${pending.length} pending participants, wrote ${written} (>= ${ATTRIBUTION_THRESHOLD})` +
      (capped
        ? ` — HIT per-pass cap ${MAX_ATTRIBUTE_PER_PASS}, backlog remains for next pass`
        : ""),
  );
}

/** an equipped-loadout triple [defindex, classNum, slot] as stored on a snapshot */
type Triple = [number, number, number];

interface Snap {
  fetchedAt: Date;
  classStats: Map<number, ClassStatsRow>;
  /** the equipped loadout at this instant, or null when not captured */
  loadout: Triple[] | null;
}
interface AttrSeg {
  startedAt: number;
  endedAt: number;
  map: string;
}

/** payload (jsonb name→value) → per-class accum stats via parseClassStats. */
function classStatsFromPayload(payload: unknown): Map<number, ClassStatsRow> {
  const stats = new Map<string, number>();
  for (const [k, v] of Object.entries((payload ?? {}) as Record<string, unknown>)) {
    stats.set(k, Number(v));
  }
  const out = new Map<number, ClassStatsRow>();
  for (const row of parseClassStats(stats)) out.set(row.classNum, row);
  return out;
}

/** loadout jsonb ([[defindex,class,slot],...]) → typed triples, null when absent. */
function parseLoadout(raw: unknown): Triple[] | null {
  if (!Array.isArray(raw)) return null;
  const out: Triple[] = [];
  for (const t of raw) {
    if (Array.isArray(t)) out.push([num(t[0]), num(t[1]), num(t[2])]);
  }
  return out;
}

/** slot<=6 weapon triples equipped by one class, as "defindex:slot" keys. */
function weaponSlotKeys(loadout: Triple[], classNum: number): Set<string> {
  const keys = new Set<string>();
  for (const [defindex, cls, slot] of loadout) {
    if (cls === classNum && slot <= 6) keys.add(`${defindex}:${slot}`);
  }
  return keys;
}

const setsEqual = (a: Set<string>, b: Set<string>): boolean =>
  a.size === b.size && [...a].every((v) => b.has(v));

/** positive-only delta between two accum values (per-stat reset guard). */
const posDelta = (cur: number | undefined, prev: number | undefined): number =>
  Math.max(0, (cur ?? 0) - (prev ?? 0));

/**
 * Build/refresh stat_windows over the trailing WINDOW_LOOKBACK_DAYS. Scoped to
 * ALL active players with consecutive snapshot pairs (not just attributed ones)
 * so window_perf covers the full corpus — an un-attributed player's window
 * simply carries no map (pure_map stays false), leaving map_class_playtime, which
 * only sums pure-map windows, unaffected. Per-map attribution still needs
 * segment_attributions; those are fetched per player and are empty for
 * un-attributed players.
 */
async function buildStatWindows(): Promise<void> {
  const players = (await db.execute(sql`
    select steamid
    from player_stat_snapshots
    where fetched_at > now() - make_interval(days => ${WINDOW_LOOKBACK_DAYS})
    group by steamid
    having count(*) >= 2
  `)) as unknown as { steamid: string }[];

  let windows = 0;
  for (const { steamid } of players) {
    const snapRows = (await db.execute(sql`
      select fetched_at, payload, loadout
      from player_stat_snapshots
      where steamid = ${steamid}
        and fetched_at > now() - make_interval(days => ${WINDOW_LOOKBACK_DAYS})
      order by fetched_at asc
    `)) as unknown as { fetched_at: string | Date; payload: unknown; loadout: unknown }[];
    if (snapRows.length < 2) continue;

    const snaps: Snap[] = snapRows.map((r) => ({
      fetchedAt: new Date(r.fetched_at),
      classStats: classStatsFromPayload(r.payload),
      loadout: parseLoadout(r.loadout),
    }));

    // attributed segments for this player, to decide pure-map per window
    const segRows = (await db.execute(sql`
      select extract(epoch from ms.started_at) as s, extract(epoch from ms.ended_at) as e, ms.map
      from segment_attributions sa
      join match_segments ms on ms.id = sa.segment_id
      where sa.steamid = ${steamid}
    `)) as unknown as { s: string | number; e: string | number; map: string }[];
    const segs: AttrSeg[] = segRows.map((r) => ({
      startedAt: num(r.s),
      endedAt: num(r.e),
      map: String(r.map),
    }));

    for (let i = 1; i < snaps.length; i++) {
      const prev = snaps[i - 1];
      const cur = snaps[i];
      if (!prev || !cur) continue;

      const classDeltas: Record<string, number> = {};
      const statDeltas: Record<string, Record<string, number>> = {};
      let reset = false;
      let positiveClasses = 0;
      let playtimeDeltaSec = 0;
      // loadout is "stable" only if both endpoints captured it AND every moved
      // class ran the same slot<=6 weapons at both ends
      let loadoutStable = prev.loadout !== null && cur.loadout !== null;
      for (let cn = 1; cn <= 9; cn++) {
        const prevStats = prev.classStats.get(cn);
        const curStats = cur.classStats.get(cn);
        const delta = (curStats?.playtimeSeconds ?? 0) - (prevStats?.playtimeSeconds ?? 0);
        if (delta < 0) reset = true;
        if (delta > 0) {
          classDeltas[String(cn)] = delta;
          positiveClasses += 1;
          playtimeDeltaSec += delta;
          // other accum stats gained by this moved class (positive-only guard)
          statDeltas[String(cn)] = {
            kills: posDelta(curStats?.kills, prevStats?.kills),
            assists: posDelta(curStats?.killAssists, prevStats?.killAssists),
            damage: posDelta(curStats?.damageDealt, prevStats?.damageDealt),
            points: posDelta(curStats?.pointsScored, prevStats?.pointsScored),
            dominations: posDelta(curStats?.dominations, prevStats?.dominations),
            captures: posDelta(curStats?.captures, prevStats?.captures),
            defenses: posDelta(curStats?.defenses, prevStats?.defenses),
          };
          if (loadoutStable && prev.loadout && cur.loadout) {
            const a = weaponSlotKeys(prev.loadout, cn);
            const b = weaponSlotKeys(cur.loadout, cn);
            if (!setsEqual(a, b)) loadoutStable = false;
          }
        }
      }
      // END snapshot's loadout, null unless both endpoints captured one
      const loadout = prev.loadout !== null && cur.loadout !== null ? cur.loadout : null;

      // pure-map: attributed segments overlapping [prev, cur) span exactly one map
      const winStart = prev.fetchedAt.getTime() / 1000;
      const winEnd = cur.fetchedAt.getTime() / 1000;
      const maps = new Set<string>();
      for (const s of segs) {
        if (s.startedAt < winEnd && s.endedAt > winStart) maps.add(s.map);
      }
      const pureMap = maps.size === 1;
      const map = pureMap ? [...maps][0]! : null;

      await db
        .insert(schema.statWindows)
        .values({
          steamid,
          startedAt: prev.fetchedAt,
          endedAt: cur.fetchedAt,
          playtimeDeltaSec,
          reset,
          uploadLag: !reset && playtimeDeltaSec === 0,
          pureMap,
          pureClass: positiveClasses === 1,
          map,
          classDeltas,
          statDeltas,
          loadout,
          loadoutStable,
        })
        .onConflictDoUpdate({
          target: [
            schema.statWindows.steamid,
            schema.statWindows.startedAt,
            schema.statWindows.endedAt,
          ],
          set: {
            playtimeDeltaSec,
            reset,
            uploadLag: !reset && playtimeDeltaSec === 0,
            pureMap,
            pureClass: positiveClasses === 1,
            map,
            classDeltas,
            statDeltas,
            loadout,
            loadoutStable,
            computedAt: new Date(),
          },
        });
      windows += 1;
    }
  }
  console.log(`attributor: built/refreshed ${windows} stat windows for ${players.length} players`);
}

/**
 * Rebuild map_class_playtime from pure-map, non-reset windows: sum each class's
 * playtime delta into (map, class). Delete+insert in one transaction so a reader
 * never sees a half-rebuilt table (mirrors weapon_class_stats).
 */
async function rebuildMapClassPlaytime(): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`delete from map_class_playtime`);
    await tx.execute(sql`
      insert into map_class_playtime (map, class_num, playtime_seconds, windows, players, computed_at)
      select w.map,
        (kv.key)::smallint as class_num,
        sum((kv.value)::bigint)::bigint as playtime_seconds,
        count(*)::int as windows,
        count(distinct w.steamid)::int as players,
        now()
      from stat_windows w
      cross join lateral jsonb_each_text(w.class_deltas) kv
      where w.pure_map = true and w.reset = false and w.map is not null
        and (kv.value)::bigint > 0
      group by w.map, class_num
    `);
  });
  console.log("attributor: map_class_playtime rebuilt");
}

async function main(): Promise<void> {
  console.log("attributor started");
  for (;;) {
    const start = Date.now();
    try {
      await attributeParticipants();
      await buildStatWindows();
      await rebuildMapClassPlaytime();
      console.log(`attributor pass done in ${Date.now() - start}ms`);
    } catch (err) {
      console.error("attributor run failed:", err);
    }
    await Bun.sleep(INTERVAL_MS);
  }
}

await main();
