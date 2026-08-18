import { infiniteQueryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { chQuery } from "@trackertf/clickhouse";
import { schema } from "@trackertf/db";
import { inArray } from "drizzle-orm";
import { z } from "zod";
import { getCh } from "./ch.ts";
import { getDb } from "./db.ts";

/** min lifetime-minutes stops the experience slider snaps to (0 = everyone) */
export const HOURS_BUCKETS = [0, 6_000, 30_000, 60_000, 120_000, 240_000] as const;

/** snap an arbitrary URL value onto the nearest slider stop */
const snapTo = (buckets: readonly number[]) => (v: number) =>
  buckets.reduce((best, b) => (Math.abs(b - v) < Math.abs(best - v) ? b : best));

/**
 * Metric whitelist. `expr` is raw SQL over the joined `player_class` row `p`
 * (fixed strings, never user input) so it is safe to inline. Formulas mirror
 * the crawler's recomputeWeaponStats (`::real * 60 / playtime_seconds` etc.),
 * extended with the per-hour variants.
 */
export const METRICS = {
  points_hr: {
    label: "Points/hr",
    unit: "pts/hr",
    expr: "toFloat64(p.points_scored) * 3600 / p.playtime_seconds",
  },
  points_min: {
    label: "Points/min",
    unit: "pts/min",
    expr: "toFloat64(p.points_scored) * 60 / p.playtime_seconds",
  },
  kills_hr: {
    label: "Kills/hr",
    unit: "kills/hr",
    expr: "toFloat64(p.kills) * 3600 / p.playtime_seconds",
  },
  damage_min: {
    label: "Damage/min",
    unit: "dmg/min",
    expr: "toFloat64(p.damage_dealt) * 60 / p.playtime_seconds",
  },
  assists_hr: {
    label: "Assists/hr",
    unit: "ast/hr",
    expr: "toFloat64(p.kill_assists) * 3600 / p.playtime_seconds",
  },
  captures_hr: {
    label: "Captures/hr",
    unit: "caps/hr",
    expr: "toFloat64(p.captures) * 3600 / p.playtime_seconds",
  },
  dominations_hr: {
    label: "Dominations/hr",
    unit: "doms/hr",
    expr: "toFloat64(p.dominations) * 3600 / p.playtime_seconds",
  },
} as const;

export type MetricKey = keyof typeof METRICS;
const METRIC_KEYS = Object.keys(METRICS) as [MetricKey, ...MetricKey[]];

export const SUBJECTS = ["items", "combo2", "combo3"] as const;
export type Subject = (typeof SUBJECTS)[number];

/** Every performance-page filter lives in the URL — this schema is the contract. */
export const performanceFiltersSchema = z.object({
  /** items = single weapon group; combo2/combo3 = 2/3-weapon loadouts */
  subject: z.enum(SUBJECTS).catch("items").default("items"),
  /** which averaged metric to rank by */
  metric: z.enum(METRIC_KEYS).catch("points_hr").default("points_hr"),
  /** -1 = overall (all classes), 1-9 = Web API class number */
  class: z.number().int().min(-1).max(9).catch(-1).default(-1),
  /** min lifetime minutes played, snapped to HOURS_BUCKETS */
  minutes: z.number().int().nonnegative().catch(0).default(0).transform(snapTo(HOURS_BUCKETS)),
});
export type PerformanceFilters = z.infer<typeof performanceFiltersSchema>;

const performancePageSchema = performanceFiltersSchema.extend({
  offset: z.number().int().nonnegative().catch(0).default(0),
});

export interface PerfItemInfo {
  defindex: number;
  name: string | null;
  itemName: string | null;
  imageUrl: string | null;
  slot: string | null;
}

export interface PerfRow {
  /** stable react key: the member cgids joined */
  key: string;
  /** resolved item info per combo member (1 for items, 2-3 for combos) */
  members: PerfItemInfo[];
  /** averaged metric value over the equippers */
  value: number;
  /** distinct players in the sample */
  players: number;
  /** their mean playtime on the class, in hours */
  avgHours: number;
}

export interface PerfPage {
  rows: PerfRow[];
  /** offset of the next page, or null when this was the last one */
  nextOffset: number | null;
}

const PAGE_SIZE = 50;
/** noise floor: >= 10h on the class, >= 5 equippers per group */
const MIN_PLAYTIME_SECONDS = 36_000;
const MIN_PLAYERS = 5;

interface RawItemRow {
  cgid: number;
  value: number;
  players: number;
  avg_hours: number;
}

interface ComboAgg {
  members: number[];
  value: number;
  players: number;
  avg_hours: number;
}

/** placeholder info for a defindex missing from item_schema */
const fallbackInfo = (d: number): PerfItemInfo => ({
  defindex: d,
  name: null,
  itemName: null,
  imageUrl: null,
  slot: null,
});

/** class filter is a fixed integer once validated — bound as a CH param */
function classClause(cls: number, col: string): string {
  return cls === -1 ? "" : `and ${col} = {class:UInt8}`;
}

function baseParams(filters: PerformanceFilters, offset: number): Record<string, unknown> {
  return {
    minPlaytime: MIN_PLAYTIME_SECONDS,
    minMinutes: filters.minutes,
    minPlayers: MIN_PLAYERS,
    limit: PAGE_SIZE + 1,
    offset,
    ...(filters.class === -1 ? {} : { class: filters.class }),
  };
}

/**
 * ITEM PERFORMANCE: for each weapon group (cgid) on the selected class(es),
 * the average of the chosen metric over the players who equip it. `cgid`
 * already folds the pan family into per-class stock melees (done in the
 * syncer), so no remap is needed here.
 */
async function queryItems(filters: PerformanceFilters, offset: number): Promise<ComboAgg[]> {
  const metric = METRICS[filters.metric].expr;
  const rows = await chQuery<RawItemRow>(
    getCh(),
    `select
       e.cgid as cgid,
       avg(${metric}) as value,
       toUInt32(count(distinct e.steamid)) as players,
       avg(p.playtime_seconds) / 3600 as avg_hours
     from equipped e
     inner join player_class p on p.steamid = e.steamid and p.class_num = e.class_num
     where e.slot <= 6
       and p.playtime_seconds >= {minPlaytime:UInt32}
       and p.lifetime_min >= {minMinutes:UInt32}
       ${classClause(filters.class, "e.class_num")}
     group by e.cgid
     having players >= {minPlayers:UInt32}
     order by value desc, cgid asc
     limit {limit:UInt32} offset {offset:UInt32}`,
    baseParams(filters, offset),
  );
  return rows.map((r) => ({
    members: [r.cgid],
    value: r.value,
    players: r.players,
    avg_hours: r.avg_hours,
  }));
}

/**
 * COMBO PERFORMANCE: ARRAY JOIN a player's weapon_gids against itself to form
 * every 2- or 3-weapon combo they run, join to player_class, average the
 * metric over players who run that whole combo. The `a < b (< c)` guard keeps
 * each unordered combo once.
 */
async function queryCombos(
  filters: PerformanceFilters,
  offset: number,
  size: 2 | 3,
): Promise<ComboAgg[]> {
  const metric = METRICS[filters.metric].expr;
  const thirdJoin = size === 3 ? "array join l.weapon_gids as c" : "";
  const members = size === 3 ? "[a, b, c]" : "[a, b]";
  const groupCols = size === 3 ? "a, b, c" : "a, b";
  const guard = size === 3 ? "a < b and b < c" : "a < b";
  const orderCols = size === 3 ? "value desc, a asc, b asc, c asc" : "value desc, a asc, b asc";
  const rows = await chQuery<ComboAgg>(
    getCh(),
    `select
       ${members} as members,
       avg(${metric}) as value,
       toUInt32(count(distinct l.steamid)) as players,
       avg(p.playtime_seconds) / 3600 as avg_hours
     from loadout l
     array join l.weapon_gids as a
     array join l.weapon_gids as b
     ${thirdJoin}
     inner join player_class p on p.steamid = l.steamid and p.class_num = l.class_num
     where ${guard}
       and p.playtime_seconds >= {minPlaytime:UInt32}
       and p.lifetime_min >= {minMinutes:UInt32}
       ${classClause(filters.class, "l.class_num")}
     group by ${groupCols}
     having players >= {minPlayers:UInt32}
     order by ${orderCols}
     limit {limit:UInt32} offset {offset:UInt32}`,
    baseParams(filters, offset),
  );
  return rows;
}

/** resolve cgid representative defindexes to item names/icons via Postgres */
async function resolveItems(defindexes: number[]): Promise<Map<number, PerfItemInfo>> {
  const map = new Map<number, PerfItemInfo>();
  if (defindexes.length === 0) return map;
  const rows = await getDb()
    .select({
      defindex: schema.itemSchema.defindex,
      name: schema.itemSchema.name,
      itemName: schema.itemSchema.itemName,
      imageUrl: schema.itemSchema.imageUrl,
      slot: schema.itemSchema.slot,
    })
    .from(schema.itemSchema)
    .where(inArray(schema.itemSchema.defindex, defindexes));
  for (const r of rows) map.set(r.defindex, r);
  return map;
}

export const fetchPerformance = createServerFn({ method: "GET" })
  .validator(performancePageSchema)
  .handler(async ({ data }): Promise<PerfPage> => {
    const { offset, ...filters } = data;
    // over-fetch one row to learn whether another page exists
    const raw =
      filters.subject === "items"
        ? await queryItems(filters, offset)
        : await queryCombos(filters, offset, filters.subject === "combo3" ? 3 : 2);
    const page = raw.slice(0, PAGE_SIZE);

    const ids = [...new Set(page.flatMap((r) => r.members))];
    const info = await resolveItems(ids);

    const rows: PerfRow[] = page.map((r) => ({
      key: r.members.join("-"),
      members: r.members.map((d) => info.get(d) ?? fallbackInfo(d)),
      value: r.value,
      players: r.players,
      avgHours: r.avg_hours,
    }));

    return {
      rows,
      nextOffset: raw.length > PAGE_SIZE ? offset + PAGE_SIZE : null,
    };
  });

export const performanceInfiniteQueryOptions = (filters: PerformanceFilters) =>
  infiniteQueryOptions({
    queryKey: ["performance", filters],
    queryFn: ({ pageParam }) => fetchPerformance({ data: { ...filters, offset: pageParam } }),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextOffset,
  });
