import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { sql } from "drizzle-orm";
import { getDb } from "./db.ts";

const num = (v: unknown): number => (v == null ? 0 : Number(v));

export interface EndpointHealth {
  endpoint: string;
  outcome: string;
  count: number;
}

/** Per-class lifetime accumulators across the whole crawled corpus. */
export interface ClassSlice {
  classNum: number;
  playtimeHours: number;
  kills: number;
  players: number;
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
  /** crawled player corpus totals */
  corpus: {
    playersTracked: number;
    activePlayers2wk: number;
    totalTrackedHours: number;
  };
  /** class-playtime distribution across the corpus */
  byClass: ClassSlice[];
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

    // Corpus totals — the playerbase we track, active in the last 2 weeks, and
    // the summed lifetime TF2 playtime across every crawled profile.
    const [corpus] = (await db.execute(sql`
      select count(*)::int total,
        count(*) filter (where tf2_minutes_2wk > 0)::int active,
        coalesce(sum(tf2_minutes), 0)::bigint minutes
      from players
    `)) as unknown as [Record<string, unknown> | undefined];

    // Per-class lifetime accumulators — "which classes get played".
    const classRaw = (await db.execute(sql`
      select class_num,
        coalesce(sum(playtime_seconds), 0)::bigint secs,
        coalesce(sum(kills), 0)::bigint kills,
        count(*)::int players
      from player_class_stats
      group by class_num
      order by class_num
    `)) as unknown as Record<string, unknown>[];
    const byClass: ClassSlice[] = classRaw.map((r) => ({
      classNum: num(r["class_num"]),
      playtimeHours: Math.round(num(r["secs"]) / 3600),
      kills: num(r["kills"]),
      players: num(r["players"]),
    }));

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
      corpus: {
        playersTracked: num(corpus?.["total"]),
        activePlayers2wk: num(corpus?.["active"]),
        totalTrackedHours: Math.round(num(corpus?.["minutes"]) / 60),
      },
      byClass,
      lastAnalyserRun: analyser?.t ? new Date(analyser.t).toISOString() : null,
    };
  },
);

export const healthQueryOptions = () =>
  queryOptions({ queryKey: ["health"], queryFn: () => fetchHealth() });
