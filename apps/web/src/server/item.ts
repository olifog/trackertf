import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { chQuery } from "@trackertf/clickhouse";
import { schema } from "@trackertf/db";
import { eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { getCh } from "./ch.ts";
import { getDb } from "./db.ts";
import { HALE_OWN_KILLS } from "./leaderboards.ts";

export interface ItemInfo {
  defindex: number;
  name: string | null;
  itemName: string | null;
  imageUrl: string | null;
  slot: string | null;
  usedByClasses: number[];
  reskinGroup: number | null;
}

export interface ItemUsageCell {
  classNum: number;
  activeOnly: boolean;
  minutesThreshold: number;
  usage: number;
  count: number;
  sampleSize: number;
}

export interface ItemPerf {
  classNum: number;
  players: number;
  avgPointsPerMin: number;
  avgKillsPerHour: number;
  avgDamagePerMin: number;
}

export interface VariantQuality {
  defindex: number;
  quality: number;
  count: number;
}

export interface ItemResponse {
  item: ItemInfo;
  groupMembers: ItemInfo[];
  /** merged usage per class × population (slot=-1 rows) */
  usage: ItemUsageCell[];
  perf: ItemPerf[];
  /** equip counts per (variant defindex, quality) across the group */
  variantQualities: VariantQuality[];
}

const toInfo = (r: typeof schema.itemSchema.$inferSelect): ItemInfo => ({
  defindex: r.defindex,
  name: r.name,
  itemName: r.itemName,
  imageUrl: r.imageUrl,
  slot: r.slot,
  usedByClasses: r.usedByClasses,
  reskinGroup: r.reskinGroup,
});

export const fetchItem = createServerFn({ method: "GET" })
  .validator(z.object({ defindex: z.number().int().nonnegative() }))
  .handler(async ({ data }): Promise<ItemResponse | null> => {
    const db = getDb();
    const [item] = await db
      .select()
      .from(schema.itemSchema)
      .where(eq(schema.itemSchema.defindex, data.defindex))
      .limit(1);
    if (!item) return null;

    const groupId = item.reskinGroup ?? item.defindex;
    const groupMembers = item.reskinGroup
      ? await db
          .select()
          .from(schema.itemSchema)
          .where(eq(schema.itemSchema.reskinGroup, item.reskinGroup))
      : [];

    const groupDefindexes =
      groupMembers.length > 0 ? groupMembers.map((m) => m.defindex) : [item.defindex];

    // variantQualities, usage and perf are independent reads once the group is
    // known — fire them concurrently rather than in series (postgres.js pools).
    const [variantQualities, usage, perf] = await Promise.all([
      db.execute(sql`
        select defindex, quality, count(*)::int as count
        from equipped_items
        where defindex in (${sql.join(groupDefindexes, sql`, `)})
        group by defindex, quality
      `) as unknown as Promise<Record<string, unknown>[]>,
      // usage_stats now buckets populations (active_minutes_2wk × minutes) —
      // keep this page's original 2×2 matrix by selecting the matching buckets
      db.execute(sql`
        select class_num, (active_minutes_2wk >= 1) as active_only, minutes_threshold,
               usage, count, sample_size
        from usage_stats
        where defindex = ${groupId} and slot = -1 and merge_reskins
          and active_minutes_2wk in (0, 1) and minutes_threshold in (0, 120000)
        order by class_num
      `) as unknown as Promise<Record<string, unknown>[]>,
      db
        .select({
          classNum: schema.weaponClassStats.classNum,
          players: schema.weaponClassStats.players,
          avgPointsPerMin: schema.weaponClassStats.avgPointsPerMin,
          avgKillsPerHour: schema.weaponClassStats.avgKillsPerHour,
          avgDamagePerMin: schema.weaponClassStats.avgDamagePerMin,
        })
        .from(schema.weaponClassStats)
        .where(
          or(
            eq(schema.weaponClassStats.defindex, groupId),
            inArray(
              schema.weaponClassStats.defindex,
              // stock melee ids the pan family folds into on class views
              item.reskinGroup === 264 || item.defindex === 264
                ? [0, 1, 2, 3, 4, 5, 6, 7, 8]
                : [groupId],
            ),
          ),
        ),
    ]);

    return {
      item: toInfo(item),
      groupMembers: groupMembers.map(toInfo),
      usage: usage.map((u) => ({
        classNum: u["class_num"] as number,
        activeOnly: u["active_only"] as boolean,
        minutesThreshold: u["minutes_threshold"] as number,
        usage: u["usage"] as number,
        count: u["count"] as number,
        sampleSize: u["sample_size"] as number,
      })),
      perf,
      variantQualities: variantQualities.map((v) => ({
        defindex: v["defindex"] as number,
        quality: v["quality"] as number,
        count: v["count"] as number,
      })),
    };
  });

export const itemQueryOptions = (defindex: number) =>
  queryOptions({ queryKey: ["item", defindex], queryFn: () => fetchItem({ data: { defindex } }) });

export interface PairedWeapon {
  /** representative (reskin-group) defindex of the paired weapon */
  defindex: number;
  name: string | null;
  itemName: string | null;
  imageUrl: string | null;
  slot: string | null;
  /** loadouts that pair this weapon with the item */
  count: number;
  /** fraction of the item's loadouts that also run this weapon (0-1) */
  share: number;
}

export interface ItemPairs {
  /** representative defindex the pairing keys off (reskin group) */
  gid: number;
  /** loadouts containing this item at the chosen experience floor (denominator) */
  loadoutsWithItem: number;
  pairs: PairedWeapon[];
}

/** counts come back as UInt64 → JSON strings; gids (UInt32) arrive as numbers */
interface RawPairRow {
  gid: number;
  cnt: string;
}

const PAIRS_LIMIT = 12;

/**
 * Weapons most commonly equipped alongside this item, from the ClickHouse
 * `loadout` table (one row per player×class, `weapon_gids` = reskin-collapsed
 * representative defindexes). Pairs by gid so results line up with the rest of
 * the site; `minutes` applies the same lifetime-minute experience floor combos
 * uses. Co-occurrence is within a single loadout (same player, same class).
 */
export const fetchItemPairs = createServerFn({ method: "GET" })
  .validator(
    z.object({
      defindex: z.number().int().nonnegative(),
      minutes: z.number().int().nonnegative().catch(0).default(0),
    }),
  )
  .handler(async ({ data }): Promise<ItemPairs> => {
    const db = getDb();
    const [row] = await db
      .select({
        defindex: schema.itemSchema.defindex,
        reskinGroup: schema.itemSchema.reskinGroup,
      })
      .from(schema.itemSchema)
      .where(eq(schema.itemSchema.defindex, data.defindex))
      .limit(1);
    const gid = row ? (row.reskinGroup ?? row.defindex) : data.defindex;

    const ch = getCh();
    const [popRow] = await chQuery<{ n: string }>(
      ch,
      `SELECT count() AS n FROM loadout
       WHERE has(weapon_gids, {gid:UInt32}) AND lifetime_min >= {min:UInt32}`,
      { gid, min: data.minutes },
    );
    const loadoutsWithItem = popRow ? Number(popRow.n) : 0;

    const raw = await chQuery<RawPairRow>(
      ch,
      `SELECT b AS gid, count() AS cnt
       FROM loadout
       ARRAY JOIN weapon_gids AS b
       WHERE has(weapon_gids, {gid:UInt32}) AND b != {gid:UInt32} AND lifetime_min >= {min:UInt32}
       GROUP BY b
       ORDER BY cnt DESC, b
       LIMIT {lim:UInt32}`,
      { gid, min: data.minutes, lim: PAIRS_LIMIT },
    );

    const gidSet = raw.map((r) => r.gid);
    const items =
      gidSet.length > 0
        ? await db
            .select({
              defindex: schema.itemSchema.defindex,
              name: schema.itemSchema.name,
              itemName: schema.itemSchema.itemName,
              imageUrl: schema.itemSchema.imageUrl,
              slot: schema.itemSchema.slot,
            })
            .from(schema.itemSchema)
            .where(inArray(schema.itemSchema.defindex, gidSet))
        : [];
    const byDefindex = new Map(items.map((i) => [i.defindex, i]));

    const pairs: PairedWeapon[] = raw.map((r) => {
      const it = byDefindex.get(r.gid);
      const count = Number(r.cnt);
      return {
        defindex: r.gid,
        name: it?.name ?? null,
        itemName: it?.itemName ?? null,
        imageUrl: it?.imageUrl ?? null,
        slot: it?.slot ?? null,
        count,
        share: loadoutsWithItem > 0 ? count / loadoutsWithItem : 0,
      };
    });

    return { gid, loadoutsWithItem, pairs };
  });

export const itemPairsQueryOptions = (defindex: number, minutes: number) =>
  queryOptions({
    queryKey: ["itemPairs", defindex, minutes],
    queryFn: () => fetchItemPairs({ data: { defindex, minutes } }),
  });

// --- Strange kill distribution -------------------------------------------

/**
 * Strange-rank tiers (ascending by kill floor), mirroring the in-game
 * kill-eater rank names. Values are kept identical to the canonical list in
 * packages/tf2-schema/src/strange.ts — this is a deliberate web-local copy
 * because apps/web does not depend on @trackertf/tf2-schema (the leaderboards
 * and player pages inline the same constants). The top tier floor is
 * HALE_OWN_KILLS, single-sourced from leaderboards.ts. Consolidate if web ever
 * takes a tf2-schema dependency.
 */
const STRANGE_RANKS: { kills: number; name: string }[] = [
  { kills: 0, name: "Strange" },
  { kills: 10, name: "Unremarkable" },
  { kills: 25, name: "Scarcely Lethal" },
  { kills: 45, name: "Mildly Menacing" },
  { kills: 70, name: "Somewhat Threatening" },
  { kills: 100, name: "Uncharitable" },
  { kills: 135, name: "Notably Dangerous" },
  { kills: 175, name: "Sufficiently Lethal" },
  { kills: 225, name: "Truly Feared" },
  { kills: 275, name: "Spectacularly Lethal" },
  { kills: 350, name: "Gore-Spattered" },
  { kills: 500, name: "Wicked Nasty" },
  { kills: 750, name: "Positively Inhumane" },
  { kills: 999, name: "Totally Ordinary" },
  { kills: 1000, name: "Face-Melting" },
  { kills: 1500, name: "Rage-Inducing" },
  { kills: 2500, name: "Server-Clearing" },
  { kills: 5000, name: "Epic" },
  { kills: 7500, name: "Legendary" },
  { kills: 12500, name: "Australian" },
  { kills: HALE_OWN_KILLS, name: "Hale's Own" },
];

/** Highest Strange rank name a kill count has reached. */
function strangeRank(kills: number): string {
  let name = STRANGE_RANKS[0]!.name;
  for (const r of STRANGE_RANKS) {
    if (kills >= r.kills) name = r.name;
    else break;
  }
  return name;
}

export interface StrangeTier {
  /** kill floor of this rank tier */
  threshold: number;
  name: string;
  count: number;
}

export interface StrangeDist {
  /** Strange (quality 11) copies of the group with a non-zero kill counter */
  copies: number;
  avgKills: number;
  medianKills: number;
  p90Kills: number;
  maxKills: number;
  /** copies that have reached Hale's Own (HALE_OWN_KILLS) */
  haleOwnCount: number;
  /** rank name of the single highest counter */
  topRankName: string;
  /** non-empty rank tiers, ascending by kill floor */
  tiers: StrangeTier[];
}

/**
 * Distribution of Strange kill-eater counters across every Strange (quality 11)
 * copy of this item's functional group — the population view that complements
 * the per-player Strange leaderboard. Reads the materialized
 * `equipped_items.strange_kills` column directly (same source as
 * fetchItemStrangeBoard), applies the site-wide botness filter so bot inventories
 * don't skew the spread, and computes percentiles + the per-tier histogram in
 * Postgres so only summary rows cross the wire. Empty (null) when the item has
 * no Strange copies with kills recorded.
 */
export const fetchStrangeDist = createServerFn({ method: "GET" })
  .validator(z.object({ defindex: z.number().int().nonnegative() }))
  .handler(async ({ data }): Promise<StrangeDist | null> => {
    const db = getDb();
    const [item] = await db
      .select({ defindex: schema.itemSchema.defindex, reskinGroup: schema.itemSchema.reskinGroup })
      .from(schema.itemSchema)
      .where(eq(schema.itemSchema.defindex, data.defindex))
      .limit(1);
    if (!item) return null;
    const groupId = item.reskinGroup ?? item.defindex;
    const members = await db
      .select({ defindex: schema.itemSchema.defindex })
      .from(schema.itemSchema)
      .where(eq(schema.itemSchema.reskinGroup, groupId));
    const groupIds = [...new Set([groupId, item.defindex, ...members.map((m) => m.defindex)])];
    const idList = sql.join(
      groupIds.map((id) => sql`${id}`),
      sql`, `,
    );

    // Map each counter to its rank-tier floor via a descending CASE built from
    // STRANGE_RANKS, so the histogram bucketing lives in SQL alongside the
    // percentiles. One copy per (player, class) — a multi-class Strange folds to
    // its highest counter first so it counts once.
    const tierCase = sql.join(
      STRANGE_RANKS.toReversed().map((r) => sql`when k >= ${r.kills} then ${r.kills}`),
      sql` `,
    );

    // Both the percentile summary and the per-tier histogram derive from the
    // same `copies` scan (equipped_items ⋈ players, ~one index-range + hashagg).
    // Computing them in two statements scanned it twice; a single statement
    // materializes the multiply-referenced CTE once and returns the summary and
    // the tier array as two json columns of one row.
    const [row] = (await db.execute(sql`
      with copies as (
        select max(e.strange_kills) as k
        from equipped_items e
        join players p using (steamid)
        where e.defindex in (${idList}) and e.quality = 11 and e.strange_kills > 0
          and coalesce(p.botness, 0) < 0.5
        group by e.steamid, e.class_num
      ),
      summary as (
        select
          count(*)::int as copies,
          coalesce(avg(k), 0)::float as avg_kills,
          coalesce(percentile_cont(0.5) within group (order by k), 0)::float as median_kills,
          coalesce(percentile_cont(0.9) within group (order by k), 0)::float as p90_kills,
          coalesce(max(k), 0)::int as max_kills
        from copies
      ),
      tiers as (
        select (case ${tierCase} else 0 end)::int as tier, count(*)::int as count
        from copies
        group by tier
      )
      select
        (select row_to_json(summary) from summary) as summary,
        coalesce((select json_agg(row_to_json(tiers)) from tiers), '[]'::json) as tiers
    `)) as unknown as [{ summary: Record<string, unknown> | null; tiers: Record<string, unknown>[] } | undefined];

    const summary = row?.summary ?? null;
    const copies = Number(summary?.["copies"] ?? 0);
    if (copies === 0) return null;

    const tierRows = row?.tiers ?? [];

    const nameByFloor = new Map(STRANGE_RANKS.map((r) => [r.kills, r.name]));
    const tiers: StrangeTier[] = tierRows
      .map((r) => {
        const threshold = Number(r["tier"]);
        return { threshold, name: nameByFloor.get(threshold) ?? "Strange", count: Number(r["count"]) };
      })
      .toSorted((a, b) => a.threshold - b.threshold);

    const maxKills = Number(summary?.["max_kills"] ?? 0);
    return {
      copies,
      avgKills: Number(summary?.["avg_kills"] ?? 0),
      medianKills: Number(summary?.["median_kills"] ?? 0),
      p90Kills: Number(summary?.["p90_kills"] ?? 0),
      maxKills,
      haleOwnCount: tiers.find((t) => t.threshold >= HALE_OWN_KILLS)?.count ?? 0,
      topRankName: strangeRank(maxKills),
      tiers,
    };
  });

export const strangeDistQueryOptions = (defindex: number) =>
  queryOptions({
    queryKey: ["strangeDist", defindex],
    queryFn: () => fetchStrangeDist({ data: { defindex } }),
  });
