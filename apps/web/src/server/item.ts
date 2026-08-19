import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { chQuery } from "@trackertf/clickhouse";
import { schema } from "@trackertf/db";
import { eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { getCh } from "./ch.ts";
import { getDb } from "./db.ts";

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
    const variantQualities = (await db.execute(sql`
      select defindex, quality, count(*)::int as count
      from equipped_items
      where defindex in (${sql.join(groupDefindexes, sql`, `)})
      group by defindex, quality
    `)) as unknown as Record<string, unknown>[];

    // usage_stats now buckets populations (active_minutes_2wk × minutes) —
    // keep this page's original 2×2 matrix by selecting the matching buckets
    const usage = (await db.execute(sql`
      select class_num, (active_minutes_2wk >= 1) as active_only, minutes_threshold,
             usage, count, sample_size
      from usage_stats
      where defindex = ${groupId} and slot = -1 and merge_reskins
        and active_minutes_2wk in (0, 1) and minutes_threshold in (0, 120000)
      order by class_num
    `)) as unknown as Record<string, unknown>[];

    const perf = await db
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
      );

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
