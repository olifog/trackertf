import { type Db, schema } from "@trackertf/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  computeClassSlots,
  computePaintkitItems,
  computeReskinGroups,
  fetchItemsGame,
} from "./items-game.ts";
import { fetchLocalization, fetchPaintkitNames, localizeName } from "./localization.ts";

export { computeClassSlots, computeReskinGroups, fetchItemsGame } from "./items-game.ts";
export { fetchLocalization, localizeName } from "./localization.ts";
export { parseVdf } from "./vdf.ts";

/** Web API class numbering (class number - 1 indexes stock loadouts). */
export const CLASS_NUMBERS = {
  Scout: 1,
  Sniper: 2,
  Soldier: 3,
  Demoman: 4,
  Medic: 5,
  Heavy: 6,
  Pyro: 7,
  Spy: 8,
  Engineer: 9,
} as const;
export type ClassName = keyof typeof CLASS_NUMBERS;

const ALL_CLASS_NUMBERS = Object.values(CLASS_NUMBERS);

const schemaItemsPage = z.object({
  result: z.object({
    status: z.number(),
    items_game_url: z.string().optional(),
    items: z.array(
      z.object({
        defindex: z.number(),
        name: z.string(),
        item_name: z.string().nullish(),
        image_url: z.string().nullish(),
        item_slot: z.string().nullish(),
        used_by_classes: z.array(z.string()).nullish(),
      }),
    ),
    next: z.number().optional(),
  }),
});

/**
 * Sync the TF2 item schema into item_schema via GetSchemaItems (~30 paged
 * calls; run monthly). Equip regions + reskin groups come from items_game.txt
 * (GameTracking-TF2) in a later pass — see PLAN.md.
 */
export async function syncItemSchema(db: Db, apiKey: string): Promise<number> {
  const loc = await fetchLocalization();
  let start: number | undefined = 0;
  let count = 0;

  while (start !== undefined) {
    const url =
      "https://api.steampowered.com/IEconItems_440/GetSchemaItems/v1/" +
      `?key=${apiKey}&start=${start}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`GetSchemaItems HTTP ${res.status}`);
    const page = schemaItemsPage.parse(await res.json());

    const rows = page.result.items.map((item) => ({
      defindex: item.defindex,
      name: item.name,
      itemName: localizeName(item.item_name, loc),
      imageUrl: item.image_url ?? null,
      slot: item.item_slot ?? null,
      usedByClasses:
        item.used_by_classes
          ?.map((c) => CLASS_NUMBERS[c as ClassName])
          .filter((n): n is (typeof ALL_CLASS_NUMBERS)[number] => n !== undefined) ??
        ALL_CLASS_NUMBERS,
    }));

    if (rows.length > 0) {
      await db
        .insert(schema.itemSchema)
        .values(rows)
        .onConflictDoUpdate({
          target: schema.itemSchema.defindex,
          set: {
            name: sql`excluded.name`,
            itemName: sql`excluded.item_name`,
            imageUrl: sql`excluded.image_url`,
            slot: sql`excluded.slot`,
            usedByClasses: sql`excluded.used_by_classes`,
          },
        });
      count += rows.length;
    }
    start = page.result.next;
  }

  // second pass: functional reskin groups derived from items_game.txt
  const itemsGame = await fetchItemsGame();
  const groups = computeReskinGroups(itemsGame);
  const pairs = JSON.stringify([...groups.entries()]);
  await db.execute(sql`
    update item_schema i set reskin_group = (e -> 1)::int
    from jsonb_array_elements(${pairs}::jsonb) e
    where i.defindex = (e -> 0)::int
  `);

  // third pass: warpaint items get their paintkit name ("Killer Bee Scattergun")
  const paintkitNames = await fetchPaintkitNames();
  const paintkitItems = computePaintkitItems(itemsGame);
  const renames: [number, string][] = [];
  for (const [defindex, pkId] of paintkitItems) {
    const pkName = paintkitNames.get(pkId);
    if (pkName) renames.push([defindex, pkName]);
  }
  await db.execute(sql`
    update item_schema i set item_name = (e ->> 1) || ' ' || i.item_name
    from jsonb_array_elements(${JSON.stringify(renames)}::jsonb) e
    where i.defindex = (e -> 0)::int and i.item_name not like (e ->> 1) || ' %'
  `);

  // fourth pass: per-class slot capabilities (denominators for slot-varying items)
  const classSlots = computeClassSlots(itemsGame);
  await db.execute(sql`delete from item_class_slots`);
  await db.execute(sql`
    insert into item_class_slots (defindex, class_num, slot)
    select (e -> 0)::int, (e -> 1)::smallint, (e -> 2)::smallint
    from jsonb_array_elements(${JSON.stringify(classSlots.map((c) => [c.defindex, c.classNum, c.slot]))}::jsonb) e
    on conflict do nothing
  `);

  return count;
}
