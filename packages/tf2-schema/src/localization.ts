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
