import { infiniteQueryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { createDbFromEnv, type Db, schema } from "@trackertf/db";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";

/** min lifetime minutes buckets the analyser precomputes (0 = everyone) */
export const HOURS_BUCKETS = [0, 30_000, 60_000, 120_000, 240_000] as const;
/** min minutes-in-2-weeks buckets (0 = everyone, 1 = played at all) */
export const ACTIVE_BUCKETS = [0, 1, 300, 900] as const;

/** snap arbitrary URL values onto the nearest precomputed bucket */
const snapTo = (buckets: readonly number[]) => (v: number) =>
  buckets.reduce((best, b) => (Math.abs(b - v) < Math.abs(best - v) ? b : best));

/** Every usage-page filter lives in the URL — this schema is the contract. */
export const usageFiltersSchema = z.object({
  /** -1 = any, 1-9 = Web API class number */
  class: z.number().int().min(-1).max(9).catch(-1).default(-1),
  /** -1 = any, 0-6 = weapon slots, 7 = cosmetic, 8 = taunt */
  slot: z.number().int().min(-1).max(8).catch(-1).default(-1),
  /** min minutes played in the last 2 weeks, snapped to ACTIVE_BUCKETS */
  active: z.number().int().nonnegative().catch(0).default(0).transform(snapTo(ACTIVE_BUCKETS)),
  /** min lifetime minutes played, snapped to HOURS_BUCKETS */
  minutes: z.number().int().nonnegative().catch(0).default(0).transform(snapTo(HOURS_BUCKETS)),
  /** merge functionally-identical reskins/stranges (launch default: on) */
  merge: z.boolean().catch(true).default(true),
  /** show PDA/builder pseudo-items (~100% rows hidden by default) */
  pdas: z.boolean().catch(false).default(false),
});
export type UsageFilters = z.infer<typeof usageFiltersSchema>;

const usagePageSchema = usageFiltersSchema.extend({
  offset: z.number().int().nonnegative().catch(0).default(0),
});

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

const PAGE_SIZE = 100;

export interface UsagePage {
  rows: UsageRow[];
  /** individual reskin-group members (merge view, first page only) */
  variants: UsageRow[];
  /** offset of the next page, or null when this was the last one */
  nextOffset: number | null;
  sampleSize: number | null;
  computedAt: string | null;
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
        eq(schema.usageStats.activeMinutes2wk, filters.active),
        eq(schema.usageStats.minutesThreshold, filters.minutes),
        eq(schema.usageStats.mergeReskins, merged),
        onlyGrouped ? isNotNull(schema.itemSchema.reskinGroup) : undefined,
      ),
    )
    .orderBy(desc(schema.usageStats.usage), desc(schema.usageStats.defindex));
}

export const fetchUsage = createServerFn({ method: "GET" })
  .validator(usagePageSchema)
  .handler(async ({ data }): Promise<UsagePage> => {
    const { offset, ...filters } = data;
    // over-fetch by one row to learn whether another page exists
    const page = (
      await selectUsage(getDb(), filters, filters.merge)
        .limit(PAGE_SIZE + 1)
        .offset(offset)
    ).map(toIso);
    const rows = page.slice(0, PAGE_SIZE);
    // merge view: also ship per-variant rows so groups can expand in place
    // (grouped-only filter lives in SQL — a JS post-limit filter dropped
    // low-usage variants on large result sets). First page only.
    const variants =
      filters.merge && offset === 0
        ? (await selectUsage(getDb(), filters, false, true).limit(2000)).map(toIso)
        : [];
    return {
      rows,
      variants,
      nextOffset: page.length > PAGE_SIZE ? offset + PAGE_SIZE : null,
      sampleSize: rows[0]?.sampleSize ?? null,
      computedAt: rows[0]?.computedAt ?? null,
    };
  });

export const usageInfiniteQueryOptions = (filters: UsageFilters) =>
  infiniteQueryOptions({
    queryKey: ["usage", filters],
    queryFn: ({ pageParam }) => fetchUsage({ data: { ...filters, offset: pageParam } }),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextOffset,
  });
