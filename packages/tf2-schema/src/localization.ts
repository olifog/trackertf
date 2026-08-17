import { parseVdf } from "./vdf.ts";

const TF_ENGLISH_URL =
  "https://raw.githubusercontent.com/SteamDatabase/GameTracking-TF2/master/tf/resource/tf_english.txt";

/**
 * English localization tokens (lowercased keys) from tf_english.txt —
 * resolves item_name values like "#TF_Unique_Achievement_Pickaxe" to
 * "The Pickaxe". File is UTF-16LE with BOM.
 */
export async function fetchLocalization(
  fetchImpl: typeof fetch = fetch,
): Promise<Map<string, string>> {
  const res = await fetchImpl(TF_ENGLISH_URL);
  if (!res.ok) throw new Error(`tf_english fetch HTTP ${res.status}`);
  // BOM-sniff: Valve ships UTF-16LE, GameTracking re-encodes as UTF-8
  const buf = new Uint8Array(await res.arrayBuffer());
  const decoder =
    buf[0] === 0xff && buf[1] === 0xfe
      ? // @types/node's Encoding union omits utf-16le, but every runtime supports it
        new TextDecoder("utf-16le" as never)
      : new TextDecoder("utf-8");
  const text = decoder.decode(buf);
  const root = parseVdf(text.replace(/^﻿/, ""));
  const lang = root["lang"];
  const tokens = lang && typeof lang === "object" ? lang["Tokens"] : undefined;
  if (!tokens || typeof tokens !== "object") throw new Error("tf_english Tokens missing");
  const map = new Map<string, string>();
  for (const [key, value] of Object.entries(tokens)) {
    if (typeof value === "string") map.set(key.toLowerCase(), value);
  }
  return map;
}

/** "#TF_Weapon_Medigun" → "Medi Gun"; non-token names pass through. */
export function localizeName(
  itemName: string | null | undefined,
  loc: Map<string, string>,
): string | null {
  if (!itemName) return null;
  if (!itemName.startsWith("#")) return itemName;
  return loc.get(itemName.slice(1).toLowerCase()) ?? itemName;
}

const PROTO_DEFS_URL =
  "https://raw.githubusercontent.com/SteamDatabase/GameTracking-TF2/master/tf/resource/tf_proto_obj_defs_english.txt";

/** paintkit id → English name ("Killer Bee"), from tf_proto_obj_defs. */
export async function fetchPaintkitNames(
  fetchImpl: typeof fetch = fetch,
): Promise<Map<number, string>> {
  const res = await fetchImpl(PROTO_DEFS_URL);
  if (!res.ok) throw new Error(`proto_obj_defs fetch HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const decoder =
    buf[0] === 0xff && buf[1] === 0xfe
      ? new TextDecoder("utf-16le" as never)
      : new TextDecoder("utf-8");
  const text = decoder.decode(buf);
  const map = new Map<number, string>();
  // "9_85_field { field_number: 2 }"  "Killer Bee"   (9 = paintkit type)
  for (const m of text.matchAll(/"9_(\d+)_field \{ field_number: 2 \}"\s+"([^"\n]+)"/g)) {
    map.set(Number(m[1]), m[2] as string);
  }
  return map;
}
