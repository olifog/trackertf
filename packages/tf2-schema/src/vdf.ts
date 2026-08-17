/** Minimal Valve KeyValues parser — enough for items_game.txt + tf_english.txt. */

export type KV = { [key: string]: KV | string };

type Token = { text: string; quoted: boolean } | "{" | "}" | undefined;

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

  function readToken(): Token {
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
      return { text: out, quoted: true };
    }
    let out = "";
    while (i < n && !' \t\r\n"{}'.includes(text[i] as string)) {
      out += text[i];
      i++;
    }
    return { text: out, quoted: false };
  }

  function parseBlock(): KV {
    const obj: KV = {};
    for (;;) {
      const key = readToken();
      if (key === undefined || key === "}") return obj;
      if (key === "{") throw new Error(`unexpected { at ${i}`);
      let val = readToken();
      // skip UNQUOTED platform conditionals like [$WIN32] after keys —
      // quoted values that merely look bracketed must not be skipped
      while (
        typeof val === "object" &&
        val !== undefined &&
        !val.quoted &&
        val.text.startsWith("[") &&
        val.text.endsWith("]")
      ) {
        val = readToken();
      }
      if (val === "{") {
        const child = parseBlock();
        // duplicate keys occur (e.g. conditional blocks) — merge shallowly
        const prev = obj[key.text];
        obj[key.text] = prev && typeof prev === "object" ? { ...prev, ...child } : child;
      } else if (val === undefined || val === "}") {
        throw new Error(`missing value for key ${key.text.slice(0, 60)} at ${i}`);
      } else {
        obj[key.text] = val.text;
      }
    }
  }

  return parseBlock();
}
