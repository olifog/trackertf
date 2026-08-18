import type { BackpackItem } from "@trackertf/steam";
import { CLASS_NUMBERS, type ClassName } from "@trackertf/tf2-schema";

/**
 * Stock weapon defindexes per class/slot — stock items don't appear in
 * backpacks, so an empty slot means the stock item is equipped.
 * Row index = class number - 1; -1 = class has no such slot.
 * (Ported from styletf; 7 slots covers engineer/spy extras.)
 */
const STOCK_ITEMS: readonly (readonly number[])[] = [
  [13, 23, 0, -1, -1, -1, -1], // scout
  [14, 16, 3, -1, -1, -1, -1], // sniper
  [18, 10, 6, -1, -1, -1, -1], // soldier
  [19, 20, 1, -1, -1, -1, -1], // demoman
  [17, 29, 8, -1, -1, -1, -1], // medic
  [15, 11, 5, -1, -1, -1, -1], // heavy
  [21, 12, 2, -1, -1, -1, -1], // pyro
  [-1, 24, 4, 27, 735, -1, 30], // spy
  [9, 22, 7, -1, 26, 25, 28], // engineer
];

export const SLOT_COSMETIC = 7;
export const SLOT_TAUNT = 8;

/**
 * Physical equip slots 4/6 mean different things per class (spy: sapper/watch,
 * engineer: destruction PDA/toolbox). Remap engineer's to the semantic PDA
 * slot (5) so slot filters mean one thing: 4=sapper, 5=PDAs, 6=watch.
 */
function semanticSlot(classNum: number, slot: number): number {
  if (classNum === 9 && (slot === 4 || slot === 6)) return 5;
  return slot;
}

/** Unique — the default quality; stock backfill rows are always Unique. */
const QUALITY_UNIQUE = 6;

export interface EquippedRow {
  defindex: number;
  classNum: number;
  slot: number;
  quality: number;
}

/**
 * Extract equipped items and backfill stock weapons.
 * Raw equip slots: 0-6 weapons, 7-10 cosmetics, 11+ taunts, 9 skipped
 * (per styletf's handling of the action slot).
 */
export function parseEquipped(items: readonly BackpackItem[]): EquippedRow[] {
  const out: EquippedRow[] = [];
  // stock backfill decisions use PHYSICAL slot occupancy; stored rows use
  // semantic slots (engineer's two PDA physical slots both map to 5)
  const physicalOccupied = new Set<string>();

  for (const item of items) {
    for (const equip of item.equipped ?? []) {
      if (equip.slot === 9 || equip.class < 1 || equip.class > 9) continue;
      const slot = equip.slot < 7 ? equip.slot : equip.slot < 11 ? SLOT_COSMETIC : SLOT_TAUNT;
      if (slot < 7) physicalOccupied.add(`${equip.class}:${slot}`);
      out.push({
        defindex: item.defindex,
        classNum: equip.class,
        slot: semanticSlot(equip.class, slot),
        quality: item.quality ?? QUALITY_UNIQUE,
      });
    }
  }

  for (let classNum = 1; classNum <= 9; classNum++) {
    const stock = STOCK_ITEMS[classNum - 1];
    if (!stock) continue;
    for (let slot = 0; slot < stock.length; slot++) {
      const defindex = stock[slot];
      if (defindex === undefined || defindex === -1) continue;
      if (!physicalOccupied.has(`${classNum}:${slot}`)) {
        out.push({
          defindex,
          classNum,
          slot: semanticSlot(classNum, slot),
          quality: QUALITY_UNIQUE,
        });
      }
    }
  }

  return dedupe(out);
}

function dedupe(rows: EquippedRow[]): EquippedRow[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    const key = `${r.classNum}:${r.slot}:${r.defindex}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface ClassStatsRow {
  classNum: number;
  playtimeSeconds: number;
  kills: number;
  killAssists: number;
  damageDealt: number;
  pointsScored: number;
  dominations: number;
  captures: number;
  defenses: number;
}

const ACCUM_FIELDS = {
  iPlayTime: "playtimeSeconds",
  iNumberOfKills: "kills",
  iKillAssists: "killAssists",
  iDamageDealt: "damageDealt",
  iPointsScored: "pointsScored",
  iDominations: "dominations",
  iPointCaptures: "captures",
  iPointDefenses: "defenses",
} as const;

/** Extract <Class>.accum.* into per-class rows (classes with no playtime skipped). */
export function parseClassStats(stats: ReadonlyMap<string, number>): ClassStatsRow[] {
  const rows: ClassStatsRow[] = [];

  for (const [className, classNum] of Object.entries(CLASS_NUMBERS) as [ClassName, number][]) {
    const row: ClassStatsRow = {
      classNum,
      playtimeSeconds: 0,
      kills: 0,
      killAssists: 0,
      damageDealt: 0,
      pointsScored: 0,
      dominations: 0,
      captures: 0,
      defenses: 0,
    };
    for (const [stat, field] of Object.entries(ACCUM_FIELDS)) {
      row[field] = stats.get(`${className}.accum.${stat}`) ?? 0;
    }
    if (row.playtimeSeconds > 0) rows.push(row);
  }

  return rows;
}
