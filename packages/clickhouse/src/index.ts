import { type ClickHouseClient, createClient } from "@clickhouse/client";

export type Ch = ClickHouseClient;
export { CH_SCHEMA, applySchema } from "./schema.ts";

/**
 * Build a ClickHouse client from a single `CLICKHOUSE_URL` of the form
 * `http[s]://user:password@host:port/database`, or from discrete
 * `CLICKHOUSE_{HOST,USER,PASSWORD,DB}` env vars. Internal callers (crawler/
 * syncer) use plaintext HTTP (8123) over the docker network; Vercel connects
 * over HTTPS (8443) and pins the server's self-signed cert via
 * `CLICKHOUSE_CA_CERT` (PEM) so TLS verifies without a public CA.
 */
export function createChFromEnv(): Ch {
  const caCert = process.env["CLICKHOUSE_CA_CERT"];
  const tls = caCert ? { tls: { ca_cert: Buffer.from(caCert) } } : {};
  const url = process.env["CLICKHOUSE_URL"];
  if (url) {
    const u = new URL(url);
    const database = u.pathname.replace(/^\//, "") || "default";
    const username = decodeURIComponent(u.username) || "default";
    const password = decodeURIComponent(u.password) || "";
    u.username = "";
    u.password = "";
    u.pathname = "";
    return createClient({ url: u.toString(), username, password, database, ...tls });
  }
  const host = process.env["CLICKHOUSE_HOST"] ?? "localhost";
  const port = process.env["CLICKHOUSE_PORT"] ?? "8123";
  return createClient({
    url: `http://${host}:${port}`,
    username: process.env["CLICKHOUSE_USER"] ?? "default",
    password: process.env["CLICKHOUSE_PASSWORD"] ?? "",
    database: process.env["CLICKHOUSE_DB"] ?? "trackertf",
    ...tls,
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
