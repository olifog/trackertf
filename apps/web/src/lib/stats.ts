/**
 * Small statistics helpers for the "compare experience" views. When we compare
 * a usage/combo share between two experience populations (e.g. All vs 4000h+),
 * the raw delta can look dramatic while being pure noise — small samples, or
 * high-hour buckets polluted by idle bot accounts that equip nothing. A
 * two-proportion z-test tells us whether the difference is real at all.
 */

/** Standard normal CDF via an Abramowitz & Stegun erf approximation (max abs
 * error ~1.5e-7) — avoids pulling in a stats dependency. */
export function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const p =
    d *
    t *
    (0.319381530 +
      t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - p : p;
}

export interface ProportionTest {
  /** share in population 1 (x1 / n1), 0 if n1 = 0 */
  p1: number;
  /** share in population 2 (x2 / n2), 0 if n2 = 0 */
  p2: number;
  /** signed difference p1 - p2 */
  diff: number;
  /** z statistic (0 when undefined — empty pool or zero variance) */
  z: number;
  /** two-sided p-value in [0, 1] */
  pValue: number;
  /** true when pValue < alpha (default 0.05) */
  significant: boolean;
}

/**
 * Two-proportion z-test with pooled variance. `x` = number of players in each
 * population equipping the item/combo; `n` = that population's total players.
 * Returns significant=false for degenerate inputs (empty populations, no
 * variance) rather than throwing, so callers can render it inline safely.
 */
export function twoProportionZTest(
  x1: number,
  n1: number,
  x2: number,
  n2: number,
  alpha = 0.05,
): ProportionTest {
  const p1 = n1 > 0 ? x1 / n1 : 0;
  const p2 = n2 > 0 ? x2 / n2 : 0;
  const diff = p1 - p2;
  if (n1 <= 0 || n2 <= 0) {
    return { p1, p2, diff, z: 0, pValue: 1, significant: false };
  }
  const pPool = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(pPool * (1 - pPool) * (1 / n1 + 1 / n2));
  if (!(se > 0)) {
    return { p1, p2, diff, z: 0, pValue: 1, significant: false };
  }
  const z = diff / se;
  const pValue = 2 * (1 - normalCdf(Math.abs(z)));
  return { p1, p2, diff, z, pValue, significant: pValue < alpha };
}

/** Compact human label for a p-value, e.g. "p<0.001", "p=0.03", "ns". */
export function formatPValue(pValue: number, significant = pValue < 0.05): string {
  if (!significant) return "ns";
  if (pValue < 0.001) return "p<0.001";
  return `p=${pValue.toFixed(pValue < 0.01 ? 3 : 2)}`;
}
