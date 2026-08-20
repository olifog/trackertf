import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { sql } from "drizzle-orm";
import { getDb } from "./db.ts";
import { asGamemodeKey, gamemodeExpr, type GamemodeKey } from "./servers.ts";

/**
 * Class playtime attributed to each map, from `map_class_playtime` (Postgres,
 * rebuilt by apps/crawler/src/attributor.ts). The attributor takes the per-class
 * lifetime-playtime DELTA over "pure-map" stat windows — windows where the
 * player's high-confidence (>= 0.9) sampled segments all sat on ONE map — and
 * sums it into (map, class). So this answers "how does the class mix differ by
 * map": e.g. how much more Engineer time koth_ vs pl_ pulls. It's attributed,
 * not directly observed, so it accrues slowly and carries the usual name→profile
 * matching uncertainty; small maps are filtered out server-side.
 */

const num = (v: unknown): number => (v == null ? 0 : Number(v));

/** minimum attributed seconds for a map to appear (filters noise) */
const MIN_MAP_SECONDS = 3600;
/** most-attributed maps returned */
const MAP_LIMIT = 40;

export interface MapClassSlice {
  classNum: number;
  seconds: number;
  /** share of this map's attributed playtime, 0..1 */
  share: number;
}

export interface MapClassRow {
  map: string;
  gamemode: GamemodeKey;
  totalSeconds: number;
  /** floor on distinct attributed players (max over the map's classes) */
  players: number;
  classes: MapClassSlice[];
}

export interface MapClassData {
  maps: MapClassRow[];
  /** total attributed seconds across all returned maps */
  totalSeconds: number;
}

export const fetchMapClassPlaytime = createServerFn({ method: "GET" }).handler(
  async (): Promise<MapClassData> => {
    const db = getDb();
    const rows = (await db.execute(sql`
      select map, ${gamemodeExpr} as gamemode, class_num,
        playtime_seconds::bigint as seconds, players::int as players
      from map_class_playtime
      order by map, class_num
    `)) as unknown as Record<string, unknown>[];

    const byMap = new Map<string, MapClassRow>();
    for (const r of rows) {
      const map = String(r["map"]);
      let row = byMap.get(map);
      if (!row) {
        row = {
          map,
          gamemode: asGamemodeKey(r["gamemode"]),
          totalSeconds: 0,
          players: 0,
          classes: [],
        };
        byMap.set(map, row);
      }
      const seconds = num(r["seconds"]);
      row.classes.push({ classNum: num(r["class_num"]), seconds, share: 0 });
      row.totalSeconds += seconds;
      row.players = Math.max(row.players, num(r["players"]));
    }

    const maps = [...byMap.values()]
      .filter((m) => m.totalSeconds >= MIN_MAP_SECONDS)
      .sort((a, b) => b.totalSeconds - a.totalSeconds)
      .slice(0, MAP_LIMIT);
    for (const m of maps) {
      for (const c of m.classes) c.share = m.totalSeconds > 0 ? c.seconds / m.totalSeconds : 0;
      m.classes.sort((a, b) => b.seconds - a.seconds);
    }

    return { maps, totalSeconds: maps.reduce((s, m) => s + m.totalSeconds, 0) };
  },
);

export const mapClassPlaytimeQueryOptions = () =>
  queryOptions({
    queryKey: ["mapClassPlaytime"],
    queryFn: () => fetchMapClassPlaytime(),
  });
