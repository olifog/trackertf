import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { schema } from "@trackertf/db";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { qualityRank } from "#/lib/quality";
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
  quality: number;
  strangeKills: number;
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
      select e.class_num, e.slot, e.defindex, e.quality, e.strange_kills,
             s.item_name, s.name, s.image_url
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
        quality: (e["quality"] as number | null) ?? 6,
        strangeKills: (e["strange_kills"] as number | null) ?? 0,
        itemName: e["item_name"] as string | null,
        name: e["name"] as string | null,
        imageUrl: e["image_url"] as string | null,
      })),
    };
  });

/**
 * User-initiated recrawl request. Inserts the player into the crawl frontier at
 * a priority above the scheduler's own recrawls (1) but below new-player seeds
 * (5), so a manual "refresh me" jumps the queue without starving discovery. The
 * web DB role has INSERT-only on crawl_frontier with `on conflict do nothing`,
 * so this is inherently abuse-safe: at most one pending row per steamid, and a
 * repeat request while one is pending is a no-op (returns alreadyQueued). We
 * only enqueue players we already know — unknown steamids seed via fetchPlayer.
 */
export const requestRecrawl = createServerFn({ method: "POST" })
  .validator(z.object({ steamid: z.string().regex(/^\d{17}$/) }))
  .handler(async ({ data }): Promise<{ queued: boolean; alreadyQueued: boolean }> => {
    const db = getDb();
    try {
      const rows = (await db.execute(sql`
        insert into crawl_frontier (steamid, source, priority)
        values (${data.steamid}, 'recrawl', 3)
        on conflict (steamid) do nothing
        returning steamid
      `)) as unknown as unknown[];
      // a returned row means we inserted; none means a pending row already existed
      return { queued: true, alreadyQueued: rows.length === 0 };
    } catch {
      return { queued: false, alreadyQueued: false };
    }
  });

export interface InventoryRow {
  defindex: number;
  quality: number;
  count: number;
  itemName: string | null;
  name: string | null;
  imageUrl: string | null;
}

/**
 * Full backpack, aggregated server-side to (defindex, quality, count) — big
 * backpacks are ~1000 distinct rows vs ~3000 raw items, and the payload only
 * travels once per row.
 */
export const fetchPlayerInventory = createServerFn({ method: "GET" })
  .validator(z.object({ steamid: z.string().regex(/^\d{17}$/) }))
  .handler(async ({ data }): Promise<InventoryRow[]> => {
    const db = getDb();
    const rows = (await db.execute(sql`
      select i.defindex, i.quality, count(*)::int as count,
             s.item_name, s.name, s.image_url
      from player_items_raw r
      cross join lateral (
        select (item ->> 'defindex')::int as defindex,
               coalesce((item ->> 'quality')::int, 6) as quality
        from jsonb_array_elements(r.payload) item
      ) i
      left join item_schema s on s.defindex = i.defindex
      where r.steamid = ${data.steamid}
      group by i.defindex, i.quality, s.item_name, s.name, s.image_url
    `)) as unknown as Record<string, unknown>[];

    return rows
      .map((r) => ({
        defindex: r["defindex"] as number,
        quality: r["quality"] as number,
        count: r["count"] as number,
        itemName: r["item_name"] as string | null,
        name: r["name"] as string | null,
        imageUrl: r["image_url"] as string | null,
      }))
      .toSorted(
        (a, b) => qualityRank(a.quality) - qualityRank(b.quality) || a.defindex - b.defindex,
      );
  });

export interface FriendRow {
  steamid: string;
  friendSince: number;
  personaname: string | null;
  avatarHash: string | null;
}

export interface FriendsResponse {
  /** false = no friend list stored (only BFS-expanded players get one) */
  hasData: boolean;
  totalFriends: number;
  /** friends that exist in the players table (crawled), oldest first */
  friends: FriendRow[];
}

export const fetchPlayerFriends = createServerFn({ method: "GET" })
  .validator(z.object({ steamid: z.string().regex(/^\d{17}$/) }))
  .handler(async ({ data }): Promise<FriendsResponse> => {
    const db = getDb();
    const totals = (await db.execute(sql`
      select jsonb_array_length(payload)::int as total
      from player_friends_raw
      where steamid = ${data.steamid}
    `)) as unknown as Record<string, unknown>[];
    const total = totals[0]?.["total"] as number | undefined;
    if (total === undefined) return { hasData: false, totalFriends: 0, friends: [] };

    const rows = (await db.execute(sql`
      select f ->> 'steamid' as steamid,
             coalesce((f ->> 'friend_since')::bigint, 0) as friend_since,
             p.personaname, p.avatar_hash
      from player_friends_raw r
      cross join lateral jsonb_array_elements(r.payload) f
      join players p on p.steamid = f ->> 'steamid'
      where r.steamid = ${data.steamid}
      order by friend_since
    `)) as unknown as Record<string, unknown>[];

    return {
      hasData: true,
      totalFriends: total,
      friends: rows.map((r) => ({
        steamid: r["steamid"] as string,
        friendSince: Number(r["friend_since"]),
        personaname: r["personaname"] as string | null,
        avatarHash: r["avatar_hash"] as string | null,
      })),
    };
  });

export interface FriendRankRow {
  metric: "playtime" | "kills" | "points";
  label: string;
  /** 1-based rank among ranked friends (1 = best) */
  rank: number;
  /** raw value: hours for playtime, counts otherwise */
  value: number;
}

export interface FriendRanksResponse {
  /** true only when the player is rankable and has at least one ranked friend */
  hasData: boolean;
  /** number of ranked players in the friend population (incl. the player) */
  total: number;
  ranks: FriendRankRow[];
}

/**
 * Ranks this player among their crawled friends (plus themself) on lifetime
 * playtime / kills / points. Population mirrors the global leaderboards' filter
 * (public persona, no VAC ban — see packages/db/src/boards.ts POP) but is scoped
 * to the friend set. rank = 1 + (friends strictly ahead), matching SQL rank().
 */
export const fetchFriendRanks = createServerFn({ method: "GET" })
  .validator(z.object({ steamid: z.string().regex(/^\d{17}$/) }))
  .handler(async ({ data }): Promise<FriendRanksResponse> => {
    const db = getDb();
    const rows = (await db.execute(sql`
      with friend_ids as (
        select f ->> 'steamid' as steamid
        from player_friends_raw r
        cross join lateral jsonb_array_elements(r.payload) f
        where r.steamid = ${data.steamid}
        union
        select ${data.steamid}
      ),
      pop as (
        select c.steamid,
          sum(c.playtime_seconds) as playtime,
          sum(c.kills) as kills,
          sum(c.points_scored) as points
        from player_class_stats c
        join players p using (steamid)
        where c.steamid in (select steamid from friend_ids)
          and p.personaname is not null and p.vac_banned = false
        group by c.steamid
      ),
      me as (select * from pop where steamid = ${data.steamid})
      select
        (select count(*)::int from pop) as total,
        (select playtime from me) as me_playtime,
        (select kills from me) as me_kills,
        (select points from me) as me_points,
        (select (1 + count(*))::int from pop
           where pop.playtime > (select playtime from me)) as rank_playtime,
        (select (1 + count(*))::int from pop
           where pop.kills > (select kills from me)) as rank_kills,
        (select (1 + count(*))::int from pop
           where pop.points > (select points from me)) as rank_points
    `)) as unknown as Record<string, unknown>[];

    const r = rows[0];
    const total = Number(r?.["total"] ?? 0);
    // rankable only when the player is in the population and has friends there
    if (!r || r["me_playtime"] == null || total < 2) {
      return { hasData: false, total, ranks: [] };
    }

    const ranks: FriendRankRow[] = [
      {
        metric: "playtime",
        label: "Hours played",
        rank: Number(r["rank_playtime"]),
        value: Number(r["me_playtime"]) / 3600,
      },
      {
        metric: "kills",
        label: "Kills",
        rank: Number(r["rank_kills"]),
        value: Number(r["me_kills"]),
      },
      {
        metric: "points",
        label: "Points scored",
        rank: Number(r["rank_points"]),
        value: Number(r["me_points"]),
      },
    ];
    return { hasData: true, total, ranks };
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

export const playerInventoryQueryOptions = (steamid: string) =>
  queryOptions({
    queryKey: ["player-inventory", steamid],
    queryFn: () => fetchPlayerInventory({ data: { steamid } }),
  });

export const playerFriendsQueryOptions = (steamid: string) =>
  queryOptions({
    queryKey: ["player-friends", steamid],
    queryFn: () => fetchPlayerFriends({ data: { steamid } }),
  });

export const friendRanksQueryOptions = (steamid: string) =>
  queryOptions({
    queryKey: ["friend-ranks", steamid],
    queryFn: () => fetchFriendRanks({ data: { steamid } }),
  });
