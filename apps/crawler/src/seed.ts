/** Seed the crawl frontier: `bun run seed <steamid> [steamid...]` */
import { createDbFromEnv, schema } from "@trackertf/db";

const steamids = process.argv.slice(2).filter((s) => /^\d{17}$/.test(s));
if (steamids.length === 0) {
  console.error("usage: bun run seed <steamid64> [steamid64...]");
  process.exit(1);
}

const db = createDbFromEnv();
await db
  .insert(schema.crawlFrontier)
  .values(steamids.map((steamid) => ({ steamid, source: "seed" as const, priority: 10 })))
  .onConflictDoNothing();

console.log(`seeded ${steamids.length} steamids`);
process.exit(0);
