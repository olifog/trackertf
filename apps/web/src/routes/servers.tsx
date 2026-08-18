import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, stripSearchParams } from "@tanstack/react-router";
import { z } from "zod";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "#/components/ui/table";
import { formatAgo } from "#/lib/tf2";
import {
  serverOverviewQueryOptions,
  serverTrendQueryOptions,
  type TrendPoint,
  type TrendRange,
  trendRangeSchema,
} from "#/server/servers";

const DEFAULT_SEARCH = { range: "24h" } as const;

const searchSchema = z.object({
  range: trendRangeSchema.catch("24h").default("24h"),
});

export const Route = createFileRoute("/servers")({
  validateSearch: searchSchema,
  search: { middlewares: [stripSearchParams(DEFAULT_SEARCH)] },
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) =>
    Promise.all([
      context.queryClient.ensureQueryData(serverOverviewQueryOptions()),
      context.queryClient.ensureQueryData(serverTrendQueryOptions(deps.range)),
    ]),
  component: ServersPage,
});

/**
 * Steam master-server region codes (approximate — GetServerList reports the
 * master-list region, not a geolocated one). 255 = "rest of the world" / SDR
 * servers with no region. Unknown codes render with their raw number.
 */
const REGION_NAMES: Record<number, string> = {
  0: "US East",
  1: "US West",
  2: "South America",
  3: "Europe",
  4: "Asia",
  5: "Australia",
  6: "Middle East",
  7: "Africa",
  255: "World / SDR",
};

function regionLabel(code: number): string {
  // ClickHouse stores region as Int8, so 255 can arrive as -1; treat both as World.
  if (code === 255 || code < 0) return "World / SDR";
  return REGION_NAMES[code] ?? `Region ${code}`;
}

function displayMap(map: string): string {
  return map || "(unknown)";
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
  range,
}: {
  children: React.ReactNode;
  active: boolean;
  range: TrendRange;
}) {
  return (
    <Link
      from={Route.fullPath}
      search={{ range }}
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

/** compact two-line SVG sparkline: total players (primary) + official (chart-2) */
function Sparkline({ points, range }: { points: TrendPoint[]; range: TrendRange }) {
  const W = 720;
  const H = 120;
  const PAD = 4;
  if (points.length < 2) {
    return (
      <div className="flex h-[120px] items-center justify-center text-sm text-muted-foreground">
        Not enough history yet. The scanner records a point every 5 minutes.
      </div>
    );
  }
  const max = Math.max(1, ...points.map((p) => p.players));
  const t0 = points[0]?.t ?? 0;
  const t1 = points[points.length - 1]?.t ?? t0 + 1;
  const span = Math.max(1, t1 - t0);
  const x = (t: number) => PAD + ((t - t0) / span) * (W - 2 * PAD);
  const y = (v: number) => PAD + (1 - v / max) * (H - 2 * PAD);
  const line = (key: keyof TrendPoint) =>
    points.map((p) => `${x(p.t).toFixed(1)},${y(p[key] as number).toFixed(1)}`).join(" ");
  const area = `${x(t0).toFixed(1)},${(H - PAD).toFixed(1)} ${line("players")} ${x(t1).toFixed(1)},${(H - PAD).toFixed(1)}`;
  const current = points[points.length - 1];

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="h-[120px] w-full"
        role="img"
        aria-label={`Player count over the last ${range === "24h" ? "24 hours" : "7 days"}`}
      >
        <polygon points={area} className="fill-primary/10" />
        <polyline
          points={line("players")}
          fill="none"
          className="stroke-primary"
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
        />
        <polyline
          points={line("official")}
          fill="none"
          className="stroke-chart-2"
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className="mt-1 flex justify-between font-mono text-[11px] text-muted-foreground">
        <span>{fmtTick(t0, range)}</span>
        <span className="text-foreground">
          peak {max.toLocaleString()} · now {(current?.players ?? 0).toLocaleString()}
        </span>
        <span>{fmtTick(t1, range)}</span>
      </div>
    </div>
  );
}

function fmtTick(unixSec: number, range: TrendRange): string {
  const d = new Date(unixSec * 1000);
  return range === "24h"
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function ServersPage() {
  const search = Route.useSearch();
  const { data: overview } = useSuspenseQuery(serverOverviewQueryOptions());
  const { data: trend } = useSuspenseQuery(serverTrendQueryOptions(search.range));
  const { totals, byRegion, byMap } = overview;
  const communityPlayers = Math.max(0, totals.players - totals.officialPlayers);
  const communityServers = Math.max(0, totals.servers - totals.officialServers);

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <h1 className="font-heading text-2xl font-bold">Servers</h1>
        {overview.scannedAt && (
          <p className="font-mono text-xs text-muted-foreground" suppressHydrationWarning>
            scanned {formatAgo(overview.scannedAt)}
          </p>
        )}
      </div>

      {overview.scannedAt === null ? (
        <p className="text-muted-foreground">
          No scans recorded yet. The scanner samples GetServerList every 5 minutes.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat
              label="players online"
              value={totals.players.toLocaleString()}
              sub={`${totals.bots.toLocaleString()} bots`}
            />
            <Stat
              label="official players"
              value={totals.officialPlayers.toLocaleString()}
              sub="Valve casual / MvM"
            />
            <Stat
              label="community players"
              value={communityPlayers.toLocaleString()}
              sub="everything else"
            />
            <Stat
              label="servers with players"
              value={totals.servers.toLocaleString()}
              sub={`${totals.officialServers.toLocaleString()} official · ${communityServers.toLocaleString()} community`}
            />
          </div>

          <div className="space-y-3 rounded-lg border bg-card/50 p-4">
            <div className="flex items-center justify-between">
              <h2 className="font-heading text-lg font-semibold">Players over time</h2>
              <Segmented>
                <Segment active={search.range === "24h"} range="24h">
                  24h
                </Segment>
                <Segment active={search.range === "7d"} range="7d">
                  7d
                </Segment>
              </Segmented>
            </div>
            <Sparkline points={trend} range={search.range} />
            <div className="flex gap-4 font-mono text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <span className="h-0.5 w-4 bg-primary" /> total
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-0.5 w-4 bg-chart-2" /> official
              </span>
            </div>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <div>
              <h2 className="mb-2 font-heading text-lg font-semibold">By region</h2>
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Region</TableHead>
                    <TableHead className="text-right">Players</TableHead>
                    <TableHead className="text-right">Official</TableHead>
                    <TableHead className="text-right">Servers</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {byRegion.map((r) => (
                    <TableRow key={r.region} className="h-9">
                      <TableCell className="py-1">{regionLabel(r.region)}</TableCell>
                      <TableCell className="py-1 text-right font-mono text-sm tabular-nums">
                        {r.players.toLocaleString()}
                      </TableCell>
                      <TableCell className="py-1 text-right font-mono text-xs tabular-nums text-muted-foreground">
                        {r.officialPlayers.toLocaleString()}
                      </TableCell>
                      <TableCell className="py-1 text-right font-mono text-xs tabular-nums text-muted-foreground">
                        {r.servers.toLocaleString()}
                      </TableCell>
                    </TableRow>
                  ))}
                  {byRegion.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={4} className="py-4 text-center text-muted-foreground">
                        No region data in the latest scan.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>

            <div>
              <h2 className="mb-2 font-heading text-lg font-semibold">
                Top maps <span className="text-sm text-muted-foreground">(by players)</span>
              </h2>
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-10 text-right">#</TableHead>
                    <TableHead>Map</TableHead>
                    <TableHead className="text-right">Players</TableHead>
                    <TableHead className="text-right">Official</TableHead>
                    <TableHead className="text-right">Servers</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {byMap.map((m, i) => (
                    <TableRow key={m.map} className="h-9">
                      <TableCell className="py-1 text-right font-mono text-muted-foreground">
                        {i + 1}
                      </TableCell>
                      <TableCell className="overflow-hidden py-1 font-mono text-xs text-ellipsis">
                        {displayMap(m.map)}
                      </TableCell>
                      <TableCell className="py-1 text-right font-mono text-sm tabular-nums">
                        {m.players.toLocaleString()}
                      </TableCell>
                      <TableCell className="py-1 text-right font-mono text-xs tabular-nums text-muted-foreground">
                        {m.officialPlayers.toLocaleString()}
                      </TableCell>
                      <TableCell className="py-1 text-right font-mono text-xs tabular-nums text-muted-foreground">
                        {m.servers.toLocaleString()}
                      </TableCell>
                    </TableRow>
                  ))}
                  {byMap.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} className="py-4 text-center text-muted-foreground">
                        No map data in the latest scan.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            Counts are the latest 5-minute scan of GetServerList. "Official" is the Valve casual/MvM
            pool (the "valve" gametype tag); empty community servers are dropped at scan time.
            Regions are Steam master-server codes, which are approximate.
          </p>
        </>
      )}
    </div>
  );
}
