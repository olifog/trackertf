import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "./db.ts";

export interface LeaderRow {
  steamid: string;
  personaname: string | null;
  avatarHash: string | null;
  value: number;
  classNum: number | null;
}

const BOARDS = {
  hours: {
    label: "Most TF2 hours",
    sql: sql`
      select p.steamid, p.personaname, p.avatar_hash, (p.tf2_minutes / 60)::int value, null::int class_num
      from players p
      where p.tf2_minutes is not null and p.personaname is not null and p.vac_banned = false
      order by p.tf2_minutes desc limit 50`,
  },
  kills: {
    label: "Most lifetime kills (all classes)",
    sql: sql`
      select p.steamid, p.personaname, p.avatar_hash, sum(c.kills)::int value, null::int class_num
      from players p join player_class_stats c using (steamid)
      where p.personaname is not null and p.vac_banned = false
      group by p.steamid, p.personaname, p.avatar_hash
      order by value desc limit 50`,
  },
  killsPerHour: {
    label: "Kills per hour (best class, 50h+ on it)",
    sql: sql`
      select distinct on (p.steamid)
        p.steamid, p.personaname, p.avatar_hash,
        round((c.kills::real * 3600 / c.playtime_seconds)::numeric, 1)::real value, c.class_num
      from players p join player_class_stats c using (steamid)
      where p.personaname is not null and p.vac_banned = false and c.playtime_seconds >= 180000
      order by p.steamid, value desc`,
  },
  pointsPerMin: {
    label: "Points per minute (best class, 50h+ on it)",
    sql: sql`
      select distinct on (p.steamid)
        p.steamid, p.personaname, p.avatar_hash,
        round((c.points_scored::real * 60 / c.playtime_seconds)::numeric, 2)::real value, c.class_num
      from players p join player_class_stats c using (steamid)
      where p.personaname is not null and p.vac_banned = false and c.playtime_seconds >= 180000
      order by p.steamid, value desc`,
  },
} as const;

export type BoardKey = keyof typeof BOARDS;
export const BOARD_LABELS: Record<BoardKey, string> = {
  hours: BOARDS.hours.label,
  kills: BOARDS.kills.label,
  killsPerHour: BOARDS.killsPerHour.label,
  pointsPerMin: BOARDS.pointsPerMin.label,
};

export const fetchLeaderboard = createServerFn({ method: "GET" })
  .validator(z.object({ board: z.enum(["hours", "kills", "killsPerHour", "pointsPerMin"]) }))
  .handler(async ({ data }): Promise<LeaderRow[]> => {
    const db = getDb();
    let rows = (await db.execute(BOARDS[data.board].sql)) as unknown as Record<string, unknown>[];
    // distinct-on boards need a re-sort + trim
    if (data.board === "killsPerHour" || data.board === "pointsPerMin") {
      rows = rows.toSorted((a, b) => (b["value"] as number) - (a["value"] as number)).slice(0, 50);
    }
    return rows.map((r) => ({
      steamid: r["steamid"] as string,
      personaname: r["personaname"] as string | null,
      avatarHash: r["avatar_hash"] as string | null,
      value: r["value"] as number,
      classNum: r["class_num"] as number | null,
    }));
  });

export const leaderboardQueryOptions = (board: BoardKey) =>
  queryOptions({
    queryKey: ["leaderboard", board],
    queryFn: () => fetchLeaderboard({ data: { board } }),
  });
