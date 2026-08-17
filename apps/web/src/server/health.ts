import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { sql } from "drizzle-orm";
import { getDb } from "./db.ts";

export interface EndpointHealth {
  endpoint: string;
  outcome: string;
  count: number;
}

export interface HealthResponse {
  /** last 48h api outcome counters */
  api: EndpointHealth[];
  crawl: {
    players: number;
    itemsOk: number;
    itemsPrivate: number;
    statsOk: number;
    errors: number;
    frontier: number;
    crawledLastHour: number;
  };
  lastAnalyserRun: string | null;
}

export const fetchHealth = createServerFn({ method: "GET" }).handler(
  async (): Promise<HealthResponse> => {
    const db = getDb();
    const api = (await db.execute(sql`
      select endpoint, outcome, sum(count)::int count
      from api_metrics where hour > now() - interval '48 hours'
      group by endpoint, outcome order by endpoint, count desc
    `)) as unknown as EndpointHealth[];

    const [crawl] = (await db.execute(sql`
      select
        count(*)::int players,
        count(*) filter (where items_status = 'ok')::int items_ok,
        count(*) filter (where items_status = 'private')::int items_private,
        count(*) filter (where stats_status = 'ok')::int stats_ok,
        count(*) filter (where items_status = 'error')::int errors,
        (select count(*) from crawl_frontier)::int frontier,
        count(*) filter (where last_crawled > now() - interval '1 hour')::int crawled_last_hour
      from players
    `)) as unknown as [Record<string, number>];

    const [analyser] = (await db.execute(
      sql`select max(computed_at) t from usage_stats`,
    )) as unknown as [{ t: string | Date | null }];

    return {
      api,
      crawl: {
        players: crawl?.["players"] ?? 0,
        itemsOk: crawl?.["items_ok"] ?? 0,
        itemsPrivate: crawl?.["items_private"] ?? 0,
        statsOk: crawl?.["stats_ok"] ?? 0,
        errors: crawl?.["errors"] ?? 0,
        frontier: crawl?.["frontier"] ?? 0,
        crawledLastHour: crawl?.["crawled_last_hour"] ?? 0,
      },
      lastAnalyserRun: analyser?.t ? new Date(analyser.t).toISOString() : null,
    };
  },
);

export const healthQueryOptions = () =>
  queryOptions({ queryKey: ["health"], queryFn: () => fetchHealth() });
