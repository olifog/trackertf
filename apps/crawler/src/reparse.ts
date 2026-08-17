/** Rebuild equipped_items from stored raw payloads (no recrawl needed).
 * Run after parse.ts semantics change: `bun run src/reparse.ts` */
import { createDbFromEnv, schema } from "@trackertf/db";
import type { BackpackItem } from "@trackertf/steam";
import { eq, sql } from "drizzle-orm";
import { parseEquipped } from "./parse.ts";

const db = createDbFromEnv();
let done = 0;

const players = await db
  .select({ steamid: schema.playerItemsRaw.steamid, payload: schema.playerItemsRaw.payload })
  .from(schema.playerItemsRaw);

for (const p of players) {
  const equipped = parseEquipped(p.payload as BackpackItem[]).map((row) => ({
    steamid: p.steamid,
    ...row,
  }));
  await db.transaction(async (tx) => {
    await tx.delete(schema.equippedItems).where(eq(schema.equippedItems.steamid, p.steamid));
    if (equipped.length > 0)
      await tx.insert(schema.equippedItems).values(equipped).onConflictDoNothing();
  });
  done++;
  if (done % 200 === 0) console.log(`${done}/${players.length}`);
}

await db.execute(sql`analyze equipped_items`);
console.log(`reparsed ${done} players`);
process.exit(0);
