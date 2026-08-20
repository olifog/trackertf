import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, stripSearchParams, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { FilterRow, Segmented } from "#/components/ui/filter-bar";
import { Slider } from "#/components/ui/slider";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "#/components/ui/table";
import {
  BOARD_MAP,
  BOARDS,
  type BoardDef,
  type BoardScope,
  DEFAULT_RATE_HOURS,
  RATE_THRESHOLD_HOURS,
} from "@trackertf/db/boards";
import { avatarUrl, CLASS_NAMES } from "#/lib/tf2";
import { isStrangeBoard, leaderboardQueryOptions, STRANGE_BOARD_KEYS } from "#/server/leaderboards";

/**
 * Strange-kill boards aren't part of the (metric, scope, kind) grid in
 * boards.ts (their data lives only in ClickHouse), so their picker metadata is
 * defined here as overall-scope, total-kind pseudo-boards.
 */
const STRANGE_BOARDS: BoardDef[] = [
  {
    key: STRANGE_BOARD_KEYS[0],
    metric: "hours",
    scope: "overall",
    kind: "total",
    label: "Most Strange kills (all equipped Strange weapons)",
    shortLabel: "Strange kills",
    valueLabel: "Strange kills",
    decimals: 0,
  },
  {
    key: STRANGE_BOARD_KEYS[1],
    metric: "hours",
    scope: "overall",
    kind: "total",
    label: "Highest single Strange counter",
    shortLabel: "Top Strange item",
    valueLabel: "Kills on item",
    decimals: 0,
  },
  {
    key: STRANGE_BOARD_KEYS[2],
    metric: "hours",
    scope: "overall",
    kind: "total",
    label: "Most Hale's Own weapons (equipped Stranges past 25,000 kills)",
    shortLabel: "Hale's Own",
    valueLabel: "Hale's Own items",
    decimals: 0,
  },
];
const STRANGE_MAP = new Map(STRANGE_BOARDS.map((b) => [b.key, b]));

/** unified lookup: normal grid boards plus the CH-backed strange boards */
function boardDef(key: string): BoardDef {
  return (STRANGE_MAP.get(key) ?? BOARD_MAP.get(key)) as BoardDef;
}

const isKnownBoard = (key: string) => BOARD_MAP.has(key) || isStrangeBoard(key);

const searchSchema = z.object({
  board: z.string().refine(isKnownBoard).catch("hours").default("hours"),
});

export const Route = createFileRoute("/leaderboards")({
  validateSearch: searchSchema,
  search: { middlewares: [stripSearchParams({ board: "hours" })] },
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) =>
    context.queryClient.ensureQueryData(leaderboardQueryOptions(deps.board)),
  component: LeaderboardsPage,
});

/** usage-page class order (game HUD order) */
const CLASS_FILTER = [
  { num: 1, label: "Scout" },
  { num: 3, label: "Soldier" },
  { num: 7, label: "Pyro" },
  { num: 4, label: "Demoman" },
  { num: 6, label: "Heavy" },
  { num: 9, label: "Engineer" },
  { num: 5, label: "Medic" },
  { num: 2, label: "Sniper" },
  { num: 8, label: "Spy" },
] as const;

/** the equivalent board key under a different class scope / rate threshold */
function boardKeyFor(def: BoardDef, scope: BoardScope, hours: number): string {
  if (def.metric === "hours") {
    return scope === "overall" ? "hours" : `playtime:${scope}:total`;
  }
  return def.kind === "per_hour"
    ? `${def.metric}:${scope}:per_hour:${hours}h`
    : `${def.metric}:${scope}:total`;
}

/** Top-level board buckets: the picker is two levels — pick a bucket, then a
 * metric within it. "strange" is the overall-only CH-backed group. */
type BoardBucket = "total" | "per_hour" | "strange";

/** The board to land on when switching to `bucket`, preserving the current
 * metric / scope / rate threshold where the target has an equivalent. Playtime
 * has no per-hour board (it's identically 1), so per-hour falls back to kills. */
function bucketDefaultKey(
  bucket: BoardBucket,
  metric: BoardDef["metric"],
  scope: BoardScope,
  hours: number,
): string {
  if (bucket === "strange") return STRANGE_BOARDS[0]!.key;
  if (bucket === "total") {
    if (metric === "hours" || metric === "playtime") {
      return scope === "overall" ? "hours" : `playtime:${scope}:total`;
    }
    return `${metric}:${scope}:total`;
  }
  const m = metric === "hours" || metric === "playtime" ? "kills" : metric;
  return `${m}:${scope}:per_hour:${hours}h`;
}

function formatValue(value: number, decimals: number): string {
  return value.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function Segment({
  children,
  active,
  board,
  title,
}: {
  children: React.ReactNode;
  active: boolean;
  board: string;
  title?: string;
}) {
  return (
    <Link
      from={Route.fullPath}
      search={(prev) => ({ ...prev, board })}
      title={title}
      className={`flex h-9 items-center px-2.5 text-[13px] leading-none transition-colors sm:h-8 ${
        active
          ? "bg-primary font-medium text-primary-foreground"
          : "bg-secondary/40 text-secondary-foreground hover:bg-accent"
      }`}
    >
      {children}
    </Link>
  );
}

/**
 * A standalone board pill. Unlike the segmented class strip, the board picker
 * has ~18 multi-word options, so these wrap onto multiple rows as individually
 * rounded pills (`whitespace-nowrap` keeps each label on one line) instead of
 * clipping in a single horizontal scroll strip.
 */
function BoardPill({
  children,
  active,
  board,
  title,
}: {
  children: React.ReactNode;
  active: boolean;
  board: string;
  title?: string;
}) {
  return (
    <Link
      from={Route.fullPath}
      search={(prev) => ({ ...prev, board })}
      title={title}
      className={`inline-flex h-8 items-center rounded-md border px-2.5 text-[13px] leading-none whitespace-nowrap transition-colors ${
        active
          ? "border-primary bg-primary font-medium text-primary-foreground"
          : "border-border bg-secondary/40 text-secondary-foreground hover:bg-accent"
      }`}
    >
      {children}
    </Link>
  );
}

/** discrete playtime-threshold slider for rate boards */
function ThresholdSlider({ def }: { def: BoardDef }) {
  const navigate = useNavigate({ from: Route.fullPath });
  const hours = def.minRateHours ?? DEFAULT_RATE_HOURS;
  const index = Math.max(
    0,
    RATE_THRESHOLD_HOURS.findIndex((h) => h === hours),
  );
  const commit = (i: number) => {
    const next = RATE_THRESHOLD_HOURS[i] ?? DEFAULT_RATE_HOURS;
    void navigate({ search: (prev) => ({ ...prev, board: boardKeyFor(def, def.scope, next) }) });
  };
  return (
    <div className="w-full max-w-72 pt-1">
      <Slider
        value={[index]}
        min={0}
        max={RATE_THRESHOLD_HOURS.length - 1}
        step={1}
        onValueCommitted={(v) => commit(Array.isArray(v) ? (v[0] ?? 0) : v)}
      />
      <div className="mt-1.5 flex justify-between">
        {RATE_THRESHOLD_HOURS.map((h, i) => (
          <button
            key={h}
            type="button"
            onClick={() => commit(i)}
            className={`cursor-pointer font-mono text-[10px] leading-none transition-colors first:text-left last:text-right ${
              i === index ? "font-semibold text-foreground" : "text-muted-foreground/70"
            }`}
          >
            {h}h+
          </button>
        ))}
      </div>
    </div>
  );
}

function LeaderboardsPage() {
  const { board } = Route.useSearch();
  const { data } = useSuspenseQuery(leaderboardQueryOptions(board));
  const { rows, participants } = data;
  const def = boardDef(board);
  const strange = isStrangeBoard(board);
  const perClass = def.scope !== "overall";
  const currentHours = def.minRateHours ?? DEFAULT_RATE_HOURS;

  // Two-level picker: the active bucket comes from the current board, and the
  // lower pills are just the metrics within it. Strange boards are overall-only.
  const bucket: BoardBucket = strange ? "strange" : def.kind;
  const lowerOptions =
    bucket === "strange"
      ? STRANGE_BOARDS
      : bucket === "per_hour"
        ? BOARDS.filter(
            (b) => b.scope === def.scope && b.kind === "per_hour" && b.minRateHours === currentHours,
          )
        : BOARDS.filter((b) => b.scope === def.scope && b.kind === "total");

  return (
    <div className="space-y-5">
      <h1 className="font-heading text-2xl font-bold">Leaderboards</h1>

      <div className="space-y-3 rounded-lg border bg-card/50 p-4">
        {!strange && (
          <FilterRow label="Class">
            <Segmented>
              <Segment
                active={def.scope === "overall"}
                board={boardKeyFor(def, "overall", currentHours)}
              >
                Overall
              </Segment>
              {CLASS_FILTER.map((c) => (
                <Segment
                  key={c.num}
                  active={def.scope === c.num}
                  board={boardKeyFor(def, c.num, currentHours)}
                  title={c.label}
                >
                  <img
                    src={`/${c.label}.svg`}
                    alt={c.label}
                    className={`h-4.5 w-4.5 ${def.scope === c.num ? "" : "opacity-80"}`}
                  />
                </Segment>
              ))}
            </Segmented>
          </FilterRow>
        )}

        <FilterRow label="Type">
          <Segmented>
            <Segment
              active={bucket === "total"}
              board={bucketDefaultKey("total", def.metric, def.scope, currentHours)}
            >
              Total
            </Segment>
            <Segment
              active={bucket === "per_hour"}
              board={bucketDefaultKey("per_hour", def.metric, def.scope, currentHours)}
            >
              Per hour
            </Segment>
            {def.scope === "overall" && (
              <Segment
                active={bucket === "strange"}
                board={bucketDefaultKey("strange", def.metric, def.scope, currentHours)}
              >
                Strange
              </Segment>
            )}
          </Segmented>
        </FilterRow>

        <FilterRow label="Board">
          <div className="flex flex-wrap gap-1.5">
            {lowerOptions.map((b) => (
              <BoardPill key={b.key} active={b.key === board} board={b.key} title={b.label}>
                {b.shortLabel}
              </BoardPill>
            ))}
          </div>
        </FilterRow>

        {bucket === "per_hour" && (
          <FilterRow label="Min hours">
            <ThresholdSlider def={def} />
            <span className="text-[11px] text-muted-foreground">
              playtime on the scope to qualify
            </span>
          </FilterRow>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        Among crawled players with public profiles, no VAC bans
        {participants !== null && <>, {participants.toLocaleString()} qualifying players</>}.
        {strange && <> Counts come from players' currently equipped Strange (quality 11) items.</>}
        {def.kind === "per_hour" && (
          <> Rate boards require {currentHours}+ hours on the scope.</>
        )}{" "}
        Sample skews connected and veteran players.
      </p>

      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-10 text-right">#</TableHead>
            <TableHead className="w-9" />
            <TableHead>Player</TableHead>
            {perClass && <TableHead className="w-24">Class</TableHead>}
            <TableHead className="w-36 text-right">{def.valueLabel}</TableHead>
            <TableHead className="w-24 text-right">Percentile</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.steamid} className="h-9">
              <TableCell className="py-1 text-right font-mono text-muted-foreground">
                {row.rank}
              </TableCell>
              <TableCell className="py-0.5">
                {avatarUrl(row.avatarHash) && (
                  <img
                    src={avatarUrl(row.avatarHash) as string}
                    alt=""
                    className="h-6 w-6 rounded-sm"
                    loading="lazy"
                  />
                )}
              </TableCell>
              <TableCell className="py-1">
                <Link
                  to="/player/$steamid"
                  params={{ steamid: row.steamid }}
                  className="hover:underline"
                >
                  {row.personaname ?? row.steamid}
                </Link>
              </TableCell>
              {perClass && (
                <TableCell className="py-1 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1.5">
                    {CLASS_NAMES[def.scope as number] && (
                      <img
                        src={`/${CLASS_NAMES[def.scope as number]}.svg`}
                        alt=""
                        className="h-3.5 w-3.5"
                      />
                    )}
                    {CLASS_NAMES[def.scope as number]}
                  </span>
                </TableCell>
              )}
              <TableCell className="py-1 text-right font-mono text-sm tabular-nums">
                {formatValue(row.value, def.decimals)}
              </TableCell>
              <TableCell className="py-1 text-right font-mono text-xs tabular-nums text-muted-foreground">
                {participants ? `top ${((100 * row.rank) / participants).toFixed(1)}%` : "-"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
