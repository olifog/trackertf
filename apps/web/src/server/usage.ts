import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { chQuery } from "@trackertf/clickhouse";
import { createDbFromEnv, type Db, schema } from "@trackertf/db";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
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
  /** min lifetime minutes played, snapped to HOURS_BUCKETS. In experience-compare
   * mode (`xp`) this is the LOW-experience population (group A). */
  minutes: z.number().int().nonnegative().catch(0).default(0).transform(snapTo(HOURS_BUCKETS)),
  /** min lifetime minutes for the HIGH-experience population (group B, `xp` mode
   * only), snapped to HOURS_BUCKETS */
  minutesB: z
    .number()
    .int()
    .nonnegative()
    .catch(240_000)
    .default(240_000)
    .transform(snapTo(HOURS_BUCKETS)),
  /** merge functionally-identical reskins/stranges (launch default: on) */
  merge: z.boolean().catch(true).default(true),
  /** show PDA/builder pseudo-items (~100% rows hidden by default) */
  pdas: z.boolean().catch(false).default(false),
  /** experience-compare view: low-vs-high lifetime-playtime adoption delta
   * (ClickHouse-backed). Distinct from the page's time-over-time delta overlay. */
  xp: z.boolean().catch(false).default(false),
  /** row sort in `xp` mode: high-group usage, or biggest low-vs-high delta */
  sort: z.enum(["usage", "delta"]).catch("usage").default("usage"),
});
export type UsageFilters = z.infer<typeof usageFiltersSchema>;

const usagePageSchema = usageFiltersSchema.extend({
  offset: z.number().int().nonnegative().catch(0).default(0),
});

export interface UsageRow {
  defindex: number;
  /** single-population usage rate; in `xp` mode this is the LOW group (A) rate */
  usage: number;
  /** equipping players; in `xp` mode this is the LOW group (A) count */
  count: number;
  sampleSize: number;
  computedAt: string;
  name: string | null;
  itemName: string | null;
  imageUrl: string | null;
  reskinGroup: number | null;
  slotName: string | null;
  usedByClasses: number[] | null;
  /** HIGH group (B) usage rate — `xp` mode only, else null */
  usageB: number | null;
  /** HIGH group (B) equipping players — `xp` mode only, else null */
  countB: number | null;
  /** usageB - usage (percentage-point delta, +ve = adopted more by veterans) */
  delta: number | null;
}

type UsageDbRow = Omit<UsageRow, "computedAt" | "usageB" | "countB" | "delta"> & {
  /** Date via the typed .select() path, string via raw db.execute */
  computedAt: Date | string;
};

const toIso = (r: UsageDbRow): UsageRow => ({
  ...r,
  // raw db.execute (the main usage query) bypasses drizzle's timestamp decoding
  // and hands back computed_at as a string; the typed .select() path gives a
  // Date. Coerce so both are handled.
  computedAt: new Date(r.computedAt).toISOString(),
  usageB: null,
  countB: null,
  delta: null,
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
  /** experience-compare (low-vs-high) view is active */
  xp: boolean;
  /** LOW-experience population size (`xp` mode only) */
  popA: number | null;
  /** HIGH-experience population size (`xp` mode only) */
  popB: number | null;
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

/** counts come back as UInt64 → JSON strings; cgid (UInt32) arrives as a number */
interface RawXpRow {
  cgid: number;
  cntA: string;
  cntB: string;
}
interface RawCount {
  n: string;
}

/**
 * Per-item low-vs-high experience delta over ClickHouse `equipped`, grouped by
 * the class-aware `cgid` (reskins/pan-family already merged). `sort` is a
 * validated enum — never user free-text — so composing the ORDER BY fragment
 * from it is safe; every population & value binds as a CH param.
 */
function xpDeltaQuery(sort: string): string {
  const orderBy =
    sort === "delta"
      ? `abs(cntB / greatest({popB:Float64}, 1) - cntA / greatest({popA:Float64}, 1)) DESC, cntB DESC, cgid`
      : `cntB DESC, cgid`;
  return `
    SELECT cgid,
           uniqExactIf(steamid, lifetime_min >= {minA:UInt32}) AS cntA,
           uniqExactIf(steamid, lifetime_min >= {minB:UInt32}) AS cntB
    FROM equipped
    WHERE class_num = {cls:UInt8} AND slot = {slot:Int8}
    GROUP BY cgid
    HAVING (cntA + cntB) >= 2
    ORDER BY ${orderBy}
    LIMIT {lim:UInt32} OFFSET {off:UInt32}`;
}

/** distinct players in a class at a lifetime-minute threshold (delta denominator) */
async function fetchXpPop(cls: number, minMinutes: number): Promise<number> {
  const [row] = await chQuery<RawCount>(
    getCh(),
    `SELECT count() AS n FROM loadout WHERE class_num = {cls:UInt8} AND lifetime_min >= {min:UInt32}`,
    { cls, min: minMinutes },
  );
  return row ? Number(row.n) : 0;
}

async function fetchUsageXp(data: z.infer<typeof usagePageSchema>): Promise<UsagePage> {
  const { offset, minutes: minA, minutesB: minB, sort } = data;
  // the delta view needs a concrete class + slot; the UI enforces this, but
  // clamp defensively for hand-edited URLs (any → Scout / primary)
  const cls = data.class === -1 ? 1 : data.class;
  const slot = data.slot === -1 ? 0 : data.slot;

  const [popA, popB] = await Promise.all([fetchXpPop(cls, minA), fetchXpPop(cls, minB)]);

  const raw = await chQuery<RawXpRow>(getCh(), xpDeltaQuery(sort), {
    cls,
    slot,
    minA,
    minB,
    popA,
    popB,
    lim: PAGE_SIZE + 1,
    off: offset,
  });
  const page = raw.slice(0, PAGE_SIZE);

  // resolve class-aware group ids → names/images from Postgres item_schema
  const cgids = [...new Set(page.map((r) => r.cgid))];
  const items =
    cgids.length > 0
      ? await getDb()
          .select({
            defindex: schema.itemSchema.defindex,
            name: schema.itemSchema.name,
            itemName: schema.itemSchema.itemName,
            imageUrl: schema.itemSchema.imageUrl,
            slotName: schema.itemSchema.slot,
          })
          .from(schema.itemSchema)
          .where(inArray(schema.itemSchema.defindex, cgids))
      : [];
  const byDefindex = new Map(items.map((i) => [i.defindex, i]));

  const rows: UsageRow[] = page.map((r) => {
    const countA = Number(r.cntA);
    const countB = Number(r.cntB);
    const usageA = popA > 0 ? countA / popA : 0;
    const usageB = popB > 0 ? countB / popB : 0;
    const it = byDefindex.get(r.cgid);
    return {
      defindex: r.cgid,
      usage: usageA,
      count: countA,
      sampleSize: popA,
      computedAt: new Date(0).toISOString(),
      name: it?.name ?? null,
      itemName: it?.itemName ?? null,
      imageUrl: it?.imageUrl ?? null,
      reskinGroup: null,
      slotName: it?.slotName ?? null,
      usedByClasses: null,
      usageB,
      countB,
      delta: usageB - usageA,
    };
  });

  return {
    rows,
    variants: [],
    nextOffset: raw.length > PAGE_SIZE ? offset + PAGE_SIZE : null,
    sampleSize: popA,
    computedAt: null,
    xp: true,
    popA,
    popB,
  };
}

export const fetchUsage = createServerFn({ method: "GET" })
  .validator(usagePageSchema)
  .handler(async ({ data }): Promise<UsagePage> => {
    if (data.xp) return fetchUsageXp(data);

    const { offset, ...filters } = data;
    // over-fetch by one row to learn whether another page exists. The LIMIT is
    // pushed BELOW the item_schema join: rank/slice the (small, single-slice)
    // usage_stats rows first, then resolve display fields for just those ~101
    // defindexes via the item_schema PK. The old leftJoin hashed all ~11.5k
    // item_schema rows before the limit; ordering here is byte-identical
    // (usage desc, defindex desc). The variants query below still uses
    // selectUsage — its onlyGrouped filter reads the joined item_schema.
    const page = (
      (await getDb().execute(sql`
        with top as (
          select defindex, usage, count, sample_size, computed_at
          from usage_stats
          where class_num = ${filters.class}
            and slot = ${filters.slot}
            and active_minutes_2wk = ${filters.active}
            and minutes_threshold = ${filters.minutes}
            and merge_reskins = ${filters.merge}
          order by usage desc, defindex desc
          limit ${PAGE_SIZE + 1} offset ${offset}
        )
        select t.defindex as defindex, t.usage as usage, t.count as count,
          t.sample_size as "sampleSize", t.computed_at as "computedAt",
          i.name as name, i.item_name as "itemName", i.image_url as "imageUrl",
          i.reskin_group as "reskinGroup", i.slot as "slotName",
          i.used_by_classes as "usedByClasses"
        from top t
        left join item_schema i on i.defindex = t.defindex
        order by t.usage desc, t.defindex desc
      `)) as unknown as UsageDbRow[]
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
      xp: false,
      popA: null,
      popB: null,
    };
  });

export const usageInfiniteQueryOptions = (filters: UsageFilters) =>
  infiniteQueryOptions({
    queryKey: ["usage", filters],
    queryFn: ({ pageParam }) => fetchUsage({ data: { ...filters, offset: pageParam } }),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextOffset,
  });

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
