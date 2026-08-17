import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { createDbFromEnv, type Db, schema } from "@trackertf/db";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

/** Every usage-page filter lives in the URL — this schema is the contract. */
export const usageFiltersSchema = z.object({
  /** -1 = any, 1-9 = Web API class number */
  class: z.number().int().min(-1).max(9).catch(-1).default(-1),
  /** -1 = any, 0-6 = weapon slots, 7 = cosmetic, 8 = taunt */
  slot: z.number().int().min(-1).max(8).catch(-1).default(-1),
  /** only players active in the last 2 weeks */
  active: z.boolean().catch(false).default(false),
  /** minimum minutes played (0 = any; 120000 = "experienced") */
  minutes: z.number().int().nonnegative().catch(0).default(0),
  /** merge functionally-identical reskins/stranges (launch default: on) */
  merge: z.boolean().catch(true).default(true),
  /** show PDA/builder pseudo-items (~100% rows hidden by default) */
  pdas: z.boolean().catch(false).default(false),
});
export type UsageFilters = z.infer<typeof usageFiltersSchema>;

export interface UsageRow {
  defindex: number;
  usage: number;
  sampleSize: number;
  computedAt: string;
  name: string | null;
  itemName: string | null;
  imageUrl: string | null;
  reskinGroup: number | null;
}

let db: Db | undefined;
function getDb(): Db {
  db ??= createDbFromEnv();
  return db;
}

export const fetchUsage = createServerFn({ method: "GET" })
  .validator(usageFiltersSchema)
  .handler(async ({ data }): Promise<UsageRow[]> => {
    const rows = await getDb()
      .select({
        defindex: schema.usageStats.defindex,
        usage: schema.usageStats.usage,
        sampleSize: schema.usageStats.sampleSize,
        computedAt: schema.usageStats.computedAt,
        name: schema.itemSchema.name,
        itemName: schema.itemSchema.itemName,
        imageUrl: schema.itemSchema.imageUrl,
        reskinGroup: schema.itemSchema.reskinGroup,
      })
      .from(schema.usageStats)
      .leftJoin(schema.itemSchema, eq(schema.usageStats.defindex, schema.itemSchema.defindex))
      .where(
        and(
          eq(schema.usageStats.classNum, data.class),
          eq(schema.usageStats.slot, data.slot),
          eq(schema.usageStats.activeOnly, data.active),
          eq(schema.usageStats.minutesThreshold, data.minutes),
          eq(schema.usageStats.mergeReskins, data.merge),
        ),
      )
      .orderBy(desc(schema.usageStats.usage))
      .limit(150);
    return rows.map((r) => ({ ...r, computedAt: r.computedAt.toISOString() }));
  });

export const usageQueryOptions = (filters: UsageFilters) =>
  queryOptions({
    queryKey: ["usage", filters],
    queryFn: () => fetchUsage({ data: filters }),
  });
