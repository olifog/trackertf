/**
 * Canonical weapon-slot display order, mirroring WEAPON_SLOTS in
 * server/search.ts. Shared by the combos and performance pages so a combo's
 * items are always presented in the same slot sequence
 * (primary → secondary → melee → pda → pda2 → building) on both.
 */
export const SLOT_ORDER = ["primary", "secondary", "melee", "pda", "pda2", "building"] as const;

const RANK = new Map<string, number>(SLOT_ORDER.map((s, i) => [s, i]));

/** Sort rank for an item_schema slot string; unknown/null slots sort last. */
export function slotRank(slot: string | null | undefined): number {
  const r = slot == null ? undefined : RANK.get(slot);
  return r ?? SLOT_ORDER.length;
}

/** Order combo members by canonical slot, with defindex as a stable tiebreak. */
export function bySlot<T extends { slot: string | null; defindex: number }>(members: T[]): T[] {
  return [...members].sort(
    (a, b) => slotRank(a.slot) - slotRank(b.slot) || a.defindex - b.defindex,
  );
}
