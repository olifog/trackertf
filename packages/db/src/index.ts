import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.ts";

export * as schema from "./schema.ts";
export type Db = ReturnType<typeof createDb>;

export { takeSteamBudget, type SteamBudgetClass, type TakeOptions } from "./steamBudget.ts";

export function createDb(url: string) {
  const client = postgres(url, { prepare: false });
  return drizzle(client, { schema, casing: "snake_case" });
}

export function createDbFromEnv() {
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_URL is not set");
  return createDb(url);
}
