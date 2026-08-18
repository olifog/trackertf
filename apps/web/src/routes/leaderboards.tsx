import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, stripSearchParams, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
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
import { leaderboardQueryOptions } from "#/server/leaderboards";

const searchSchema = z.object({
  board: z
    .string()
    .refine((key) => BOARD_MAP.has(key))
    .catch("hours")
    .default("hours"),
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

function formatValue(value: number, decimals: number): string {
  return value.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function Segmented({ children }: { children: React.ReactNode }) {
  return (
    <div className="inline-flex overflow-hidden rounded-md border divide-x divide-border">
      {children}
    </div>
  );
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
      search={{ board }}
      title={title}
      className={`flex h-8 items-center px-2.5 text-[13px] leading-none transition-colors ${
        active
          ? "bg-primary font-medium text-primary-foreground"
          : "bg-secondary/40 text-secondary-foreground hover:bg-accent"
      }`}
    >
      {children}
    </Link>
  );
}

function FilterRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-16 shrink-0 text-right font-mono text-[11px] tracking-wider text-muted-foreground uppercase">
        {label}
      </span>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5">{children}</div>
    </div>
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
    void navigate({ search: { board: boardKeyFor(def, def.scope, next) } });
  };
  return (
    <div className="w-56 pt-1">
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
  const navigate = useNavigate({ from: Route.fullPath });
  const { data } = useSuspenseQuery(leaderboardQueryOptions(board));
  const { rows, participants } = data;
  const def = BOARD_MAP.get(board) as BoardDef;
  const perClass = def.scope !== "overall";
  const currentHours = def.minRateHours ?? DEFAULT_RATE_HOURS;

  // one select entry per (metric, kind) of the active scope — rate boards
  // surface at the currently selected threshold, the slider swaps variants
  const options = BOARDS.filter(
    (b) => b.scope === def.scope && (b.kind === "total" || b.minRateHours === currentHours),
  );

  return (
    <div className="space-y-5">
      <h1 className="font-heading text-2xl font-bold">Leaderboards</h1>

      <div className="space-y-3 rounded-lg border bg-card/50 p-4">
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

        <FilterRow label="Board">
          <select
            value={board}
            onChange={(e) => void navigate({ search: { board: e.target.value } })}
            className="h-8 max-w-full rounded-md border bg-secondary/40 px-2 text-[13px] text-secondary-foreground"
          >
            {options.map((b) => (
              <option key={b.key} value={b.key}>
                {b.shortLabel}
              </option>
            ))}
          </select>
        </FilterRow>

        {def.kind === "per_hour" && (
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
        {participants !== null && <> — {participants.toLocaleString()} qualifying players</>}.
        {def.kind === "per_hour" && <> Rate boards require {currentHours}+ hours on the scope.</>}{" "}
        The sample skews connected/veteran players — see{" "}
        <a href="/methodology" className="underline">
          methodology
        </a>
        .
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
                {participants ? `top ${((100 * row.rank) / participants).toFixed(1)}%` : "—"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
