import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { chQuery } from "@trackertf/clickhouse";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { getCh } from "./ch.ts";
import { getDb } from "./db.ts";
import { asGamemodeKey, gamemodeExpr, type GamemodeKey } from "./servers.ts";

/**
 * Everything we can honestly say about ONE map, pulled together for an
 * expandable per-map panel on the matches page. Three of the four surfaces are
 * genuinely per-map:
 *   - classMix   — attributed per-class playtime for this map (map_class_playtime,
 *                  Postgres; see server/mapClass.ts). Inferred, accrues slowly.
 *   - topScorers — fastest DIRECTLY-OBSERVED scorers on this map (ClickHouse
 *                  match_obs filtered to the map). Same measured pts/hr as the
 *                  main leaderboard, just scoped. Names are display names.
 *   - regulars   — the profiles the attributor committed to (>= 0.9) most often
 *                  across this map's sampled segments (segment_attributions ⋈
 *                  match_segments). "Who turns up here", honestly attributed.
 * The fourth, `weapons`, is DELIBERATELY indirect and labelled as such in the
 * UI: TF2 carries no per-map weapon telemetry anywhere in our pipeline, so this
 * is the *global* loadout of the map's regulars (CH equipped), NOT weapon
 * performance on the map. It only appears once a map has enough regulars to
 * mean anything; otherwise it stays empty rather than mislead.
 */

const num = (v: unknown): number => (v == null ? 0 : Number(v));

/** min distinct attributed regulars before the (indirect) weapons panel shows */
const WEAPONS_MIN_REGULARS = 12;
/** cap the regular-steamid set fed into the CH equipped scan */
const REGULARS_SCAN_CAP = 500;

export interface MapClassSlice {
  classNum: number;
  seconds: number;
  /** share of the map's attributed playtime, 0..1 */
  share: number;
}

export interface MapScorer {
  name: string;
  segmentId: string;
  region: number;
  pointsPerHour: number;
  windowSec: number;
  observations: number;
  firstScore: number;
  lastScore: number;
}

export interface MapRegular {
  steamid: string;
  personaname: string | null;
  avatarHash: string | null;
  /** distinct sampled segments on THIS map the player was attributed to */
  segments: number;
}

export interface MapWeapon {
  defindex: number;
  name: string;
  imageUrl: string | null;
  slot: string | null;
  /** distinct regulars of this map who equip an item in this weapon group */
  players: number;
}

export interface MapDetail {
  map: string;
  gamemode: GamemodeKey;
  classMix: MapClassSlice[];
  totalSeconds: number;
  /** floor on distinct attributed players over the map's classes */
  classPlayers: number;
  windows: number;
  topScorers: MapScorer[];
  regulars: MapRegular[];
  /** total distinct >= 0.9-attributed profiles seen on this map (POP-filtered) */
  regularCount: number;
  /** indirect: the map regulars' global loadouts; empty until enough regulars */
  weapons: MapWeapon[];
}

const mapSchema = z.object({ map: z.string().min(1).max(64) });

export const fetchMapDetail = createServerFn({ method: "GET" })
  .validator(mapSchema)
  .handler(async ({ data }): Promise<MapDetail> => {
    const db = getDb();
    const map = data.map.toLowerCase();

    // 1) attributed per-class playtime for the map
    const classRows = (await db.execute(sql`
      select class_num, playtime_seconds::bigint as seconds,
        players::int as players, windows::int as windows,
        ${gamemodeExpr} as gamemode
      from map_class_playtime
      where map = ${map}
      order by class_num
    `)) as unknown as Record<string, unknown>[];

    let totalSeconds = 0;
    let classPlayers = 0;
    let windows = 0;
    let gamemode: GamemodeKey = "other";
    const classMix: MapClassSlice[] = classRows.map((r) => {
      const seconds = num(r["seconds"]);
      totalSeconds += seconds;
      classPlayers = Math.max(classPlayers, num(r["players"]));
      windows += num(r["windows"]);
      gamemode = asGamemodeKey(r["gamemode"]);
      return { classNum: num(r["class_num"]), seconds, share: 0 };
    });
    for (const c of classMix) c.share = totalSeconds > 0 ? c.seconds / totalSeconds : 0;
    classMix.sort((a, b) => b.seconds - a.seconds);

    // 2) fastest directly-observed scorers on this map (CH match_obs), same
    //    measured pts/hr guards as the main leaderboard
    const scorerRows = await chQuery<Record<string, unknown>>(
      getCh(),
      `select name, toString(segment_id) as segment_id, region,
        first_score, last_score, observations,
        (toUnixTimestamp(last_seen) - toUnixTimestamp(first_seen)) as window_sec,
        (last_score - first_score) * 3600.0
          / (toUnixTimestamp(last_seen) - toUnixTimestamp(first_seen)) as pph
      from match_obs
      where map = {map:String}
        and observations >= 3
        and last_seen > first_seen
        and (toUnixTimestamp(last_seen) - toUnixTimestamp(first_seen)) >= 300
        and last_score >= first_score
      order by pph desc
      limit 15`,
      { map },
    );
    const topScorers: MapScorer[] = scorerRows.map((r) => ({
      name: String(r["name"]),
      segmentId: String(r["segment_id"]),
      region: num(r["region"]),
      pointsPerHour: num(r["pph"]),
      windowSec: num(r["window_sec"]),
      observations: num(r["observations"]),
      firstScore: num(r["first_score"]),
      lastScore: num(r["last_score"]),
    }));

    // 3) regulars: profiles attributed (>= 0.9) most often across this map's
    //    segments, POP-filtered the same way the leaderboards are. One pass
    //    returns the full POP-filtered set ordered by segment count; the head
    //    is shown, the whole set (capped) feeds the weapons scan.
    const regularRows = (await db.execute(sql`
      select sa.steamid, count(distinct sa.segment_id)::int as segments,
        p.personaname, p.avatar_hash
      from segment_attributions sa
      join match_segments ms on ms.id = sa.segment_id
      join players p on p.steamid = sa.steamid
      where ms.map = ${map}
        and sa.confidence >= 0.9
        and p.personaname is not null
        and p.vac_banned = false
        and coalesce(p.botness, 0) < 0.5
      group by sa.steamid, p.personaname, p.avatar_hash
      order by segments desc, sa.steamid
      limit ${REGULARS_SCAN_CAP}
    `)) as unknown as Record<string, unknown>[];

    const regularCount = regularRows.length;
    const regulars: MapRegular[] = regularRows.slice(0, 12).map((r) => ({
      steamid: String(r["steamid"]),
      personaname: (r["personaname"] as string | null) ?? null,
      avatarHash: (r["avatar_hash"] as string | null) ?? null,
      segments: num(r["segments"]),
    }));

    // 4) indirect "what the regulars run" — global loadouts of the map's
    //    regulars. Only when there are enough of them to mean anything.
    let weapons: MapWeapon[] = [];
    if (regularCount >= WEAPONS_MIN_REGULARS) {
      const ids = regularRows.map((r) => String(r["steamid"]));
      // weapon slots only (0-6); group by weapon group id, count distinct
      // regulars, keep a representative defindex to resolve name/image in PG.
      const gidRows = await chQuery<Record<string, unknown>>(
        getCh(),
        `select gid, toUInt32(any(defindex)) as defindex,
          toUInt32(uniqExact(steamid)) as players
        from equipped
        where steamid in {ids:Array(UInt64)}
          and slot >= 0 and slot <= 6
        group by gid
        order by players desc
        limit 12`,
        { ids },
      );
      const defindexes = [...new Set(gidRows.map((r) => num(r["defindex"])))];
      const items =
        defindexes.length > 0
          ? ((await db.execute(sql`
              select defindex, name, item_name, image_url, slot
              from item_schema
              where defindex in ${defindexes}
            `)) as unknown as Record<string, unknown>[])
          : [];
      const itemByDef = new Map(items.map((r) => [num(r["defindex"]), r]));
      weapons = gidRows
        .map((r) => {
          const defindex = num(r["defindex"]);
          const item = itemByDef.get(defindex);
          const name = item
            ? String(item["item_name"] ?? item["name"] ?? `#${defindex}`)
            : `#${defindex}`;
          return {
            defindex,
            name,
            imageUrl: (item?.["image_url"] as string | null) ?? null,
            slot: (item?.["slot"] as string | null) ?? null,
            players: num(r["players"]),
          };
        })
        // items missing from the schema fall back to a raw defindex label; keep
        // only the ones we could name so the panel reads cleanly
        .filter((w) => !w.name.startsWith("#"));
    }

    return {
      map,
      gamemode,
      classMix,
      totalSeconds,
      classPlayers,
      windows,
      topScorers,
      regulars,
      regularCount,
      weapons,
    };
  });

export const mapDetailQueryOptions = (map: string) =>
  queryOptions({
    queryKey: ["mapDetail", map],
    queryFn: () => fetchMapDetail({ data: { map } }),
    enabled: map.length > 0,
  });
