/**
 * Generic leaderboard engine: every board is a (metric, scope, kind) cell of a
 * programmatic grid over player_class_stats, plus the tf2_minutes hours board.
 * Board keys look like "kills:overall:total" or "points_scored:5:per_hour".
 *
 * Shared by the crawler's analyser (precompute into leaderboard_entries) and
 * the web app (picker labels, live-fallback queries, player rank queries), so
 * this module stays dependency-free.
 */

export const METRICS = [
  "playtime",
  "kills",
  "kill_assists",
  "damage_dealt",
  "points_scored",
  "dominations",
  "captures",
  "defenses",
] as const;
export type Metric = (typeof METRICS)[number];

/** player_class_stats column per metric */
export const METRIC_COLUMNS: Record<Metric, string> = {
  playtime: "playtime_seconds",
  kills: "kills",
  kill_assists: "kill_assists",
  damage_dealt: "damage_dealt",
  points_scored: "points_scored",
  dominations: "dominations",
  captures: "captures",
  defenses: "defenses",
};

const METRIC_LABELS: Record<Metric, string> = {
  playtime: "hours played",
  kills: "kills",
  kill_assists: "kill assists",
  damage_dealt: "damage dealt",
  points_scored: "points scored",
  dominations: "dominations",
  captures: "captures",
  defenses: "defenses",
};

/** Web API class numbering — duplicated from the web app's tf2.ts on purpose. */
export const CLASS_NAMES: Record<number, string> = {
  1: "Scout",
  2: "Sniper",
  3: "Soldier",
  4: "Demoman",
  5: "Medic",
  6: "Heavy",
  7: "Pyro",
  8: "Spy",
  9: "Engineer",
};

/** playtime-on-scope thresholds rate boards are precomputed at */
export const RATE_THRESHOLD_HOURS = [10, 50, 150, 500] as const;
export const DEFAULT_RATE_HOURS = 50;

export type BoardScope = "overall" | number;
export type BoardKind = "total" | "per_hour";

export interface BoardDef {
  key: string;
  /** "hours" is the special tf2_minutes board */
  metric: Metric | "hours";
  scope: BoardScope;
  kind: BoardKind;
  label: string;
  /** scope-free label for pickers that filter by class separately */
  shortLabel: string;
  /** short label for the value column header */
  valueLabel: string;
  /** display precision for values */
  decimals: number;
  /** rate boards only: min playtime_seconds on the scope to qualify */
  minRateSeconds?: number;
  /** rate boards only: minRateSeconds in hours (key suffix / labels) */
  minRateHours?: number;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function rateDecimals(metric: Metric): number {
  if (metric === "damage_dealt") return 0;
  if (metric === "dominations" || metric === "captures" || metric === "defenses") return 2;
  return 1;
}

function makeBoards(): BoardDef[] {
  const boards: BoardDef[] = [
    {
      key: "hours",
      metric: "hours",
      scope: "overall",
      kind: "total",
      label: "Most TF2 hours",
      shortLabel: "Most TF2 hours",
      valueLabel: "Hours",
      decimals: 0,
    },
  ];
  const scopes: BoardScope[] = ["overall", 1, 2, 3, 4, 5, 6, 7, 8, 9];
  for (const scope of scopes) {
    const where = scope === "overall" ? "all classes" : (CLASS_NAMES[scope] as string);
    for (const metric of METRICS) {
      boards.push({
        key: `${metric}:${scope}:total`,
        metric,
        scope,
        kind: "total",
        label: `Most ${METRIC_LABELS[metric]} (${where})`,
        shortLabel: `Most ${METRIC_LABELS[metric]}`,
        valueLabel: capitalize(METRIC_LABELS[metric]),
        decimals: 0,
      });
      // playtime per hour is identically 1 — skip it
      if (metric === "playtime") continue;
      for (const hours of RATE_THRESHOLD_HOURS) {
        boards.push({
          key: `${metric}:${scope}:per_hour:${hours}h`,
          metric,
          scope,
          kind: "per_hour",
          label: `${capitalize(METRIC_LABELS[metric])} per hour (${where}, ${hours}h+)`,
          shortLabel: `${capitalize(METRIC_LABELS[metric])} per hour`,
          valueLabel: `${capitalize(METRIC_LABELS[metric])} / hr`,
          decimals: rateDecimals(metric),
          minRateSeconds: hours * 3600,
          minRateHours: hours,
        });
      }
    }
  }
  return boards;
}

export const BOARDS: readonly BoardDef[] = makeBoards();
export const BOARD_MAP: ReadonlyMap<string, BoardDef> = new Map(BOARDS.map((b) => [b.key, b]));

/** shared population filter: public persona, no VAC ban, not a scored bot/outlier
 * (botness >= 0.5, see docs/botness-signals.md; NULL = unscored = included) */
const POP =
  "p.personaname is not null and p.vac_banned = false and coalesce(p.botness, 0) < 0.5";

/**
 * Full SELECT (steamid, value) for one board, ordered best-first with a
 * deterministic steamid tie-break. All fragments come from the static defs
 * above, so the text is safe to inline with sql.raw.
 */
export function boardSelectSql(def: BoardDef, limit: number): string {
  if (def.metric === "hours") {
    return `
      select p.steamid, (p.tf2_minutes / 60.0)::real as value
      from players p
      where p.tf2_minutes is not null and ${POP}
      order by value desc, p.steamid
      limit ${limit}`;
  }
  const col = METRIC_COLUMNS[def.metric];
  // playtime totals are reported in hours
  const div = def.metric === "playtime" ? " / 3600.0" : "";
  const from = "from player_class_stats c join players p using (steamid)";
  const minSeconds = def.minRateSeconds ?? 0;
  if (def.scope === "overall") {
    if (def.kind === "total") {
      return `
        select c.steamid, (sum(c.${col})${div})::real as value
        ${from}
        where ${POP}
        group by c.steamid
        order by value desc, c.steamid
        limit ${limit}`;
    }
    return `
      select c.steamid, (sum(c.${col}) * 3600.0 / sum(c.playtime_seconds))::real as value
      ${from}
      where ${POP}
      group by c.steamid
      having sum(c.playtime_seconds) >= ${minSeconds}
      order by value desc, c.steamid
      limit ${limit}`;
  }
  if (def.kind === "total") {
    return `
      select c.steamid, (c.${col}${div})::real as value
      ${from}
      where c.class_num = ${def.scope} and ${POP}
      order by value desc, c.steamid
      limit ${limit}`;
  }
  return `
    select c.steamid, (c.${col} * 3600.0 / c.playtime_seconds)::real as value
    ${from}
    where c.class_num = ${def.scope} and c.playtime_seconds >= ${minSeconds} and ${POP}
    order by value desc, c.steamid
    limit ${limit}`;
}

/**
 * Participant count for one board (percentile denominator). Identical for all
 * metrics sharing a (scope, kind, threshold) cell, so callers can cache on the
 * returned SQL text.
 */
export function boardCountSql(def: BoardDef): string {
  if (def.metric === "hours") {
    return `
      select count(*)::int as n from players p
      where p.tf2_minutes is not null and ${POP}`;
  }
  const from = "from player_class_stats c join players p using (steamid)";
  const minSeconds = def.minRateSeconds ?? 0;
  if (def.scope === "overall") {
    if (def.kind === "total") {
      return `select count(distinct c.steamid)::int as n ${from} where ${POP}`;
    }
    return `
      select count(*)::int as n from (
        select c.steamid ${from} where ${POP}
        group by c.steamid
        having sum(c.playtime_seconds) >= ${minSeconds}
      ) q`;
  }
  const rate = def.kind === "per_hour" ? ` and c.playtime_seconds >= ${minSeconds}` : "";
  return `select count(*)::int as n ${from} where c.class_num = ${def.scope}${rate} and ${POP}`;
}

/**
 * Player ranks are PRECOMPUTED by the analyser into two derived tables, and the
 * web app reads them with a single indexed lookup per player page:
 *
 *   rank_pop  — one row per (player, scope): the player's value on every metric
 *               plus their rank() on every board cell. scope 0 = overall,
 *               scope 1..9 = class, scope -1 = the tf2_minutes hours board
 *               (its `playtime` column holds tf2_minutes*60 so value/3600 =
 *               hours; only rt_playtime is meaningful there).
 *   rank_meta — one row per scope: total participants (p_total) and per-hour
 *               board participant counts (ph_<N>h).
 *
 * History: v1 exploded population×board rows + rank() per request (~22s), v2
 * counted betters per scope in one hash aggregate per request (~1s at launch,
 * but linear in corpus — at 580k player_class_stats rows it hit 3.5-6.5s with
 * disk spills, and stacked bot traffic pinned RDS at 99% CPU for two days).
 * Ranking the whole population is inherently O(corpus), so it now happens ONCE
 * per analyser pass (recomputeRankPop) instead of once per page view.
 */

/**
 * SELECT materialized into rank_pop by the analyser (via CREATE TABLE ... AS).
 * ~36 window ranks over ~one row per (player, scope); heavy, offline-only.
 * rank() tie semantics = 1 + players strictly ahead, matching the old live
 * per-request counts. Per-hour ranks are NULL below their playtime threshold
 * (the player isn't on that board).
 */
export function rankPopSelectSql(): string {
  const aggs = METRICS.map((m) => `sum(${METRIC_COLUMNS[m]})::bigint as ${m}`).join(", ");
  const cols = METRICS.map((m) => `${METRIC_COLUMNS[m]}::bigint as ${m}`).join(", ");
  const zeros = METRICS.filter((m) => m !== "playtime")
    .map((m) => `0::bigint as ${m}`)
    .join(", ");
  const rt = METRICS.map(
    (m) => `rank() over (partition by scope order by ${m} desc)::int as rt_${m}`,
  ).join(",\n        ");
  const rateCtes = RATE_THRESHOLD_HOURS.map((h) => {
    const ranks = METRICS.filter((m) => m !== "playtime")
      .map(
        (m) =>
          `rank() over (partition by scope order by ${m} * 3600.0 / nullif(playtime, 0) desc)::int as rh_${m}_${h}h`,
      )
      .join(",\n          ");
    return `h${h} as (
        select steamid, scope,
          ${ranks}
        from scoped where scope >= 0 and playtime >= ${h * 3600}
      )`;
  }).join(",\n      ");
  const rateCols = RATE_THRESHOLD_HOURS.map((h) =>
    METRICS.filter((m) => m !== "playtime")
      .map((m) => `h${h}.rh_${m}_${h}h`)
      .join(", "),
  ).join(",\n        ");
  const rateJoins = RATE_THRESHOLD_HOURS.map((h) => `left join h${h} using (steamid, scope)`).join(
    "\n        ",
  );
  return `
    with pop as (
      select c.* from player_class_stats c join players p using (steamid)
      where ${POP}
    ),
    scoped as (
      select steamid, 0 as scope, ${aggs} from pop group by steamid
      union all
      select steamid, class_num as scope, ${cols} from pop
      union all
      select p.steamid, -1 as scope, (p.tf2_minutes::bigint * 60) as playtime, ${zeros}
      from players p
      where p.tf2_minutes is not null and ${POP}
    ),
    base as (
      select *,
        ${rt}
      from scoped
    ),
      ${rateCtes}
    select base.*,
        ${rateCols}
    from base
        ${rateJoins}`;
}

/**
 * SELECT materialized into rank_meta from a freshly built rank_pop staging
 * table: per-scope participant counts (percentile denominators).
 */
export function rankMetaSelectSql(fromTable: string): string {
  const phs = RATE_THRESHOLD_HOURS.map(
    (h) => `count(*) filter (where playtime >= ${h * 3600})::int as ph_${h}h`,
  ).join(", ");
  return `select scope, count(*)::int as p_total, ${phs} from ${fromTable} group by scope`;
}

/**
 * Per-player lookup over rank_pop ⋈ rank_meta (filter by steamid as a bind
 * param outside). Aliases the value columns to me_<metric> to keep the web
 * un-pivot loop's row shape.
 */
export function rankLookupSql(): string {
  const me = METRICS.map((m) => `s.${m} as me_${m}`).join(", ");
  const rt = METRICS.map((m) => `s.rt_${m}`).join(", ");
  const rh = METRICS.filter((m) => m !== "playtime")
    .flatMap((m) => RATE_THRESHOLD_HOURS.map((h) => `s.rh_${m}_${h}h`))
    .join(", ");
  const ph = RATE_THRESHOLD_HOURS.map((h) => `m.ph_${h}h`).join(", ");
  return `
    select s.scope, ${me},
      ${rt},
      ${rh},
      m.p_total, ${ph}
    from rank_pop s
    join rank_meta m using (scope)`;
}
