import { infiniteQueryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { chQuery } from "@trackertf/clickhouse";
import { schema } from "@trackertf/db";
import { inArray } from "drizzle-orm";
import { z } from "zod";
import { getCh } from "./ch.ts";
import { getDb } from "./db.ts";

/** min lifetime-minute experience buckets: All / 100h / 500h / 1000h / 2000h / 4000h */
export const HOURS_BUCKETS = [0, 6_000, 30_000, 60_000, 120_000, 240_000] as const;

/** snap an arbitrary URL value onto the nearest precomputed bucket */
const snapTo = (buckets: readonly number[]) => (v: number) =>
  buckets.reduce((best, b) => (Math.abs(b - v) < Math.abs(best - v) ? b : best));

/** Every combos-page filter lives in the URL — this schema is the contract. */
export const comboFiltersSchema = z.object({
  /** -1 = all classes (pooled), 1-9 = Web API class number. Per-class is the primary view. */
  class: z.number().int().min(-1).max(9).catch(1).default(1),
  /** combo size: 2 or 3 weapons; 4 only meaningful for Engineer (server clamps otherwise) */
  size: z.number().int().min(2).max(4).catch(2).default(2),
  /** min lifetime minutes for population A, snapped to HOURS_BUCKETS */
  minutes: z.number().int().nonnegative().catch(0).default(0).transform(snapTo(HOURS_BUCKETS)),
  /** min lifetime minutes for population B (compare mode), snapped to HOURS_BUCKETS */
  minutesB: z
    .number()
    .int()
    .nonnegative()
    .catch(240_000)
    .default(240_000)
    .transform(snapTo(HOURS_BUCKETS)),
  /** reveal the second experience population and per-combo A-vs-B delta */
  compare: z.boolean().catch(false).default(false),
  /** sort key: raw usage rate, or biggest A-vs-B delta (compare mode only) */
  sort: z.enum(["usage", "delta"]).catch("usage").default("usage"),
});
export type ComboFilters = z.infer<typeof comboFiltersSchema>;

const comboPageSchema = comboFiltersSchema.extend({
  offset: z.number().int().nonnegative().catch(0).default(0),
});

export interface ComboMember {
  defindex: number;
  /** schema token name (e.g. TF_WEAPON_SCATTERGUN) */
  name: string | null;
  /** localized display name, may be a #token when tf_english lacks it */
  itemName: string | null;
  imageUrl: string | null;
  slot: string | null;
}

export interface ComboRow {
  /** representative defindexes (ascending) of the weapons in this combo */
  gids: number[];
  members: ComboMember[];
  /** players in population A who run this exact combo */
  countA: number;
  /** fraction of population A who run this combo (0-1) */
  usageA: number;
  /** population-B figures, null unless compare mode is on */
  countB: number | null;
  usageB: number | null;
  /** usageB - usageA (positive = adopted more by the higher-experience group) */
  delta: number | null;
}

export interface ComboPage {
  rows: ComboRow[];
  /** offset of the next page, or null when this was the last one */
  nextOffset: number | null;
  /** size of population A (denominator) */
  popA: number | null;
  /** size of population B, null unless comparing */
  popB: number | null;
  compare: boolean;
  /** effective combo size after the Engineer-only clamp for size 4 */
  size: number;
}

const PAGE_SIZE = 100;
const LETTERS = ["a", "b", "c", "d"] as const;

/** counts come back as UInt64 → JSON strings; gids (UInt32) arrive as numbers */
interface RawComboRow {
  gids: number[];
  cntA: string;
  cntB?: string;
}
interface RawCount {
  n: string;
}

/**
 * Build the pair/triple/quad combo aggregation. `size` is a validated integer
 * in {2,3,4} — never user free-text — so composing the fixed ARRAY JOIN / ORDER
 * BY fragments from it is safe; all populations & values bind as CH params.
 */
function buildComboQuery(size: number, classNum: number, compare: boolean, sort: string): string {
  const letters = LETTERS.slice(0, size);
  const joins = letters.map((l) => `ARRAY JOIN weapon_gids AS ${l}`).join("\n    ");
  // strict ascending chain (a < b < c ...) collapses each unordered combo to one row
  const chain = letters
    .slice(1)
    .map((l, i) => `${letters[i]} < ${l}`)
    .join(" AND ");
  const gidsArr = `[${letters.join(", ")}] AS gids`;
  const groupBy = letters.join(", ");
  const classFilter = classNum === -1 ? "" : "AND class_num = {cls:UInt8}";

  if (compare) {
    const orderBy =
      sort === "delta"
        ? `abs(cntB / greatest({popB:Float64}, 1) - cntA / greatest({popA:Float64}, 1)) DESC, cntB DESC, ${groupBy}`
        : `cntA DESC, ${groupBy}`;
    return `
      SELECT ${gidsArr},
             countIf(lifetime_min >= {minA:UInt32}) AS cntA,
             countIf(lifetime_min >= {minB:UInt32}) AS cntB
      FROM loadout
      ${joins}
      WHERE lifetime_min >= {minFloor:UInt32} ${classFilter} AND ${chain}
      GROUP BY ${groupBy}
      HAVING (cntA + cntB) >= 2
      ORDER BY ${orderBy}
      LIMIT {lim:UInt32} OFFSET {off:UInt32}`;
  }
  return `
    SELECT ${gidsArr}, count() AS cntA
    FROM loadout
    ${joins}
    WHERE lifetime_min >= {minA:UInt32} ${classFilter} AND ${chain}
    GROUP BY ${groupBy}
    HAVING cntA >= 2
    ORDER BY cntA DESC, ${groupBy}
    LIMIT {lim:UInt32} OFFSET {off:UInt32}`;
}

function popQuery(classNum: number): string {
  const classFilter = classNum === -1 ? "" : "AND class_num = {cls:UInt8}";
  return `SELECT count() AS n FROM loadout WHERE lifetime_min >= {min:UInt32} ${classFilter}`;
}

async function fetchPop(classNum: number, minMinutes: number): Promise<number> {
  const params: Record<string, unknown> = { min: minMinutes };
  if (classNum !== -1) params["cls"] = classNum;
  const [row] = await chQuery<RawCount>(getCh(), popQuery(classNum), params);
  return row ? Number(row.n) : 0;
}

export const fetchCombos = createServerFn({ method: "GET" })
  .validator(comboPageSchema)
  .handler(async ({ data }): Promise<ComboPage> => {
    const { offset, class: classNum, minutes: minA, minutesB: minB, compare, sort } = data;
    // size 4 only makes sense for Engineer (6 weapon slots incl PDAs); clamp otherwise
    const size = data.size === 4 && classNum !== 9 ? 3 : data.size;
    const effectiveSort = compare ? sort : "usage";

    const [popA, popB] = await Promise.all([
      fetchPop(classNum, minA),
      compare ? fetchPop(classNum, minB) : Promise.resolve<number | null>(null),
    ]);

    const params: Record<string, unknown> = { minA, lim: PAGE_SIZE + 1, off: offset };
    if (classNum !== -1) params["cls"] = classNum;
    if (compare) {
      params["minB"] = minB;
      params["minFloor"] = Math.min(minA, minB);
      params["popA"] = popA;
      params["popB"] = popB ?? 0;
    }

    const raw = await chQuery<RawComboRow>(
      getCh(),
      buildComboQuery(size, classNum, compare, effectiveSort),
      params,
    );
    const page = raw.slice(0, PAGE_SIZE);

    // resolve representative defindexes → names/images from Postgres item_schema
    const gidSet = [...new Set(page.flatMap((r) => r.gids))];
    const items =
      gidSet.length > 0
        ? await getDb()
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

    const rows: ComboRow[] = page.map((r) => {
      const countA = Number(r.cntA);
      const countB = compare && r.cntB !== undefined ? Number(r.cntB) : null;
      const usageA = popA > 0 ? countA / popA : 0;
      const usageB = countB === null ? null : popB && popB > 0 ? countB / popB : 0;
      return {
        gids: r.gids,
        members: r.gids.map((d) => {
          const it = byDefindex.get(d);
          return {
            defindex: d,
            name: it?.name ?? null,
            itemName: it?.itemName ?? null,
            imageUrl: it?.imageUrl ?? null,
            slot: it?.slot ?? null,
          };
        }),
        countA,
        usageA,
        countB,
        usageB,
        delta: usageB !== null ? usageB - usageA : null,
      };
    });

    return {
      rows,
      nextOffset: raw.length > PAGE_SIZE ? offset + PAGE_SIZE : null,
      popA,
      popB,
      compare,
      size,
    };
  });

export const combosInfiniteQueryOptions = (filters: ComboFilters) =>
  infiniteQueryOptions({
    queryKey: ["combos", filters],
    queryFn: ({ pageParam }) => fetchCombos({ data: { ...filters, offset: pageParam } }),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextOffset,
  });
