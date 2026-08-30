export const CLASS_NAMES: Record<number, string> = {
  1: "Scout",
  2: "Sniper",
  3: "Soldier",
  4: "Demoman",
  5: "Medic",
  6: "Heavy",
  7: "Pyro",
  8: "Spy",
  9: "Engineer",
};

// 9-hue categorical palette (Tableau-10 derived), indexed by classNum-1. Chosen
// for mutual contrast and adequate legibility in both light and dark themes.
// Shared by every class-share visual (matches mix bars, player class table).
const CLASS_COLORS = [
  "#4e79a7",
  "#f28e2b",
  "#e15759",
  "#76b7b2",
  "#59a14f",
  "#edc948",
  "#b07aa1",
  "#ff9da7",
  "#9c755f",
] as const;

export function classColor(classNum: number): string {
  return CLASS_COLORS[(classNum - 1) % CLASS_COLORS.length] ?? "var(--muted-foreground)";
}

export const SLOT_NAMES: Record<number, string> = {
  0: "Primary",
  1: "Secondary",
  2: "Melee",
  3: "Disguise Kit",
  4: "Sapper",
  5: "PDA",
  6: "Watch",
  7: "Cosmetic",
  8: "Taunt",
};

/** Stock items carry localization tokens when tf_english lacks them. */
export function itemDisplayName(item: {
  itemName: string | null;
  name: string | null;
  defindex: number;
}): string {
  if (item.itemName && !item.itemName.startsWith("#")) return item.itemName;
  const source = item.itemName?.slice(1) ?? item.name ?? String(item.defindex);
  return source
    .replace(/^TF_WEAPON_/i, "")
    .replaceAll("_", " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function avatarUrl(hash: string | null): string | null {
  return hash ? `https://avatars.steamstatic.com/${hash}_full.jpg` : null;
}

export function formatHours(minutes: number | null): string {
  return minutes === null ? "?" : `${Math.round(minutes / 60).toLocaleString()}h`;
}

export function formatAgo(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}
