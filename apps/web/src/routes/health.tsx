import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  type ChartConfig,
  ChartTooltip,
  ChartTooltipContent,
} from "#/components/ui/chart";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "#/components/ui/table";
import { countryFlag, countryName } from "#/lib/geo";
import { CLASS_NAMES, formatAgo } from "#/lib/tf2";
import { healthQueryOptions } from "#/server/health";

export const Route = createFileRoute("/health")({
  loader: ({ context }) => context.queryClient.ensureQueryData(healthQueryOptions()),
  component: DataPage,
});

const classConfig = {
  playtimeHours: { label: "Hours played", color: "var(--primary)" },
} satisfies ChartConfig;

function fmtCompact(n: number): string {
  return n.toLocaleString(undefined, { notation: "compact", maximumFractionDigits: 1 });
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border bg-card/50 px-4 py-3">
      <div className="font-mono text-[11px] tracking-wider text-muted-foreground uppercase">
        {label}
      </div>
      <div className="mt-1 font-mono text-xl tabular-nums">{value}</div>
      {sub && <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

const pct = (part: number, total: number) =>
  total === 0 ? "-" : `${((part / total) * 100).toFixed(1)}%`;

const FRONTIER_SOURCE_LABELS: Record<string, string> = {
  seed: "new players",
  recrawl: "recrawls",
  friend_bfs: "friend expansion",
};
const frontierSourceLabel = (s: string) => FRONTIER_SOURCE_LABELS[s] ?? s;

function DataPage() {
  const { data } = useSuspenseQuery(healthQueryOptions());
  const { crawl, corpus, queue, countries, countryKnown } = data;
  const maxCountry = countries[0]?.count ?? 0;

  const classBars = data.byClass
    .map((c) => ({
      class: CLASS_NAMES[c.classNum] ?? `Class ${c.classNum}`,
      playtimeHours: c.playtimeHours,
    }))
    .sort((a, b) => b.playtimeHours - a.playtimeHours);

  // per-endpoint totals + success rates from raw outcome counters
  const endpoints = new Map<string, { total: number; outcomes: Map<string, number> }>();
  for (const row of data.api) {
    const e = endpoints.get(row.endpoint) ?? { total: 0, outcomes: new Map() };
    e.total += row.count;
    e.outcomes.set(row.outcome, (e.outcomes.get(row.outcome) ?? 0) + row.count);
    endpoints.set(row.endpoint, e);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h1 className="font-heading text-2xl font-bold">Data</h1>
        {data.lastAnalyserRun && (
          <p className="font-mono text-xs text-muted-foreground" suppressHydrationWarning>
            stats recomputed {formatAgo(data.lastAnalyserRun)}
          </p>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat
          label="players tracked"
          value={fmtCompact(corpus.playersTracked)}
          sub={`${corpus.playersTracked.toLocaleString()} profiles`}
        />
        <Stat
          label="active (2wk)"
          value={fmtCompact(corpus.activePlayers2wk)}
          sub="played in the last 14 days"
        />
        <Stat
          label="tracked playtime"
          value={`${fmtCompact(corpus.totalTrackedHours)}h`}
          sub="summed across all profiles"
        />
      </div>

      <div className="rounded-lg border bg-card/50 p-4">
        <h2 className="font-heading text-lg font-semibold">Class playtime</h2>
        <p className="mb-2 text-xs text-muted-foreground">
          total lifetime hours per class across the crawled corpus
        </p>
        {classBars.length === 0 ? (
          <div className="flex h-[280px] items-center justify-center text-sm text-muted-foreground">
            No class stats crawled yet.
          </div>
        ) : (
          <ChartContainer config={classConfig} className="aspect-auto h-[280px] w-full">
            <BarChart data={classBars} layout="vertical" margin={{ left: 8, right: 16 }}>
              <CartesianGrid horizontal={false} />
              <XAxis type="number" tickLine={false} axisLine={false} tickFormatter={fmtCompact} />
              <YAxis type="category" dataKey="class" tickLine={false} axisLine={false} width={68} />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Bar dataKey="playtimeHours" fill="var(--color-playtimeHours)" radius={4} />
            </BarChart>
          </ChartContainer>
        )}
      </div>

      <div>
        <h2 className="mb-2 font-heading text-lg font-semibold">Crawl pipeline</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="players crawled" value={crawl.players.toLocaleString()} />
          <Stat label="crawled last hour" value={crawl.crawledLastHour.toLocaleString()} />
          <Stat label="frontier queue" value={crawl.frontier.toLocaleString()} />
          <Stat label="permanent errors" value={crawl.errors.toLocaleString()} />
          <Stat label="public backpacks" value={pct(crawl.itemsOk, crawl.players)} />
          <Stat label="private backpacks" value={pct(crawl.itemsPrivate, crawl.players)} />
          <Stat label="public game stats" value={pct(crawl.statsOk, crawl.players)} />
          <Stat label="loadout sample" value={crawl.itemsOk.toLocaleString()} />
        </div>
      </div>

      <div>
        <h2 className="mb-2 font-heading text-lg font-semibold">Crawl queue</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="queued total" value={queue.total.toLocaleString()} />
          <Stat
            label="oldest waiting"
            value={queue.oldestEnqueued ? formatAgo(queue.oldestEnqueued) : "—"}
            sub={queue.oldestEnqueued ? "since enqueued" : "queue empty"}
          />
          {queue.bySource.map((s) => (
            <Stat
              key={s.source}
              label={frontierSourceLabel(s.source)}
              value={s.count.toLocaleString()}
              sub={pct(s.count, queue.total)}
            />
          ))}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Dequeued by priority then age — player-requested recrawls jump ahead of the scheduler's
          own, new-player seeds ahead of both.
        </p>
      </div>

      <div className="rounded-lg border bg-card/50 p-4">
        <h2 className="font-heading text-lg font-semibold">Players by country</h2>
        <p className="mb-3 text-xs text-muted-foreground">
          Where crawled players are from — {countryKnown.toLocaleString()} profiles expose a public
          country (public, non-VAC, non-bot). Top {countries.length}.
        </p>
        {countries.length === 0 ? (
          <p className="text-sm text-muted-foreground">No country data yet.</p>
        ) : (
          <div className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
            {countries.map((c) => (
              <div key={c.code} className="flex items-center gap-2 text-sm">
                <span className="w-5 shrink-0 text-center">{countryFlag(c.code)}</span>
                <span className="w-28 shrink-0 truncate text-muted-foreground">
                  {countryName(c.code)}
                </span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-secondary/50">
                  <div
                    className="h-full rounded-full bg-primary/70"
                    style={{ width: `${maxCountry > 0 ? (c.count / maxCountry) * 100 : 0}%` }}
                  />
                </div>
                <span className="w-24 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground">
                  {c.count.toLocaleString()}
                  <span className="ml-1 text-muted-foreground/60">
                    {pct(c.count, countryKnown)}
                  </span>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <h2 className="mb-2 font-heading text-lg font-semibold">
          Steam API outcomes <span className="text-sm text-muted-foreground">(last 48h)</span>
        </h2>
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Endpoint</TableHead>
              <TableHead className="text-right">Calls</TableHead>
              <TableHead className="text-right">OK</TableHead>
              <TableHead className="text-right">Private</TableHead>
              <TableHead className="text-right">Empty</TableHead>
              <TableHead className="text-right">Errors</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {[...endpoints.entries()].map(([endpoint, e]) => {
              const ok = e.outcomes.get("ok") ?? 0;
              const priv = e.outcomes.get("private") ?? 0;
              const empty = e.outcomes.get("empty") ?? 0;
              const errors = [...e.outcomes.entries()]
                .filter(([k]) => k.startsWith("error") || k === "not_found")
                .reduce((a, [, v]) => a + v, 0);
              return (
                <TableRow key={endpoint} className="h-9">
                  <TableCell className="py-1 font-mono text-xs">{endpoint}</TableCell>
                  <TableCell className="py-1 text-right font-mono text-xs tabular-nums">
                    {e.total.toLocaleString()}
                  </TableCell>
                  <TableCell className="py-1 text-right font-mono text-xs tabular-nums">
                    {pct(ok, e.total)}
                  </TableCell>
                  <TableCell className="py-1 text-right font-mono text-xs tabular-nums text-muted-foreground">
                    {pct(priv, e.total)}
                  </TableCell>
                  <TableCell className="py-1 text-right font-mono text-xs tabular-nums text-muted-foreground">
                    {pct(empty, e.total)}
                  </TableCell>
                  <TableCell
                    className={`py-1 text-right font-mono text-xs tabular-nums ${errors > 0 ? "text-destructive" : "text-muted-foreground"}`}
                  >
                    {pct(errors, e.total)}
                  </TableCell>
                </TableRow>
              );
            })}
            {endpoints.size === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="py-4 text-center text-muted-foreground">
                  No API metrics recorded yet. Counters started with the latest crawler deploy.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <p className="text-xs text-muted-foreground">
        "Private" is data that exists but isn't visible to us (privacy settings). Persistent
        GetPlayerItems 503s are counted there after 3 spaced retries, so brief Game Coordinator
        outages appear under errors instead.
      </p>
    </div>
  );
}
