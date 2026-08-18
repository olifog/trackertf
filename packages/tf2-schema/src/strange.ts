/**
 * Canonical TF2 Strange weapon kill_eater rank tiers. A weapon's rank is the
 * name of the highest tier whose `min` kill count it has reached. "Hale's Own"
 * (25000 kills) is the top rank.
 */
export interface StrangeRank {
  /** minimum kill_eater count to reach this rank */
  min: number;
  name: string;
}

/** Ordered ascending by `min`; the top rank is "Hale's Own" at 25000. */
export const STRANGE_RANKS: readonly StrangeRank[] = [
  { min: 0, name: "Strange" },
  { min: 10, name: "Unremarkable" },
  { min: 25, name: "Scarcely Lethal" },
  { min: 45, name: "Mildly Menacing" },
  { min: 70, name: "Somewhat Threatening" },
  { min: 100, name: "Uncharitable" },
  { min: 135, name: "Notably Dangerous" },
  { min: 175, name: "Sufficiently Lethal" },
  { min: 225, name: "Truly Feared" },
  { min: 275, name: "Spectacularly Lethal" },
  { min: 350, name: "Gore-Spattered" },
  { min: 500, name: "Wicked Nasty" },
  { min: 750, name: "Positively Inhumane" },
  { min: 999, name: "Totally Ordinary" },
  { min: 1000, name: "Face-Melting" },
  { min: 1500, name: "Rage-Inducing" },
  { min: 2500, name: "Server-Clearing" },
  { min: 5000, name: "Epic" },
  { min: 7500, name: "Legendary" },
  { min: 12500, name: "Australian" },
  { min: 25000, name: "Hale's Own" },
] as const;

/** The kill count of the top rank ("Hale's Own"). */
export const HALE_OWN_KILLS = 25000;

/** Rank name for a given kill_eater count (highest tier reached). */
export function strangeRank(kills: number): string {
  let name = STRANGE_RANKS[0]!.name;
  for (const tier of STRANGE_RANKS) {
    if (kills >= tier.min) name = tier.name;
    else break;
  }
  return name;
}

/** Progress toward "Hale's Own" as a percentage, clamped to [0, 100]. */
export function haleOwnPct(kills: number): number {
  return Math.min(100, (kills / HALE_OWN_KILLS) * 100);
}
