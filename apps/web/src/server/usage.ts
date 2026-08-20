import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { chQuery } from "@trackertf/clickhouse";
import { createDbFromEnv, type Db, schema } from "@trackertf/db";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { getCh } from "./ch.ts";

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

/**
 * Strange adoption per reskin group: what fraction of a weapon's equips are
 * Strange quality (11). Keyed by `gid` (the ClickHouse reskin group id), which
 * equals a usage row's `reskinGroup ?? defindex`, so it aligns with both merge
 * modes. Computed over the whole equipped corpus — deliberately independent of
 * the page's population sliders (it's an overall "how often is this run Strange"
 * signal). Ultra-rare groups (<10 equips) are dropped so a lone Strange can't
 * read as 100%.
 */
export interface StrangeShare {
  gid: number;
  /** 0..1 fraction of the group's equips that are Strange quality */
  strangeShare: number;
  /** total equips in the group (Strange share denominator) */
  sampleSize: number;
}

export const fetchStrangeShares = createServerFn({ method: "GET" }).handler(
  async (): Promise<StrangeShare[]> => {
    const rows = await chQuery<Record<string, unknown>>(
      getCh(),
      `select gid,
        countIf(quality = 11) as strange,
        count() as total
      from equipped
      group by gid
      having total >= 10`,
    );
    return rows.map((r) => {
      const total = Number(r["total"]);
      return {
        gid: Number(r["gid"]),
        strangeShare: total > 0 ? Number(r["strange"]) / total : 0,
        sampleSize: total,
      };
    });
  },
);

export const strangeSharesQueryOptions = () =>
  queryOptions({ queryKey: ["strangeShares"], queryFn: () => fetchStrangeShares() });

/** Per-item week-over-week change in headline usage share. The raw equip counts
 * and population sizes are carried so the client can run a two-proportion z-test
 * (shared helper) and flag noise-level shifts as non-significant. */
export interface UsageDelta {
  defindex: number;
  usageNow: number;
  usageThen: number;
  /** usageNow - usageThen (signed usage-fraction change) */
  delta: number;
  /** equip count on the latest day (test x1) */
  countNow: number;
  /** population size on the latest day (test n1) */
  sampleSizeNow: number;
  /** equip count on the comparison day, 0 if the item had none (test x2) */
  countThen: number;
  /** population size on the comparison day (test n2) */
  sampleSizeThen: number;
}

export interface UsageDeltaResponse {
  /** false until there are two distinct snapshot days to compare */
  enoughHistory: boolean;
  /** most recent snapshot day (YYYY-MM-DD), or null before any snapshot */
  latestDay: string | null;
  /** the day `latest` is compared against (YYYY-MM-DD) */
  comparisonDay: string | null;
  /** whole days between comparisonDay and latestDay */
  days: number;
  deltas: UsageDelta[];
}

/** selectable comparison windows for the delta view (whole days) */
export const DELTA_PERIODS = [7, 30] as const;
export type DeltaPeriod = (typeof DELTA_PERIODS)[number];

/**
 * Usage deltas for the default headline view only (Any class · Any slot · all
 * players · merged). usage_stats_history stores just that slice, so defindex
 * here is the reskin group id. Compares the newest snapshot against the newest
 * snapshot at least `period` days older; if that much history doesn't exist
 * yet, falls back to the earliest snapshot and reports the real span in `days`.
 */
export const fetchUsageDeltas = createServerFn({ method: "GET" })
  .validator(
    z.object({
      period: z
        .number()
        .int()
        .catch(7)
        .default(7)
        .transform((p) => (DELTA_PERIODS.includes(p as DeltaPeriod) ? (p as DeltaPeriod) : 7)),
    }),
  )
  .handler(async ({ data }): Promise<UsageDeltaResponse> => {
    const database = getDb();
    const [bounds] = (await database.execute(sql`
      select max(day)::text latest, min(day)::text earliest from usage_stats_history
    `)) as unknown as [{ latest: string | null; earliest: string | null } | undefined];
    const latest = bounds?.latest ?? null;
    const earliest = bounds?.earliest ?? null;
    if (!latest || !earliest) {
      return { enoughHistory: false, latestDay: latest, comparisonDay: null, days: 0, deltas: [] };
    }
    const [cmp] = (await database.execute(sql`
      select max(day)::text d from usage_stats_history where day <= ${latest}::date - ${data.period}
    `)) as unknown as [{ d: string | null } | undefined];
    const comparisonDay = cmp?.d ?? earliest;
    const enoughHistory = comparisonDay !== latest;
    const days = Math.round(
      (new Date(latest).getTime() - new Date(comparisonDay).getTime()) / 86_400_000,
    );
    if (!enoughHistory) {
      return { enoughHistory, latestDay: latest, comparisonDay, days, deltas: [] };
    }
    // sample_size is uniform across a day's rows (it's the population count), so
    // when an item is absent on the comparison day we still use that day's
    // population as n2 rather than 0 — a genuine "0 of N" observation.
    const rows = (await database.execute(sql`
      select n.defindex,
        n.usage usage_now, n.count count_now, n.sample_size n_now,
        coalesce(t.usage, 0) usage_then, coalesce(t.count, 0) count_then,
        coalesce(
          t.sample_size,
          (select max(sample_size) from usage_stats_history where day = ${comparisonDay}::date)
        ) n_then
      from usage_stats_history n
      left join usage_stats_history t
        on t.defindex = n.defindex and t.day = ${comparisonDay}::date
      where n.day = ${latest}::date
    `)) as unknown as {
      defindex: number;
      usage_now: number;
      count_now: number;
      n_now: number;
      usage_then: number;
      count_then: number;
      n_then: number;
    }[];
    return {
      enoughHistory,
      latestDay: latest,
      comparisonDay,
      days,
      deltas: rows.map((r) => ({
        defindex: Number(r.defindex),
        usageNow: Number(r.usage_now),
        usageThen: Number(r.usage_then),
        delta: Number(r.usage_now) - Number(r.usage_then),
        countNow: Number(r.count_now),
        sampleSizeNow: Number(r.n_now),
        countThen: Number(r.count_then),
        sampleSizeThen: Number(r.n_then),
      })),
    };
  });

export const usageDeltasQueryOptions = (period: DeltaPeriod = 7) =>
  queryOptions({
    queryKey: ["usageDeltas", period],
    queryFn: () => fetchUsageDeltas({ data: { period } }),
  });
