/** Minimal Valve KeyValues parser — enough for items_game.txt. */

export type KV = { [key: string]: KV | string };

export function parseVdf(text: string): KV {
  let i = 0;
  const n = text.length;

  function skipWs(): void {
    for (;;) {
      while (i < n && " \t\r\n".includes(text[i] as string)) i++;
      if (i + 1 < n && text[i] === "/" && text[i + 1] === "/") {
        while (i < n && text[i] !== "\n") i++;
      } else {
        return;
      }
    }
  }

  function readToken(): string | "{" | "}" | undefined {
    skipWs();
    if (i >= n) return undefined;
    const c = text[i];
    if (c === "{" || c === "}") {
      i++;
      return c;
    }
    if (c === '"') {
      i++;
      let out = "";
      while (i < n && text[i] !== '"') {
        if (text[i] === "\\" && i + 1 < n) {
          const next = text[i + 1];
          out += next === "n" ? "\n" : next === "t" ? "\t" : (next as string);
          i += 2;
        } else {
          out += text[i];
          i++;
        }
      }
      i++;
      return out;
    }
    let out = "";
    while (i < n && !' \t\r\n"{}'.includes(text[i] as string)) {
      out += text[i];
      i++;
    }
    return out;
  }

  function parseBlock(): KV {
    const obj: KV = {};
    for (;;) {
      const key = readToken();
      if (key === undefined || key === "}") return obj;
      if (key === "{") throw new Error(`unexpected { at ${i}`);
      const val = readToken();
      if (val === "{") {
        const child = parseBlock();
        // duplicate keys occur (e.g. conditional blocks) — last one wins,
        // except merge objects shallowly to keep earlier children
        const prev = obj[key];
        obj[key] = prev && typeof prev === "object" ? { ...prev, ...child } : child;
      } else if (val === undefined || val === "}") {
        throw new Error(`missing value for key ${key} at ${i}`);
      } else {
        obj[key] = val;
      }
    }
  }

  const root = parseBlock();
  return root;
}
