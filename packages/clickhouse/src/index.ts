import { type ClickHouseClient, createClient } from "@clickhouse/client";

export type Ch = ClickHouseClient;
export { CH_SCHEMA, applySchema } from "./schema.ts";

/**
 * Build a ClickHouse client from a single `CLICKHOUSE_URL` of the form
 * `http://user:password@host:8123/database`, or from discrete
 * `CLICKHOUSE_{HOST,USER,PASSWORD,DB}` env vars. HTTP protocol (port 8123) is
 * used everywhere — it works from Bun (crawler/syncer) and Node (Vercel fns).
 */
export function createChFromEnv(): Ch {
  const url = process.env["CLICKHOUSE_URL"];
  if (url) {
    const u = new URL(url);
    const database = u.pathname.replace(/^\//, "") || "default";
    const username = decodeURIComponent(u.username) || "default";
    const password = decodeURIComponent(u.password) || "";
    u.username = "";
    u.password = "";
    u.pathname = "";
    return createClient({ url: u.toString(), username, password, database });
  }
  const host = process.env["CLICKHOUSE_HOST"] ?? "localhost";
  const port = process.env["CLICKHOUSE_PORT"] ?? "8123";
  return createClient({
    url: `http://${host}:${port}`,
    username: process.env["CLICKHOUSE_USER"] ?? "default",
    password: process.env["CLICKHOUSE_PASSWORD"] ?? "",
    database: process.env["CLICKHOUSE_DB"] ?? "trackertf",
  });
}

/** Run a SELECT and return typed rows (JSONEachRow). */
export async function chQuery<T>(
  ch: Ch,
  query: string,
  params?: Record<string, unknown>,
): Promise<T[]> {
  const rs = await ch.query({
    query,
    format: "JSONEachRow",
    ...(params ? { query_params: params } : {}),
  });
  return rs.json<T>();
}
