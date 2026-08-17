import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { schema } from "@trackertf/db";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "./db.ts";

export interface PlayerClassRow {
  classNum: number;
  playtimeSeconds: number;
  kills: number;
  killAssists: number;
  damageDealt: number;
  pointsScored: number;
  dominations: number;
  captures: number;
  defenses: number;
}

export interface EquippedRow {
  classNum: number;
  slot: number;
  defindex: number;
  itemName: string | null;
  name: string | null;
  imageUrl: string | null;
}

export interface PlayerResponse {
  found: boolean;
  queued: boolean;
  steamid: string;
  personaname: string | null;
  avatarHash: string | null;
  tf2Minutes: number | null;
  tf2Minutes2wk: number | null;
  visibility: number | null;
  vacBanned: boolean | null;
  itemsStatus: string | null;
  statsStatus: string | null;
  lastCrawled: string | null;
  classStats: PlayerClassRow[];
  equipped: EquippedRow[];
}

export const fetchPlayer = createServerFn({ method: "GET" })
  .validator(z.object({ steamid: z.string().regex(/^\d{17}$/) }))
  .handler(async ({ data }): Promise<PlayerResponse> => {
    const db = getDb();
    const [p] = await db
      .select()
      .from(schema.players)
      .where(eq(schema.players.steamid, data.steamid))
      .limit(1);

    if (!p) {
      // unknown player: enqueue for crawl (web role has INSERT on frontier only)
      let queued = false;
      try {
        await db.execute(sql`
          insert into crawl_frontier (steamid, source, priority)
          values (${data.steamid}, 'seed', 5)
          on conflict (steamid) do nothing
        `);
        queued = true;
      } catch {
        queued = false;
      }
      return {
        found: false,
        queued,
        steamid: data.steamid,
        personaname: null,
        avatarHash: null,
        tf2Minutes: null,
        tf2Minutes2wk: null,
        visibility: null,
        vacBanned: null,
        itemsStatus: null,
        statsStatus: null,
        lastCrawled: null,
        classStats: [],
        equipped: [],
      };
    }

    const classStats = await db
      .select({
        classNum: schema.playerClassStats.classNum,
        playtimeSeconds: schema.playerClassStats.playtimeSeconds,
        kills: schema.playerClassStats.kills,
        killAssists: schema.playerClassStats.killAssists,
        damageDealt: schema.playerClassStats.damageDealt,
        pointsScored: schema.playerClassStats.pointsScored,
        dominations: schema.playerClassStats.dominations,
        captures: schema.playerClassStats.captures,
        defenses: schema.playerClassStats.defenses,
      })
      .from(schema.playerClassStats)
      .where(eq(schema.playerClassStats.steamid, data.steamid));

    const equipped = (await db.execute(sql`
      select e.class_num, e.slot, e.defindex, s.item_name, s.name, s.image_url
      from equipped_items e
      left join item_schema s using (defindex)
      where e.steamid = ${data.steamid}
      order by e.class_num, e.slot
    `)) as unknown as Record<string, unknown>[];

    return {
      found: true,
      queued: false,
      steamid: p.steamid,
      personaname: p.personaname,
      avatarHash: p.avatarHash,
      tf2Minutes: p.tf2Minutes,
      tf2Minutes2wk: p.tf2Minutes2wk,
      visibility: p.visibility,
      vacBanned: p.vacBanned,
      itemsStatus: p.itemsStatus,
      statsStatus: p.statsStatus,
      lastCrawled: p.lastCrawled?.toISOString() ?? null,
      classStats,
      equipped: equipped.map((e) => ({
        classNum: e["class_num"] as number,
        slot: e["slot"] as number,
        defindex: e["defindex"] as number,
        itemName: e["item_name"] as string | null,
        name: e["name"] as string | null,
        imageUrl: e["image_url"] as string | null,
      })),
    };
  });

/** Accepts a steamid64, a profile URL, or a vanity name → steamid64. */
export const lookupPlayer = createServerFn({ method: "GET" })
  .validator(z.object({ query: z.string().trim().min(1).max(200) }))
  .handler(async ({ data }): Promise<{ steamid: string | null }> => {
    const q = data.query.trim();
    const idMatch = q.match(/(?:^|\/profiles\/)(\d{17})(?:\/|$)/);
    if (idMatch) return { steamid: idMatch[1] as string };
    const vanity = (q.match(/\/id\/([^/]+)/)?.[1] ?? q).replace(/[^\w-]/g, "");
    if (!vanity) return { steamid: null };
    const key = process.env["STEAM_API_KEY"];
    if (!key) return { steamid: null };
    const res = await fetch(
      `https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/?key=${key}&vanityurl=${encodeURIComponent(vanity)}`,
    );
    if (!res.ok) return { steamid: null };
    const json = (await res.json()) as { response?: { steamid?: string } };
    return { steamid: json.response?.steamid ?? null };
  });

export const playerQueryOptions = (steamid: string) =>
  queryOptions({
    queryKey: ["player", steamid],
    queryFn: () => fetchPlayer({ data: { steamid } }),
  });
