/**
 * Geo display helpers shared across pages that surface location data (player
 * sightings, country breakdowns). Region codes are Valve's GetServerList region
 * ints; country codes are ISO 3166-1 alpha-2 from Steam profiles.
 */

/** Valve GetServerList region code → human label. 255 (PG) / -1 (ClickHouse
 * Int8 wrap) both mean SDR-routed / region-hidden, which casual mostly is. */
const REGION_NAMES: Record<number, string> = {
  0: "US East",
  1: "US West",
  2: "South America",
  3: "Europe",
  4: "Asia",
  5: "Australia",
  6: "Middle East",
  7: "Africa",
};

export function regionLabel(code: number): string {
  if (code === 255 || code < 0) return "World / SDR";
  return REGION_NAMES[code] ?? `Region ${code}`;
}

/** ISO alpha-2 → regional-indicator flag emoji (e.g. "US" → 🇺🇸). */
export function countryFlag(code: string | null | undefined): string {
  if (!code || !/^[A-Za-z]{2}$/.test(code)) return "";
  const cc = code.toUpperCase();
  return String.fromCodePoint(0x1f1e6 + (cc.charCodeAt(0) - 65), 0x1f1e6 + (cc.charCodeAt(1) - 65));
}

let regionNames: Intl.DisplayNames | undefined;
/** ISO alpha-2 → English country name (e.g. "US" → "United States"). Falls back
 * to the raw code for unknown/invalid values. */
export function countryName(code: string | null | undefined): string {
  if (!code || !/^[A-Za-z]{2}$/.test(code)) return code ?? "";
  regionNames ??= new Intl.DisplayNames(["en"], { type: "region" });
  try {
    return regionNames.of(code.toUpperCase()) ?? code.toUpperCase();
  } catch {
    return code.toUpperCase();
  }
}
