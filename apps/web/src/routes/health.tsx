import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "#/components/ui/table";
import { formatAgo } from "#/lib/tf2";
import { healthQueryOptions } from "#/server/health";

export const Route = createFileRoute("/health")({
  loader: ({ context }) => context.queryClient.ensureQueryData(healthQueryOptions()),
  component: HealthPage,
});

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-card/50 px-4 py-3">
      <div className="font-mono text-[11px] tracking-wider text-muted-foreground uppercase">
        {label}
      </div>
      <div className="mt-1 font-mono text-xl tabular-nums">{value}</div>
    </div>
  );
}

const pct = (part: number, total: number) =>
  total === 0 ? "—" : `${((part / total) * 100).toFixed(1)}%`;

function HealthPage() {
  const { data } = useSuspenseQuery(healthQueryOptions());
  const { crawl } = data;

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
      <div className="flex items-baseline justify-between">
        <h1 className="font-heading text-2xl font-bold">System health</h1>
        {data.lastAnalyserRun && (
          <p className="font-mono text-xs text-muted-foreground" suppressHydrationWarning>
            stats recomputed {formatAgo(data.lastAnalyserRun)}
          </p>
        )}
      </div>

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
                  No API metrics recorded yet — counters started with the latest crawler deploy.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <p className="text-xs text-muted-foreground">
        "Private" is data that exists but isn't visible to us (privacy settings); persistent
        GetPlayerItems 503s are counted there after 3 spaced retries, so brief Game Coordinator
        outages appear under errors instead. See{" "}
        <a href="/methodology" className="underline">
          methodology
        </a>{" "}
        for details.
      </p>
    </div>
  );
}
