import { createServerFn } from "@tanstack/react-start";
import { schema } from "@trackertf/db";
import { and, asc, desc, eq, ilike, inArray, isNotNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "./db.ts";

export interface ItemSearchResult {
  defindex: number;
  name: string;
  itemName: string | null;
  imageUrl: string | null;
}

export interface PlayerSearchResult {
  steamid: string;
  personaname: string | null;
  avatarHash: string | null;
}

export interface GlobalSearchResponse {
  items: ItemSearchResult[];
  players: PlayerSearchResult[];
}

/** slot values that mark an item as an actual weapon (vs cosmetic/taunt/action) */
const WEAPON_SLOTS = ["primary", "secondary", "melee", "pda", "pda2", "building"];

/** escape LIKE/ILIKE wildcards so user input matches literally */
function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export const globalSearch = createServerFn({ method: "GET" })
  .validator(z.object({ query: z.string().trim().min(1).max(100) }))
  .handler(async ({ data }): Promise<GlobalSearchResponse> => {
    const db = getDb();
    const pattern = `%${escapeLike(data.query)}%`;

    const items = await db
      .select({
        defindex: schema.itemSchema.defindex,
        name: schema.itemSchema.name,
        itemName: schema.itemSchema.itemName,
        imageUrl: schema.itemSchema.imageUrl,
      })
      .from(schema.itemSchema)
      .where(or(ilike(schema.itemSchema.itemName, pattern), ilike(schema.itemSchema.name, pattern)))
      .orderBy(desc(inArray(schema.itemSchema.slot, WEAPON_SLOTS)), asc(schema.itemSchema.defindex))
      .limit(8);

    const players = await db
      .select({
        steamid: schema.players.steamid,
        personaname: schema.players.personaname,
        avatarHash: schema.players.avatarHash,
      })
      .from(schema.players)
      .where(
        /^\d{17}$/.test(data.query)
          ? eq(schema.players.steamid, data.query)
          : and(
              isNotNull(schema.players.personaname),
              // Match against the lower(personaname) gin_trgm index: a plain
              // `personaname ILIKE ...` does NOT hit it (different indexed
              // expression) and seq-scans players on every keystroke. Wrapping
              // the column in lower() lets the trigram index serve the LIKE.
              sql`lower(${schema.players.personaname}) like ${pattern.toLowerCase()}`,
            ),
      )
      .limit(5);

    return { items, players };
  });
