import { type KV, parseVdf } from "./vdf.ts";

const ITEMS_GAME_URL =
  "https://raw.githubusercontent.com/SteamDatabase/GameTracking-TF2/master/tf/scripts/items/items_game.txt";

/**
 * Attributes that don't change gameplay — strange counters, paintkits,
 * australium gold, tradability flags, killstreak visuals, viewmodel tweaks.
 * Items differing only by these are functionally identical (reskins).
 */
const COSMETIC_ATTRS = new Set(
  [
    "kill eater",
    "kill eater score type",
    "kill eater score type 2",
    "kill eater score type 3",
    "kill eater kill type",
    "kill eater user 1",
    "kill eater user 2",
    "kill eater user 3",
    "kill eater user score type 1",
    "kill eater user score type 2",
    "kill eater user score type 3",
    "strange restriction type 1",
    "strange restriction value 1",
    "cannot trade",
    "always tradable",
    "never craftable",
    "tradable after date",
    "cannot restore",
    "cannot delete",
    "cannot giftwrap",
    "deactive date",
    "is marketable",
    "is commodity",
    "limited quantity item",
    "is australium item",
    "loot rarity",
    "item style override",
    "paintkit_proto_def_index",
    "set_item_texture_wear",
    "has team color paintkit",
    "min_viewmodel_offset",
    "inspect_viewmodel_offset",
    "weapon_allow_inspect",
    "weapon_uses_stattrak_module",
    "texture_wear_default",
    "special taunt",
    "weapon_stattrak_module_scale",
    "custom texture lo",
    "custom texture hi",
    "killstreak tier",
    "killstreak effect",
    "killstreak idleeffect",
    "hide_strange_prefix",
    "attach particle effect",
    "attach particle effect static",
    "set attached particle",
    "particle effect vertical offset",
    "particle effect use head origin",
    "style changes on strange level",
    "kill refills meter",
    "elevate quality",
    "elevate to unusual if applicable",
    "turn to gold",
    "SPELL: set item tint RGB",
    "SPELL: set Halloween footstep type",
    "disable fancy class select anim",
    "sapper voice pak",
    "sapper voice pak idle wait",
    "override projectile type",
    "vision opt in flags",
    "pyrovision only DISPLAY ONLY",
    "pyrovision opt in DISPLAY ONLY",
    // pure death/visual effects (Invasion reskins: Shooting Star, C.A.P.P.E.R, Batsaber)
    "ragdolls become ash",
    "ragdolls plasma effect",
    // Giger Counter's only diff from the Wrangler — changes the shield visual
    "is giger counter",
  ].map((s) => s.toLowerCase()),
);

/**
 * Community-consensus reskins whose tiny stat quirks the signature system
 * rightly flags (centered rockets, taunt differences) but players treat as
 * pure reskins. Maps defindex → base-item defindex.
 */
const MANUAL_MERGES: ReadonlyMap<number, number> = new Map([
  [513, 18], // The Original → Rocket Launcher (centerfire projectile)
  [741, 21], // The Rainblower → Flame Thrower (pyrovision + armageddon taunt)
  // lunchbox behavior is keyed by overloaded enum attrs ("lunchbox adds
  // minicrits" etc.) whose values differ per reskin while gameplay is
  // identical — cosmetic-izing them would over-merge (Steak vs Sandvich),
  // so these community-consensus food reskins merge manually:
  [433, 159], // Fishcake → Dalokohs Bar (maxhealth-bonus enum 7 vs 1, same effect)
  [863, 42], // Robo-Sandvich → Sandvich (minicrits enum 3, same effect)
  [1002, 42], // Festive Sandvich → Sandvich (minicrits enum 4, same effect)
  // GRU reskin: differs only by "breadgloves properties" (visual) and a
  // redundant "allowed in medieval mode" flag (melee is always allowed) —
  // the medieval flag is real gameplay on other slots, so merge manually
  [1100, 239], // The Bread Bite → Gloves of Running Urgently
]);

/** Weapon-ish slots eligible for functional-group merging. Cosmetics/taunts
 * share item_class (tf_wearable etc.) and would over-merge catastrophically. */
const WEAPON_SLOTS = new Set([
  "primary",
  "secondary",
  "melee",
  "pda",
  "pda2",
  "building",
  "utility",
]);

interface ResolvedItem {
  defindex: number;
  itemClass: string | undefined;
  slot: string | undefined;
  classes: string[];
  gameplayAttrs: string;
}

function asObj(v: KV | string | undefined): KV | undefined {
  return v && typeof v === "object" ? v : undefined;
}
function asStr(v: KV | string | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Merge prefab chain (space-separated, recursive) then the item's own keys. */
function resolve(raw: KV, prefabs: KV, cache: Map<string, KV>): KV {
  const chain = asStr(raw["prefab"]);
  if (!chain) return raw;
  let base: KV = {};
  for (const name of chain.split(/\s+/)) {
    let resolved = cache.get(name);
    if (!resolved) {
      const p = asObj(prefabs[name]);
      resolved = p ? resolve(p, prefabs, cache) : {};
      cache.set(name, resolved);
    }
    base = deepMerge(base, resolved);
  }
  return deepMerge(base, raw);
}

function deepMerge(base: KV, over: KV): KV {
  const out: KV = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const prev = out[k];
    out[k] = prev && typeof prev === "object" && typeof v === "object" ? deepMerge(prev, v) : v;
  }
  return out;
}

function gameplayAttrSignature(item: KV): string {
  const parts: string[] = [];
  const attrs = asObj(item["attributes"]);
  if (attrs) {
    for (const [name, def] of Object.entries(attrs)) {
      if (COSMETIC_ATTRS.has(name.toLowerCase())) continue;
      const value = typeof def === "object" ? asStr(def["value"]) : def;
      parts.push(`${name.toLowerCase()}=${value ?? ""}`);
    }
  }
  const statics = asObj(item["static_attrs"]);
  if (statics) {
    for (const [name, v] of Object.entries(statics)) {
      if (COSMETIC_ATTRS.has(name.toLowerCase())) continue;
      parts.push(`${name.toLowerCase()}=${typeof v === "string" ? v : JSON.stringify(v)}`);
    }
  }
  return parts.toSorted().join("|");
}

/** Resolved view of one item for reskin diagnostics (validate-reskins script). */
export interface ItemSummary {
  defindex: number;
  name: string | undefined;
  itemClass: string | undefined;
  slot: string | undefined;
  classes: string[];
  gameplayAttrs: string;
}

export function summarizeItem(itemsGame: KV, defindex: number): ItemSummary | undefined {
  const items = asObj(itemsGame["items"]) ?? {};
  const prefabs = asObj(itemsGame["prefabs"]) ?? {};
  const raw = asObj(items[String(defindex)]);
  if (!raw) return undefined;
  const item = resolve(raw, prefabs, new Map());
  const usedBy = asObj(item["used_by_classes"]);
  return {
    defindex,
    name: asStr(item["name"]),
    itemClass: asStr(item["item_class"])?.toLowerCase(),
    slot: asStr(item["item_slot"])?.toLowerCase(),
    classes: usedBy
      ? Object.keys(usedBy)
          .map((c) => c.toLowerCase())
          .toSorted()
      : ["all"],
    gameplayAttrs: gameplayAttrSignature(item),
  };
}

const SLOT_NUMS: Record<string, number> = { primary: 0, secondary: 1, melee: 2 };
const CLASS_NUMS: Record<string, number> = {
  scout: 1,
  sniper: 2,
  soldier: 3,
  demoman: 4,
  medic: 5,
  heavy: 6,
  pyro: 7,
  spy: 8,
  engineer: 9,
};

export interface ClassSlot {
  defindex: number;
  classNum: number;
  slot: number;
}

/**
 * (defindex, class, slot) capabilities for weapon slots, honoring per-class
 * slot overrides in used_by_classes ("engineer": "primary" on the shotgun).
 */
export function computeClassSlots(itemsGame: KV): ClassSlot[] {
  const items = asObj(itemsGame["items"]) ?? {};
  const prefabs = asObj(itemsGame["prefabs"]) ?? {};
  const cache = new Map<string, KV>();
  const out: ClassSlot[] = [];
  for (const [key, rawVal] of Object.entries(items)) {
    const defindex = Number(key);
    const raw = asObj(rawVal);
    if (!Number.isInteger(defindex) || !raw) continue;
    const item = resolve(raw, prefabs, cache);
    const defaultSlot = asStr(item["item_slot"])?.toLowerCase();
    const usedBy = asObj(item["used_by_classes"]);
    if (!usedBy) continue;
    for (const [className, slotOverride] of Object.entries(usedBy)) {
      const classNum = CLASS_NUMS[className.toLowerCase()];
      if (classNum === undefined) continue;
      const slotName =
        typeof slotOverride === "string" && slotOverride !== "1"
          ? slotOverride.toLowerCase()
          : defaultSlot;
      const slot = slotName === undefined ? undefined : SLOT_NUMS[slotName];
      if (slot !== undefined) out.push({ defindex, classNum, slot });
    }
  }
  return out;
}

/** defindex → paintkit proto id for decorated (warpaint) items */
export function computePaintkitItems(itemsGame: KV): Map<number, number> {
  const items = asObj(itemsGame["items"]) ?? {};
  const prefabs = asObj(itemsGame["prefabs"]) ?? {};
  const cache = new Map<string, KV>();
  const out = new Map<number, number>();
  for (const [key, rawVal] of Object.entries(items)) {
    const defindex = Number(key);
    const raw = asObj(rawVal);
    if (!Number.isInteger(defindex) || !raw) continue;
    const item = resolve(raw, prefabs, cache);
    const statics = asObj(item["static_attrs"]);
    const pk = statics ? asStr(statics["paintkit_proto_def_index"]) : undefined;
    if (pk !== undefined) out.set(defindex, Number(pk));
  }
  return out;
}

export async function fetchItemsGame(fetchImpl: typeof fetch = fetch): Promise<KV> {
  const res = await fetchImpl(ITEMS_GAME_URL);
  if (!res.ok) throw new Error(`items_game fetch HTTP ${res.status}`);
  const root = parseVdf(await res.text());
  const ig = asObj(root["items_game"]);
  if (!ig) throw new Error("items_game root missing");
  return ig;
}

/**
 * Functional groups: weapons sharing item_class + slot + usable classes +
 * gameplay attributes are reskins of each other. Group id = min defindex
 * (the stock/base item). Returns only defindexes that belong to a group of ≥2.
 */
export function computeReskinGroups(itemsGame: KV): Map<number, number> {
  const items = asObj(itemsGame["items"]) ?? {};
  const prefabs = asObj(itemsGame["prefabs"]) ?? {};
  const cache = new Map<string, KV>();

  const resolved: ResolvedItem[] = [];
  for (const [key, rawVal] of Object.entries(items)) {
    const defindex = Number(key);
    const raw = asObj(rawVal);
    if (!Number.isInteger(defindex) || !raw) continue;
    const item = resolve(raw, prefabs, cache);
    const slot = asStr(item["item_slot"])?.toLowerCase();
    if (!slot || !WEAPON_SLOTS.has(slot)) continue;
    let itemClass = asStr(item["item_class"])?.toLowerCase();
    if (!itemClass) continue;
    // Valve inconsistency: stock sapper is tf_weapon_builder, newer sappers
    // (Ap-Sap, Festive) are tf_weapon_sapper — same weapon
    if (slot === "building" && itemClass === "tf_weapon_builder") itemClass = "tf_weapon_sapper";
    const usedBy = asObj(item["used_by_classes"]);
    const classes = usedBy
      ? Object.keys(usedBy)
          .map((c) => c.toLowerCase())
          .toSorted()
      : ["all"];
    resolved.push({
      defindex,
      itemClass,
      slot,
      classes,
      gameplayAttrs: gameplayAttrSignature(item),
    });
  }

  const groups = new Map<string, number[]>();
  for (const item of resolved) {
    // classes intentionally excluded (per-class stock shotguns and 7-class pan
    // vs 9-class golden pan are the same item) — EXCEPT building-slot items,
    // where engineer's toolbox and spy's sapper share item_class and would
    // otherwise merge cross-class into a nonsense "PDA" row
    // slot intentionally excluded so engineer's primary shotgun unifies with
    // the 3-class secondary family (per-slot denominators handle normalization)
    const sig =
      item.slot === "building"
        ? `${item.itemClass}::building::${item.classes.join(",")}::${item.gameplayAttrs}`
        : `${item.itemClass}::${item.gameplayAttrs}`;
    const list = groups.get(sig);
    if (list) list.push(item.defindex);
    else groups.set(sig, [item.defindex]);
  }

  const out = new Map<number, number>();
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const groupId = Math.min(...members);
    for (const d of members) out.set(d, groupId);
  }
  for (const [variant, base] of MANUAL_MERGES) {
    const groupId = out.get(base) ?? base;
    out.set(variant, groupId);
    out.set(base, groupId);
  }
  return out;
}
