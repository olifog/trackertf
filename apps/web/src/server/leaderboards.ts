import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { chQuery } from "@trackertf/clickhouse";
import {
  BOARD_MAP,
  type BoardDef,
  boardCountSql,
  boardSelectSql,
  hoursRankSql,
  METRICS,
  playerRanksAggSql,
  playerRanksSql,
  RATE_THRESHOLD_HOURS,
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
export const STRANGE_BOARD_KEYS = ["strange:total", "strange:max"] as const;
export type StrangeBoardKey = (typeof STRANGE_BOARD_KEYS)[number];
const STRANGE_KEY_SET: ReadonlySet<string> = new Set(STRANGE_BOARD_KEYS);
export const isStrangeBoard = (key: string): key is StrangeBoardKey =>
  STRANGE_KEY_SET.has(key);

const boardKeySchema = z
  .string()
  .refine((key): key is string => BOARD_MAP.has(key) || isStrangeBoard(key), "unknown board");

/**
 * Strange-kill leaderboard: rank crawled players by kills on their Strange
 * (quality 11) equipped items. `strange:total` sums every equipped Strange
 * counter a player is displaying; `strange:max` takes their single highest
 * counter. Sourced from ClickHouse `equipped` (the only place quality /
 * strange_kills live), then joined back to Postgres `players` for persona /
 * avatar and the POP filter (public persona, no VAC ban, botness < 0.5 — the
 * same bot/outlier exclusion boards.ts applies to the grid boards).
 */
async function fetchStrangeBoard(board: StrangeBoardKey): Promise<LeaderboardResponse> {
  const agg = board === "strange:max" ? "max(strange_kills)" : "sum(strange_kills)";
  // over-fetch from CH so POP-filtered dropouts in PG still leave a full top-100
  const chRows = await chQuery<{ steamid: string; value: string | number }>(
    getCh(),
    `select toString(steamid) as steamid, toUInt64(${agg}) as value
     from equipped
     where quality = 11 and strange_kills > 0
     group by steamid
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
    where steamid = any(${ids})
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

export interface PlayerRankRow {
  boardKey: string;
  label: string;
  rank: number;
  of: number;
  value: number;
}

/**
 * The player's live rank on every board. One pass over player_class_stats that
 * counts, per scope, how many players are ahead of this player on each board
 * (playerRanksSql + playerRanksAggSql), plus one pass over players for the hours
 * board. Sorted by rank percentile, best first.
 *
 * The rank pass deliberately avoids ranking the whole population: an earlier
 * window-function version sorted millions of population×board rows on disk and
 * took ~22s. See playerRanksSql/playerRanksAggSql in boards.ts.
 */
export const fetchPlayerRanks = createServerFn({ method: "GET" })
  .validator(z.object({ steamid: z.string().regex(/^\d{17}$/) }))
  .handler(async ({ data }): Promise<PlayerRankRow[]> => {
    const db = getDb();
    const [scopeRows, hoursRows] = await Promise.all([
      db.execute(sql`
        ${sql.raw(playerRanksSql())}
        , me as (select * from scoped where steamid = ${data.steamid})
        ${sql.raw(playerRanksAggSql())}
      `) as unknown as Promise<Record<string, unknown>[]>,
      db.execute(sql`
        select rnk, participants, value
        from (${sql.raw(hoursRankSql())}) h
        where h.steamid = ${data.steamid}
      `) as unknown as Promise<Record<string, unknown>[]>,
    ]);

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
    const hours = hoursRows[0];
    if (hours) {
      const def = BOARD_MAP.get("hours") as BoardDef;
      ranks.push({
        boardKey: def.key,
        label: def.label,
        rank: hours["rnk"] as number,
        of: hours["participants"] as number,
        value: hours["value"] as number,
      });
    }
    return ranks.toSorted((a, b) => a.rank / a.of - b.rank / b.of);
  });

export const playerRanksQueryOptions = (steamid: string) =>
  queryOptions({
    queryKey: ["playerRanks", steamid],
    queryFn: () => fetchPlayerRanks({ data: { steamid } }),
  });
