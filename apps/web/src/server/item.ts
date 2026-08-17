import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { schema } from "@trackertf/db";
import { eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
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

export interface ItemResponse {
  item: ItemInfo;
  groupMembers: ItemInfo[];
  /** merged usage per class × population (slot=-1 rows) */
  usage: ItemUsageCell[];
  perf: ItemPerf[];
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

    const usage = (await db.execute(sql`
      select class_num, active_only, minutes_threshold, usage, count, sample_size
      from usage_stats
      where defindex = ${groupId} and slot = -1 and merge_reskins
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
    };
  });

export const itemQueryOptions = (defindex: number) =>
  queryOptions({ queryKey: ["item", defindex], queryFn: () => fetchItem({ data: { defindex } }) });
