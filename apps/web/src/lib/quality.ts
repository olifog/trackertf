/** TF2 item quality ids → display names + the canonical palette. */

export const QUALITY_NAMES: Record<number, string> = {
  0: "Normal",
  1: "Genuine",
  3: "Vintage",
  5: "Unusual",
  6: "Unique",
  7: "Community",
  8: "Valve",
  9: "Self-Made",
  11: "Strange",
  13: "Haunted",
  14: "Collector's",
  15: "Decorated",
};

export const QUALITY_COLORS: Record<number, string> = {
  0: "#B2B2B2",
  1: "#4D7455",
  3: "#476291",
  5: "#8650AC",
  6: "#FFD700",
  7: "#70B04A",
  8: "#A50F79",
  9: "#70B04A",
  11: "#CF6A32",
  13: "#38F3AB",
  14: "#AA0000",
  15: "#FAFAFA",
};

export const QUALITY_UNIQUE = 6;

export function qualityName(q: number): string {
  return QUALITY_NAMES[q] ?? `Quality ${q}`;
}

export function qualityColor(q: number): string {
  return QUALITY_COLORS[q] ?? QUALITY_COLORS[QUALITY_UNIQUE] ?? "#FFD700";
}

/**
 * Display order for quality-grouped lists: rare/interesting qualities first,
 * plain Unique last. Unknown ids sort just before Unique.
 */
const QUALITY_SORT: readonly number[] = [5, 14, 11, 13, 1, 3, 7, 8, 9, 15, 0, 6];

export function qualityRank(q: number): number {
  const i = QUALITY_SORT.indexOf(q);
  return i === -1 ? QUALITY_SORT.length - 2 : i;
}
