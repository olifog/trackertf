/**
 * Validate reskin grouping against a real items_game.txt.
 * Usage: bun scripts/validate-reskins.ts  (uses /tmp/items_game.txt if present,
 * otherwise fetches from SteamDatabase/GameTracking-TF2). Exits 1 on failure.
 */
import { existsSync, readFileSync } from "node:fs";
import { computeReskinGroups, fetchItemsGame, summarizeItem } from "../src/items-game.ts";
import { type KV, parseVdf } from "../src/vdf.ts";

const LOCAL = "/tmp/items_game.txt";
let ig: KV;
if (existsSync(LOCAL)) {
  console.log(`using ${LOCAL}`);
  const root = parseVdf(readFileSync(LOCAL, "utf8"));
  const inner = root["items_game"];
  ig = inner && typeof inner === "object" ? inner : root;
} else {
  console.log("fetching items_game.txt from GameTracking-TF2");
  ig = await fetchItemsGame();
}

const groups = computeReskinGroups(ig);

interface Check {
  a: number;
  b: number;
  together: boolean;
  label: string;
}

const CHECKS: Check[] = [
  // long-standing expectations
  { a: 13, b: 200, together: true, label: "Scattergun ↔ Upgradeable Scattergun" },
  { a: 18, b: 205, together: true, label: "Rocket Launcher ↔ Upgradeable RL" },
  { a: 18, b: 513, together: true, label: "Rocket Launcher ↔ The Original (manual)" },
  { a: 21, b: 741, together: true, label: "Flame Thrower ↔ Rainblower (manual)" },
  { a: 735, b: 933, together: true, label: "Sapper ↔ Ap-Sap (builder/sapper class fold)" },
  { a: 264, b: 1071, together: true, label: "Frying Pan ↔ Golden Frying Pan" },
  { a: 9, b: 199, together: true, label: "Shotgun ↔ Upgradeable Shotgun" },
  { a: 14, b: 201, together: true, label: "Sniper Rifle ↔ Upgradeable Sniper Rifle" },
  { a: 200, b: 45, together: false, label: "Scattergun vs Force-A-Nature stay separate" },
  { a: 24, b: 61, together: false, label: "Revolver vs Ambassador stay separate" },
  { a: 21, b: 215, together: false, label: "Flame Thrower vs Degreaser stay separate" },
  { a: 735, b: 25, together: false, label: "Sapper vs Construction PDA stay separate" },
  // new: Invasion reskins (differ only by ragdoll/visual attrs)
  { a: 526, b: 30665, together: true, label: "Machina ↔ Shooting Star" },
  { a: 22, b: 30666, together: true, label: "Pistol ↔ C.A.P.P.E.R" },
  { a: 0, b: 30667, together: true, label: "Bat ↔ Batsaber" },
  { a: 140, b: 30668, together: true, label: "Wrangler ↔ Giger Counter" },
  { a: 14, b: 30665, together: false, label: "stock Sniper Rifle vs Shooting Star stay separate" },
  // new: food + bread reskins (manual merges over overloaded lunchbox enums)
  { a: 159, b: 433, together: true, label: "Dalokohs Bar ↔ Fishcake (manual)" },
  { a: 42, b: 863, together: true, label: "Sandvich ↔ Robo-Sandvich (manual)" },
  { a: 42, b: 1002, together: true, label: "Sandvich ↔ Festive Sandvich (manual)" },
  { a: 239, b: 1100, together: true, label: "GRU ↔ Bread Bite (manual)" },
  { a: 239, b: 1084, together: true, label: "GRU ↔ Festive GRU" },
  { a: 42, b: 159, together: false, label: "Sandvich vs Dalokohs Bar stay separate" },
  { a: 42, b: 311, together: false, label: "Sandvich vs Buffalo Steak stay separate" },
  // new: Cow Mangler is functionally distinct (no crits, charged shot, no
  // ammo) and has a unique item_class — never merges with the RL family
  { a: 18, b: 441, together: false, label: "Rocket Launcher vs Cow Mangler 5000 stay separate" },
];

let failures = 0;
for (const c of CHECKS) {
  const ga = groups.get(c.a);
  const gb = groups.get(c.b);
  const together = ga !== undefined && ga === gb;
  const ok = together === c.together;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${c.label}  [#${c.a} group=${ga ?? "—"} | #${c.b} group=${gb ?? "—"}]`,
  );
  if (!ok) {
    failures++;
    for (const d of [c.a, c.b]) {
      const s = summarizeItem(ig, d);
      console.log(
        `      #${d} ${s?.name}: class=${s?.itemClass} slot=${s?.slot} attrs=${s?.gameplayAttrs || "(none)"}`,
      );
    }
  }
}

// sanity: cosmetic-attr additions must not have collapsed distinct weapons
const sizes = new Map<number, number>();
for (const gid of groups.values()) sizes.set(gid, (sizes.get(gid) ?? 0) + 1);
const biggest = [...sizes.entries()].toSorted((x, y) => y[1] - x[1]).slice(0, 5);
console.log(
  `\n${groups.size} grouped defindexes in ${sizes.size} groups; largest: ` +
    biggest.map(([g, n]) => `#${g}×${n}`).join(", "),
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("all checks passed");
