import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { chQuery } from "@trackertf/clickhouse";
import {
  BOARD_MAP,
  type BoardDef,
  boardCountSql,
  boardSelectSql,
  METRICS,
  RATE_THRESHOLD_HOURS,
  rankLookupSql,
} from "@trackertf/db/boards";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { getCh } from "./ch.ts";
import { getDb } from "./db.ts";

export interface LeaderRow {
  rank: number;
  steamid: string;
  personaname: string | null;
  avatarHash: string | null;
  value: number;
}

export interface LeaderboardResponse {
  rows: LeaderRow[];
  /** board population size (percentile denominator); null before first precompute */
  participants: number | null;
}

/**
 * Strange-kill boards live outside the (metric, scope, kind) grid in boards.ts:
 * strange_kills + quality exist only in ClickHouse `equipped`, never in the
 * Postgres precompute the other boards read. So these keys are handled by a
 * dedicated CH→PG path here and are deliberately absent from BOARD_MAP.
 */
export const STRANGE_BOARD_KEYS = ["strange:total", "strange:max", "strange:haleown"] as const;

/** kills for a Strange item to reach the top "Hale's Own" rank (mirror of
 * HALE_OWN_KILLS in tf2-schema strange.ts / the player-page inline copy) */
export const HALE_OWN_KILLS = 8500;
export type StrangeBoardKey = (typeof STRANGE_BOARD_KEYS)[number];
const STRANGE_KEY_SET: ReadonlySet<string> = new Set(STRANGE_BOARD_KEYS);
export const isStrangeBoard = (key: string): key is StrangeBoardKey => STRANGE_KEY_SET.has(key);

const boardKeySchema = z
  .string()
  .refine((key): key is string => BOARD_MAP.has(key) || isStrangeBoard(key), "unknown board");

/**
 * Strange-kill leaderboard: rank crawled players by kills on their Strange
 * (quality 11) equipped items. `equipped` stores one row per
 * (steamid, class_num, slot, defindex), so a single physical item run across
 * multiple class loadouts appears as multiple rows; we first collapse to
 * distinct items per player (max counter per (steamid, defindex)) so nothing is
 * multi-counted. `strange:total` then sums each distinct Strange item's counter
 * a player is displaying; `strange:max` takes their single highest counter.
 * Sourced from ClickHouse `equipped` (the only place quality /
 * strange_kills live), then joined back to Postgres `players` for persona /
 * avatar and the POP filter (public persona, no VAC ban, botness < 0.5 — the
 * same bot/outlier exclusion boards.ts applies to the grid boards).
 * `strange:haleown` ranks players by how many equipped Stranges have hit the
 * top rank (>= 8,500 kills) — a "how many maxed weapons" board.
 */
async function fetchStrangeBoard(board: StrangeBoardKey): Promise<LeaderboardResponse> {
  const agg =
    board === "strange:max"
      ? "max(item_kills)"
      : board === "strange:haleown"
        ? `countIf(item_kills >= ${HALE_OWN_KILLS})`
        : "sum(item_kills)";
  // Hale's Own is a count of maxed items, so drop players with zero (they'd
  // otherwise pad the tail); the other boards already require strange_kills > 0.
  const having = board === "strange:haleown" ? "having value > 0" : "";
  // Collapse to one row per distinct physical item first — `equipped` has one
  // row per (steamid, class_num, slot, defindex), so a multi-class Strange
  // would otherwise be summed/counted once per class. group by (steamid,
  // defindex) taking the highest counter, then aggregate at the player level.
  // over-fetch from CH so POP-filtered dropouts in PG still leave a full top-100
  const chRows = await chQuery<{ steamid: string; value: string | number }>(
    getCh(),
    `select toString(steamid) as steamid, toUInt64(${agg}) as value
     from (
       select steamid, defindex, max(strange_kills) as item_kills
       from equipped
       where quality = 11 and strange_kills > 0
       group by steamid, defindex
     )
     group by steamid
     ${having}
     order by value desc
     limit 300`,
  );
  if (chRows.length === 0) return { rows: [], participants: null };

  const valueBySteamid = new Map(chRows.map((r) => [String(r.steamid), Number(r.value)]));
  const ids = [...valueBySteamid.keys()];
  const db = getDb();
  const pgRows = (await db.execute(sql`
    select steamid, personaname, avatar_hash
    from players
    where steamid in ${ids}
      and personaname is not null and vac_banned = false
      and coalesce(botness, 0) < 0.5
  `)) as unknown as Record<string, unknown>[];

  const rows: LeaderRow[] = pgRows
    .map((r) => ({
      steamid: r["steamid"] as string,
      personaname: r["personaname"] as string | null,
      avatarHash: r["avatar_hash"] as string | null,
      value: valueBySteamid.get(r["steamid"] as string) ?? 0,
    }))
    .sort((a, b) => b.value - a.value || a.steamid.localeCompare(b.steamid))
    .slice(0, 100)
    .map((r, i) => ({ ...r, rank: i + 1 }));

  // no cheap exact population count (would need the full CH×PG join), so leave
  // the percentile denominator null rather than report a misleading number
  return { rows, participants: null };
}

export const fetchLeaderboard = createServerFn({ method: "GET" })
  .validator(z.object({ board: boardKeySchema }))
  .handler(async ({ data }): Promise<LeaderboardResponse> => {
    if (isStrangeBoard(data.board)) return fetchStrangeBoard(data.board);
    const def = BOARD_MAP.get(data.board) as BoardDef;
    const db = getDb();
    let rows = (await db.execute(sql`
      select e.rank, e.steamid, e.value, p.personaname, p.avatar_hash
      from leaderboard_entries e
      join players p using (steamid)
      where e.board_key = ${def.key}
      order by e.rank
    `)) as unknown as Record<string, unknown>[];
    let participants: number | null = null;
    if (rows.length === 0) {
      // analyser hasn't populated leaderboard_entries yet — compute live
      const [live, counts] = await Promise.all([
        db.execute(sql`
          select row_number() over (order by t.value desc, t.steamid)::int as rank,
            t.steamid, t.value, p.personaname, p.avatar_hash
          from (${sql.raw(boardSelectSql(def, 100))}) t
          join players p using (steamid)
        `) as unknown as Promise<Record<string, unknown>[]>,
        db.execute(sql.raw(boardCountSql(def))) as unknown as Promise<{ n: number }[]>,
      ]);
      rows = live;
      participants = counts[0]?.n ?? null;
    } else {
      const meta = (await db.execute(sql`
        select participants from leaderboard_meta where board_key = ${def.key}
      `)) as unknown as { participants: number }[];
      participants = meta[0]?.participants ?? null;
    }
    return {
      rows: rows.map((r) => ({
        rank: r["rank"] as number,
        steamid: r["steamid"] as string,
        personaname: r["personaname"] as string | null,
        avatarHash: r["avatar_hash"] as string | null,
        value: r["value"] as number,
      })),
      participants,
    };
  });

export const leaderboardQueryOptions = (board: string) =>
  queryOptions({
    queryKey: ["leaderboard", board],
    queryFn: () => fetchLeaderboard({ data: { board } }),
  });

export interface DistributionPoint {
  /** percentile of the qualifying-player population, 0-100 */
  percentile: number;
  value: number;
}

export interface BoardDistribution {
  /** ~40 pre-downsampled {percentile, value} samples of the population curve */
  points: DistributionPoint[];
  /** qualifying-player population size, null if the board has no PG population */
  participants: number | null;
}

/** number of quantile samples the curve is downsampled to (chart-friendly) */
const DISTRIBUTION_SAMPLES = 41;
/** below this population a curve is noise — surface NOT_ENOUGH_DATA instead */
const MIN_DISTRIBUTION_POP = 20;
/** effectively "no limit": a cap well above the crawl corpus so boardSelectSql
 * returns the whole population for the quantile pass (not just a biased top-N) */
const DISTRIBUTION_POP_CAP = 100_000_000;

/**
 * Population distribution for one leaderboard board, as a compact quantile
 * curve (value at each percentile) for charting the shape behind the top-100.
 *
 * PLAN.md envisages a precomputed `board_distributions` (~1000-point quantile
 * arrays per board) in the analyser, but that table does not exist yet — the
 * analyser only writes leaderboard_entries (top-100) + leaderboard_meta
 * (participant counts). So this computes the curve live in one ordered-set
 * aggregate pass: percentile_cont(<fractions>) over the same board population
 * boardSelectSql defines (reusing its POP bot/VAC filter), already downsampled
 * server-side to DISTRIBUTION_SAMPLES points. Strange boards live only in
 * ClickHouse with no PG population to profile, so they return an empty curve.
 */
export const fetchBoardDistribution = createServerFn({ method: "GET" })
  .validator(z.object({ board: boardKeySchema }))
  .handler(async ({ data }): Promise<BoardDistribution> => {
    if (isStrangeBoard(data.board)) return { points: [], participants: null };
    const def = BOARD_MAP.get(data.board) as BoardDef;
    const fractions = Array.from({ length: DISTRIBUTION_SAMPLES }, (_, i) =>
      (i / (DISTRIBUTION_SAMPLES - 1)).toFixed(4),
    );
    const db = getDb();
    const res = (await db.execute(sql`
      select count(*)::int as n,
        percentile_cont(${sql.raw(`array[${fractions.join(",")}]::double precision[]`)})
          within group (order by t.value) as vals
      from (${sql.raw(boardSelectSql(def, DISTRIBUTION_POP_CAP))}) t
    `)) as unknown as { n: number; vals: number[] | null }[];
    const row = res[0];
    const vals = row?.vals ?? null;
    if (!row || row.n < MIN_DISTRIBUTION_POP || !vals || vals.length !== fractions.length) {
      return { points: [], participants: row?.n ?? null };
    }
    const points = vals.map((value, i) => ({
      percentile: Math.round((i / (DISTRIBUTION_SAMPLES - 1)) * 100),
      value: Number(value),
    }));
    return { points, participants: row.n };
  });

export const boardDistributionQueryOptions = (board: string) =>
  queryOptions({
    queryKey: ["boardDistribution", board],
    queryFn: () => fetchBoardDistribution({ data: { board } }),
  });

export interface PlayerRankRow {
  boardKey: string;
  label: string;
  rank: number;
  of: number;
  value: number;
}

/**
 * The player's rank on every board, read from the analyser-precomputed
 * rank_pop/rank_meta tables (see rankPopSelectSql in boards.ts) with one
 * indexed lookup — ~10 rows, one per scope. Sorted by rank percentile, best
 * first. Ranks are as fresh as the last analyser pass (~15-30 min), same as
 * the leaderboards themselves.
 *
 * Earlier versions ranked the live corpus per page view; that cost grew
 * linearly with the crawl (3.5-6.5s at 580k player_class_stats rows) and
 * bot-crawled player pages pinned the DB at 100% CPU for two days. Never
 * rank the population inside a request handler again.
 *
 * Fails soft to no ranks if the tables don't exist yet (first deploy before
 * the analyser's first pass) — the player page renders without the section.
 */
export const fetchPlayerRanks = createServerFn({ method: "GET" })
  .validator(z.object({ steamid: z.string().regex(/^\d{17}$/) }))
  .handler(async ({ data }): Promise<PlayerRankRow[]> => {
    const db = getDb();
    let rows: Record<string, unknown>[];
    try {
      rows = (await db.execute(sql`
        ${sql.raw(rankLookupSql())}
        where s.steamid = ${data.steamid}
      `)) as unknown as Record<string, unknown>[];
    } catch (err) {
      console.error(`fetchPlayerRanks failed for ${data.steamid}:`, err);
      return [];
    }

    const scopeRows = rows.filter((r) => Number(r["scope"]) >= 0);
    const hoursRow = rows.find((r) => Number(r["scope"]) === -1);

    const ranks: PlayerRankRow[] = [];
    // Each row is one scope (0 = overall, N = class N); un-pivot into per-board
    // rank rows to mirror the board key grid in boards.ts.
    for (const r of scopeRows) {
      const scopeNum = r["scope"] as number;
      const scope = scopeNum === 0 ? "overall" : scopeNum;
      const pTotal = r["p_total"] as number;
      const mePlaytime = Number(r["me_playtime"]);
      for (const m of METRICS) {
        const totalKey = `${m}:${scope}:total`;
        const totalDef = BOARD_MAP.get(totalKey);
        if (totalDef) {
          const raw = Number(r[`me_${m}`]);
          ranks.push({
            boardKey: totalKey,
            label: totalDef.label,
            rank: r[`rt_${m}`] as number,
            of: pTotal,
            value: m === "playtime" ? raw / 3600 : raw,
          });
        }
        if (m === "playtime") continue;
        for (const hours of RATE_THRESHOLD_HOURS) {
          // player only appears on a per-hour board once past its threshold
          if (mePlaytime < hours * 3600) continue;
          const key = `${m}:${scope}:per_hour:${hours}h`;
          const def = BOARD_MAP.get(key);
          if (!def) continue;
          const meMetric = Number(r[`me_${m}`]);
          ranks.push({
            boardKey: key,
            label: def.label,
            rank: r[`rh_${m}_${hours}h`] as number,
            of: r[`ph_${hours}h`] as number,
            value: mePlaytime > 0 ? (meMetric * 3600) / mePlaytime : 0,
          });
        }
      }
    }
    // scope -1 = the tf2_minutes hours board; its playtime column holds
    // tf2_minutes*60, so /3600 recovers hours (see rankPopSelectSql)
    if (hoursRow) {
      const def = BOARD_MAP.get("hours") as BoardDef;
      ranks.push({
        boardKey: def.key,
        label: def.label,
        rank: Number(hoursRow["rt_playtime"]),
        of: Number(hoursRow["p_total"]),
        value: Number(hoursRow["me_playtime"]) / 3600,
      });
    }
    // guard against a 0-participant board: rank/of would be NaN and poison the
    // sort — treat an empty board's ratio as 1 so it sorts to the end.
    const ratio = (r: PlayerRankRow) => (r.of > 0 ? r.rank / r.of : 1);
    return ranks.toSorted((a, b) => ratio(a) - ratio(b));
  });

export const playerRanksQueryOptions = (steamid: string) =>
  queryOptions({
    queryKey: ["playerRanks", steamid],
    queryFn: () => fetchPlayerRanks({ data: { steamid } }),
  });

export interface ItemStrangeRow {
  rank: number;
  steamid: string;
  personaname: string | null;
  avatarHash: string | null;
  /** highest Strange counter this player is displaying on the item */
  kills: number;
}

const ITEM_STRANGE_LIMIT = 20;

/**
 * Per-item Strange kill-eater leaderboard: the top players by kills on their
 * Strange (quality 11) copy of one specific defindex. Unlike the site-wide
 * strange boards this reads Postgres `equipped_items` directly (steamid,
 * defindex, quality, strange_kills) and joins `players` in the same pass —
 * a defindex is far narrower than the whole Strange corpus, so no CH→PG
 * over-fetch is needed. Applies the standard population filter (public
 * persona, no VAC ban, botness < 0.5) that boards.ts uses everywhere, and
 * collapses a player who runs the item on multiple classes to their single
 * highest counter via max().
 */
export const fetchItemStrangeBoard = createServerFn({ method: "GET" })
  .validator(z.object({ defindex: z.number().int().nonnegative() }))
  .handler(async ({ data }): Promise<ItemStrangeRow[]> => {
    const db = getDb();
    const rows = (await db.execute(sql`
      select e.steamid, max(e.strange_kills) as kills, p.personaname, p.avatar_hash
      from equipped_items e
      join players p using (steamid)
      where e.defindex = ${data.defindex} and e.quality = 11 and e.strange_kills > 0
        and p.personaname is not null and p.vac_banned = false
        and coalesce(p.botness, 0) < 0.5
      group by e.steamid, p.personaname, p.avatar_hash
      order by kills desc, e.steamid
      limit ${ITEM_STRANGE_LIMIT}
    `)) as unknown as Record<string, unknown>[];
    return rows.map((r, i) => ({
      rank: i + 1,
      steamid: r["steamid"] as string,
      personaname: r["personaname"] as string | null,
      avatarHash: r["avatar_hash"] as string | null,
      kills: Number(r["kills"]),
    }));
  });

export const itemStrangeBoardQueryOptions = (defindex: number) =>
  queryOptions({
    queryKey: ["itemStrangeBoard", defindex],
    queryFn: () => fetchItemStrangeBoard({ data: { defindex } }),
  });
