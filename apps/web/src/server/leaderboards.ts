import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import {
  BOARD_MAP,
  type BoardDef,
  boardCountSql,
  boardSelectSql,
  hoursRankSql,
  playerRanksSql,
} from "@trackertf/db/boards";
import { sql } from "drizzle-orm";
import { z } from "zod";
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

const boardKeySchema = z
  .string()
  .refine((key): key is string => BOARD_MAP.has(key), "unknown board");

export const fetchLeaderboard = createServerFn({ method: "GET" })
  .validator(z.object({ board: boardKeySchema }))
  .handler(async ({ data }): Promise<LeaderboardResponse> => {
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
 * The player's live rank on every board, computed with window functions:
 * one pass over player_class_stats (all metric/scope/kind cells) plus one
 * over players (hours board). Sorted by rank percentile, best first.
 */
export const fetchPlayerRanks = createServerFn({ method: "GET" })
  .validator(z.object({ steamid: z.string().regex(/^\d{17}$/) }))
  .handler(async ({ data }): Promise<PlayerRankRow[]> => {
    const db = getDb();
    const [classRows, hoursRows] = await Promise.all([
      db.execute(sql`
        ${sql.raw(playerRanksSql())}
        select scope, metric, kind, value, rnk, participants
        from ranked where steamid = ${data.steamid}
      `) as unknown as Promise<Record<string, unknown>[]>,
      db.execute(sql`
        select rnk, participants, value
        from (${sql.raw(hoursRankSql())}) h
        where h.steamid = ${data.steamid}
      `) as unknown as Promise<Record<string, unknown>[]>,
    ]);

    const ranks: PlayerRankRow[] = [];
    for (const r of classRows) {
      const scope = (r["scope"] as number) === 0 ? "overall" : (r["scope"] as number);
      const key = `${r["metric"] as string}:${scope}:${r["kind"] as string}`;
      const def = BOARD_MAP.get(key);
      if (!def) continue;
      ranks.push({
        boardKey: key,
        label: def.label,
        rank: r["rnk"] as number,
        of: r["participants"] as number,
        value: r["value"] as number,
      });
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
