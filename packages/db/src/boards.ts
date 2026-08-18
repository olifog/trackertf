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

export const MIN_RATE_HOURS = 50;
export const MIN_RATE_SECONDS = MIN_RATE_HOURS * 3600;

export type BoardScope = "overall" | number;
export type BoardKind = "total" | "per_hour";

export interface BoardDef {
  key: string;
  /** "hours" is the special tf2_minutes board */
  metric: Metric | "hours";
  scope: BoardScope;
  kind: BoardKind;
  label: string;
  /** short label for the value column header */
  valueLabel: string;
  /** display precision for values */
  decimals: number;
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
        valueLabel: capitalize(METRIC_LABELS[metric]),
        decimals: 0,
      });
      // playtime per hour is identically 1 — skip it
      if (metric !== "playtime") {
        boards.push({
          key: `${metric}:${scope}:per_hour`,
          metric,
          scope,
          kind: "per_hour",
          label: `${capitalize(METRIC_LABELS[metric])} per hour (${where}, ${MIN_RATE_HOURS}h+)`,
          valueLabel: `${capitalize(METRIC_LABELS[metric])} / hr`,
          decimals: rateDecimals(metric),
        });
      }
    }
  }
  return boards;
}

export const BOARDS: readonly BoardDef[] = makeBoards();
export const BOARD_MAP: ReadonlyMap<string, BoardDef> = new Map(BOARDS.map((b) => [b.key, b]));

/** shared population filter: public persona, no VAC ban */
const POP = "p.personaname is not null and p.vac_banned = false";

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
      having sum(c.playtime_seconds) >= ${MIN_RATE_SECONDS}
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
    where c.class_num = ${def.scope} and c.playtime_seconds >= ${MIN_RATE_SECONDS} and ${POP}
    order by value desc, c.steamid
    limit ${limit}`;
}

/**
 * One query over player_class_stats producing the player's rank, participant
 * count and value on every class-stat board (rate boards restricted to the
 * 50h threshold before ranking). scope 0 = overall. The hours board needs a
 * second, players-only query — see fetchPlayerRanks in the web app.
 */
export function playerRanksSql(): string {
  const aggs = METRICS.map((m) => `sum(${METRIC_COLUMNS[m]}) as ${m}`).join(", ");
  const cols = METRICS.map((m) => `${METRIC_COLUMNS[m]} as ${m}`).join(", ");
  const entries: string[] = [];
  for (const m of METRICS) {
    const total = m === "playtime" ? "s.playtime / 3600.0" : `s.${m}::real`;
    entries.push(`('${m}', 'total', ${total})`);
    if (m !== "playtime") {
      entries.push(
        `('${m}', 'per_hour', case when s.playtime >= ${MIN_RATE_SECONDS} then s.${m} * 3600.0 / s.playtime end)`,
      );
    }
  }
  return `
    with pop as (
      select c.* from player_class_stats c join players p using (steamid)
      where ${POP}
    ),
    scoped as (
      select steamid, 0 as scope, ${aggs} from pop group by steamid
      union all
      select steamid, class_num as scope, ${cols} from pop
    ),
    ranked as (
      select s.scope, s.steamid, m.metric, m.kind, m.value::real as value,
        rank() over (partition by s.scope, m.metric, m.kind order by m.value desc)::int as rnk,
        count(*) over (partition by s.scope, m.metric, m.kind)::int as participants
      from scoped s
      cross join lateral (values ${entries.join(",\n        ")}) as m(metric, kind, value)
      where m.value is not null
    )`;
}

/**
 * Rank query for the tf2_minutes hours board (one pass over players).
 * Selects (steamid, rnk, participants, value) — filter by steamid outside.
 */
export function hoursRankSql(): string {
  return `
    select p.steamid,
      rank() over (order by p.tf2_minutes desc)::int as rnk,
      count(*) over ()::int as participants,
      (p.tf2_minutes / 60.0)::real as value
    from players p
    where p.tf2_minutes is not null and ${POP}`;
}
