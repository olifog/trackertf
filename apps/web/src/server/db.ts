import { createDbFromEnv, type Db } from "@trackertf/db";

let db: Db | undefined;
export function getDb(): Db {
  db ??= createDbFromEnv();
  return db;
}
