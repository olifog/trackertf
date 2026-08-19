/** One-shot migration runner using drizzle-orm's runtime migrator (no
 * drizzle-kit needed): `bun run src/migrate.ts`. Applies any pending migrations
 * in ./drizzle and records them in drizzle.__drizzle_migrations. */
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDbFromEnv } from "./index.ts";

const db = createDbFromEnv();
await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });
console.log("migrations applied");
process.exit(0);
