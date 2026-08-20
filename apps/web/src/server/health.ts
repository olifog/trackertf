import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { chQuery } from "@trackertf/clickhouse";
import { sql } from "drizzle-orm";
import { getCh } from "./ch.ts";
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

/** Live-ish snapshot of one Steam API rate-budget bucket (token bucket). */
export interface BudgetSlice {
  /** rate class: crawler | scanner | sampler | web | _shared */
  cls: string;
  /** tokens available right now, with lazy refill applied since updated_at */
  tokens: number;
  /** burst ceiling */
  capacity: number;
  /** steady refill rate, tokens/sec (≈ sustained calls/sec floor) */
  refillPerSec: number;
  /** lifetime admitted-call counter */
  consumedTotal: number;
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
  /** recrawl/discovery frontier composition */
  queue: {
    total: number;
    /** oldest pending enqueue across all sources, ISO */
    oldestEnqueued: string | null;
    bySource: { source: string; count: number }[];
  };
  /** top countries in the (POP-filtered) crawled corpus, and the known total */
  countries: { code: string; count: number }[];
  countryKnown: number;
  /** TF2 playerbase size + how much of it we've crawled */
  population: {
    /** most recent global concurrent-player count from Steam, null if none yet */
    liveCcu: number | null;
    /** peak concurrent players over the last 14 days */
    peakCcu: number | null;
    /** mark-recapture estimate of distinct casual players active over 14 days
     * (Chapman estimator on sampled in-game names), null if too little data */
    estimatedCasual14d: number | null;
  };
  /** class-playtime distribution across the corpus */
  byClass: ClassSlice[];
  /** Steam API rate-budget buckets (token-bucket broker), empty if unreadable */
  budget: BudgetSlice[];
  lastAnalyserRun: string | null;
}

export const fetchHealth = createServerFn({ method: "GET" }).handler(
  async (): Promise<HealthResponse> => {
    const db = getDb();

    // Every Postgres query on this dashboard is independent — run them
    // concurrently instead of in a ~7-deep await waterfall. crawl and corpus
    // were two full scans of players (52k rows); they're merged into one pass
    // here (same table, both plain single-row aggregates). The old
    // crawl_frontier count(*) subquery is dropped too: the frontier total equals
    // the sum of the per-source counts we already fetch for the queue breakdown.
    const [api, playersAgg, queueRaw, countryRaw, classRaw, analyserRow, ccuRaw] = (await Promise.all([
      db.execute(sql`
        select endpoint, outcome, sum(count)::int count
        from api_metrics where hour > now() - interval '48 hours'
        group by endpoint, outcome order by endpoint, count desc
      `),
      // Merged crawl + corpus pass over players. country_known counts
      // POP-filtered profiles that expose a country (the country-chart base).
      db.execute(sql`
        select
          count(*)::int players,
          count(*) filter (where items_status = 'ok')::int items_ok,
          count(*) filter (where items_status = 'private')::int items_private,
          count(*) filter (where stats_status = 'ok')::int stats_ok,
          count(*) filter (where items_status = 'error')::int errors,
          count(*) filter (where last_crawled > now() - interval '1 hour')::int crawled_last_hour,
          count(*) filter (where tf2_minutes_2wk > 0)::int active,
          coalesce(sum(tf2_minutes), 0)::bigint minutes,
          count(*) filter (
            where loccountrycode is not null and personaname is not null
              and vac_banned = false and coalesce(botness, 0) < 0.5
          )::int country_known
        from players
      `),
      // Frontier composition — what's queued to crawl, by source, and how stale.
      db.execute(sql`
        select source, count(*)::int n, min(enqueued_at) oldest
        from crawl_frontier
        group by source
        order by n desc
      `),
      // Country distribution across the POP-filtered corpus (same bot/ban filter
      // the leaderboards use), top 24 by player count.
      db.execute(sql`
        select loccountrycode cc, count(*)::int n
        from players
        where loccountrycode is not null and personaname is not null
          and vac_banned = false and coalesce(botness, 0) < 0.5
        group by loccountrycode
        order by n desc
        limit 24
      `),
      // Per-class lifetime accumulators — "which classes get played".
      db.execute(sql`
        select class_num,
          coalesce(sum(playtime_seconds), 0)::bigint secs,
          coalesce(sum(kills), 0)::bigint kills,
          count(*)::int players
        from player_class_stats
        group by class_num
        order by class_num
      `),
      db.execute(sql`select max(computed_at) t from usage_stats`),
      // Playerbase: live CCU + 14d peak from population_snapshots (empty until
      // the scanner ships this).
      db.execute(sql`
        select
          (select current_players from population_snapshots
            order by scanned_at desc limit 1) as live,
          (select max(current_players)::int from population_snapshots
            where scanned_at > now() - interval '14 days') as peak
      `),
    ])) as unknown as [
      EndpointHealth[],
      [Record<string, unknown> | undefined],
      Record<string, unknown>[],
      Record<string, unknown>[],
      Record<string, unknown>[],
      [{ t: string | Date | null } | undefined],
      [Record<string, unknown> | undefined],
    ];
    const ccu = ccuRaw[0];

    const crawl = playersAgg[0] as Record<string, number> | undefined;
    const corpus = playersAgg[0];

    const bySource = queueRaw.map((r) => ({
      source: String(r["source"]),
      count: num(r["n"]),
    }));
    const frontier = bySource.reduce((a, s) => a + s.count, 0);
    const oldestEnqueued =
      queueRaw
        .map((r) => (r["oldest"] ? new Date(r["oldest"] as string | Date).toISOString() : null))
        .filter((v): v is string => v !== null)
        .toSorted()[0] ?? null;

    const countries = countryRaw.map((r) => ({
      code: String(r["cc"]),
      count: num(r["n"]),
    }));

    const byClass: ClassSlice[] = classRaw.map((r) => ({
      classNum: num(r["class_num"]),
      playtimeHours: Math.round(num(r["secs"]) / 3600),
      kills: num(r["kills"]),
      players: num(r["players"]),
    }));

    const analyser = analyserRow[0];

    // Two-sample Chapman estimator of distinct casual players active over 14d.
    // Splits observed names into two 7-day windows: n1/n2 are the distinct names
    // seen in each, m the overlap. Normalization mirrors normalizeName so a name
    // keys the same in both windows. Sampler-scoped + name-collision caveats
    // apply — this is a rough estimate, not a census.
    let estimatedCasual14d: number | null = null;
    try {
      const [rec] = await chQuery<{ n1: string; n2: string; m: string }>(
        getCh(),
        `select
          countIf(w1 > 0) as n1,
          countIf(w2 > 0) as n2,
          countIf(w1 > 0 and w2 > 0) as m
        from (
          select
            trimBoth(replaceRegexpAll(replaceRegexpAll(lowerUTF8(name),
              '[\\\\x{200B}-\\\\x{200F}\\\\x{202A}-\\\\x{202E}\\\\x{2060}\\\\x{FEFF}]', ''),
              '\\s+', ' ')) as nm,
            countIf(started_at <= now() - toIntervalDay(7)) as w1,
            countIf(started_at > now() - toIntervalDay(7)) as w2
          from match_obs
          where started_at > now() - toIntervalDay(14)
          group by nm
          having nm != ''
        )`,
      );
      const n1 = num(rec?.n1);
      const n2 = num(rec?.n2);
      const m = num(rec?.m);
      // Chapman: N̂ = (n1+1)(n2+1)/(m+1) − 1, only meaningful with overlap
      if (n1 > 0 && n2 > 0 && m > 0) {
        estimatedCasual14d = Math.round(((n1 + 1) * (n2 + 1)) / (m + 1) - 1);
      }
    } catch (err) {
      console.warn("recapture estimate failed:", err);
    }

    // Steam API budget buckets. Fail-soft: web_ro may not have SELECT on
    // steam_budget yet. tokens is recomputed with the same lazy-refill the
    // broker applies (min(capacity, tokens + refill*age)), so it reflects
    // headroom right now rather than the last-take snapshot.
    let budget: BudgetSlice[] = [];
    try {
      const rows = (await db.execute(sql`
        select class,
          least(capacity, tokens + refill_per_sec * extract(epoch from (now() - updated_at)))::double precision eff,
          capacity, refill_per_sec, consumed_total
        from steam_budget
        order by class
      `)) as unknown as Record<string, unknown>[];
      budget = rows.map((r) => ({
        cls: String(r["class"]),
        tokens: num(r["eff"]),
        capacity: num(r["capacity"]),
        refillPerSec: num(r["refill_per_sec"]),
        consumedTotal: num(r["consumed_total"]),
      }));
    } catch (err) {
      console.warn("budget read failed:", err);
    }

    return {
      api,
      crawl: {
        players: crawl?.["players"] ?? 0,
        itemsOk: crawl?.["items_ok"] ?? 0,
        itemsPrivate: crawl?.["items_private"] ?? 0,
        statsOk: crawl?.["stats_ok"] ?? 0,
        errors: crawl?.["errors"] ?? 0,
        frontier,
        crawledLastHour: crawl?.["crawled_last_hour"] ?? 0,
      },
      corpus: {
        playersTracked: num(corpus?.["total"]),
        activePlayers2wk: num(corpus?.["active"]),
        totalTrackedHours: Math.round(num(corpus?.["minutes"]) / 60),
      },
      queue: {
        total: frontier,
        oldestEnqueued,
        bySource,
      },
      countries,
      countryKnown: num(corpus?.["country_known"]),
      population: {
        liveCcu: ccu?.["live"] == null ? null : num(ccu["live"]),
        peakCcu: ccu?.["peak"] == null ? null : num(ccu["peak"]),
        estimatedCasual14d,
      },
      byClass,
      budget,
      lastAnalyserRun: analyser?.t ? new Date(analyser.t).toISOString() : null,
    };
  },
);

export const healthQueryOptions = () =>
  queryOptions({ queryKey: ["health"], queryFn: () => fetchHealth() });
