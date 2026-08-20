import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "./db.ts";

/**
 * Reconstructed play SESSIONS from the attributor's `stat_windows` table
 * (apps/crawler/src/attributor.ts). A window is the interval between two of a
 * player's consecutive lifetime-stat snapshots; its `class_deltas` are the
 * per-class playtime seconds gained across it, and `map` is set when the
 * player's attributed sampler segments over that window covered exactly one map.
 *
 * We surface only REAL play windows — reset=false (no bogus negative delta) and
 * playtime_delta_sec > 0 (stats actually moved) — as "sessions": when they
 * played, for how long, on which class(es), and on which map when we can pin it.
 * Windows are only built for players the attributor has matched to sampler
 * observations, so most profiles have none — the section then simply doesn't
 * render (see the player route), which is the honest empty state.
 */

const num = (v: unknown): number => (v == null ? 0 : Number(v));

/** how many recent sessions to surface */
const SESSION_LIMIT = 25;

export interface SessionClass {
  classNum: number;
  seconds: number;
}

export interface PlaySession {
  /** unix seconds — snapshot pair endpoints bracketing the play window */
  startedAt: number;
  endedAt: number;
  /** total class playtime gained across the window, seconds */
  playtimeSeconds: number;
  /** the single map played when the window is map-pure, else null */
  map: string | null;
  /** classes played across the window, most-played first */
  classes: SessionClass[];
}

export interface PlayerSessions {
  sessions: PlaySession[];
}

export const fetchPlayerSessions = createServerFn({ method: "GET" })
  .validator(z.object({ steamid: z.string().regex(/^\d{17}$/) }))
  .handler(async ({ data }): Promise<PlayerSessions> => {
    const db = getDb();
    // Decorative, best-effort section (one of several the player-page loader
    // awaits together). `stat_windows` is a newer table that needs its own
    // `GRANT SELECT ... TO web_ro`; if that's missing — or any other read fails
    // — fail soft to no sessions rather than 500 the entire player page.
    let rows: Record<string, unknown>[];
    try {
      rows = (await db.execute(sql`
        select extract(epoch from started_at)::bigint as started_unix,
               extract(epoch from ended_at)::bigint as ended_unix,
               playtime_delta_sec, map, class_deltas
        from stat_windows
        where steamid = ${data.steamid}
          and reset = false
          and playtime_delta_sec > 0
        order by ended_at desc
        limit ${SESSION_LIMIT}
      `)) as unknown as Record<string, unknown>[];
    } catch (err) {
      console.error(`fetchPlayerSessions failed for ${data.steamid}:`, err);
      return { sessions: [] };
    }

    const sessions: PlaySession[] = rows.map((r) => {
      // class_deltas is jsonb → an object of { "<classNum>": seconds }
      const deltas = (r["class_deltas"] ?? {}) as Record<string, unknown>;
      const classes: SessionClass[] = Object.entries(deltas)
        .map(([k, v]) => ({ classNum: Number(k), seconds: num(v) }))
        .filter((c) => c.seconds > 0)
        .toSorted((a, b) => b.seconds - a.seconds);
      return {
        startedAt: num(r["started_unix"]),
        endedAt: num(r["ended_unix"]),
        playtimeSeconds: num(r["playtime_delta_sec"]),
        map: (r["map"] as string | null) ?? null,
        classes,
      };
    });

    return { sessions };
  });

export const playerSessionsQueryOptions = (steamid: string) =>
  queryOptions({
    queryKey: ["player-sessions", steamid],
    queryFn: () => fetchPlayerSessions({ data: { steamid } }),
  });
