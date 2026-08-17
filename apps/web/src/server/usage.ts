import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { createDbFromEnv, type Db, schema } from "@trackertf/db";
import { and, desc, eq, isNotNull } from "drizzle-orm";
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
  count: number;
  sampleSize: number;
  computedAt: string;
  name: string | null;
  itemName: string | null;
  imageUrl: string | null;
  reskinGroup: number | null;
  slotName: string | null;
  usedByClasses: number[] | null;
}

const toIso = (r: Omit<UsageRow, "computedAt"> & { computedAt: Date }): UsageRow => ({
  ...r,
  computedAt: r.computedAt.toISOString(),
});

let db: Db | undefined;
function getDb(): Db {
  db ??= createDbFromEnv();
  return db;
}

export interface UsageResponse {
  rows: UsageRow[];
  /** individual reskin-group members (merge view only), for row expansion */
  variants: UsageRow[];
}

function selectUsage(database: Db, filters: UsageFilters, merged: boolean, onlyGrouped = false) {
  return database
    .select({
      defindex: schema.usageStats.defindex,
      usage: schema.usageStats.usage,
      count: schema.usageStats.count,
      sampleSize: schema.usageStats.sampleSize,
      computedAt: schema.usageStats.computedAt,
      name: schema.itemSchema.name,
      itemName: schema.itemSchema.itemName,
      imageUrl: schema.itemSchema.imageUrl,
      reskinGroup: schema.itemSchema.reskinGroup,
      slotName: schema.itemSchema.slot,
      usedByClasses: schema.itemSchema.usedByClasses,
    })
    .from(schema.usageStats)
    .leftJoin(schema.itemSchema, eq(schema.usageStats.defindex, schema.itemSchema.defindex))
    .where(
      and(
        eq(schema.usageStats.classNum, filters.class),
        eq(schema.usageStats.slot, filters.slot),
        eq(schema.usageStats.activeOnly, filters.active),
        eq(schema.usageStats.minutesThreshold, filters.minutes),
        eq(schema.usageStats.mergeReskins, merged),
        onlyGrouped ? isNotNull(schema.itemSchema.reskinGroup) : undefined,
      ),
    )
    .orderBy(desc(schema.usageStats.usage));
}

export const fetchUsage = createServerFn({ method: "GET" })
  .validator(usageFiltersSchema)
  .handler(async ({ data }): Promise<UsageResponse> => {
    const rows = (await selectUsage(getDb(), data, data.merge).limit(150)).map(toIso);
    // merge view: also ship per-variant rows so groups can expand in place
    // (grouped-only filter lives in SQL — a JS post-limit filter dropped
    // low-usage variants on large result sets)
    const variants = data.merge
      ? (await selectUsage(getDb(), data, false, true).limit(2000)).map(toIso)
      : [];
    return { rows, variants };
  });

export const usageQueryOptions = (filters: UsageFilters) =>
  queryOptions({
    queryKey: ["usage", filters],
    queryFn: () => fetchUsage({ data: filters }),
  });
