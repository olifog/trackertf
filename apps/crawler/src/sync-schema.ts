/** One-shot TF2 item schema sync: `bun run sync-schema` */
import { createDbFromEnv } from "@trackertf/db";
import { syncItemSchema } from "@trackertf/tf2-schema";

const apiKey = process.env["STEAM_API_KEY"];
if (!apiKey) throw new Error("STEAM_API_KEY is not set");

const count = await syncItemSchema(createDbFromEnv(), apiKey);
console.log(`synced ${count} schema items`);
process.exit(0);
