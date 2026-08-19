import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, stripSearchParams } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import {
  ChartContainer,
  type ChartConfig,
  ChartLegend,
  ChartLegendContent,
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
import {
  matchLeaderboardQueryOptions,
  type LeaderRow,
  matchLeaderFiltersSchema,
  type Participant,
  recentSegmentsQueryOptions,
  type SegmentRow,
  segmentQueryOptions,
} from "#/server/matches";

const DEFAULT_SEARCH = { days: 3, minObs: 3, minWindowMin: 5 } as const;

export const Route = createFileRoute("/matches")({
  validateSearch: matchLeaderFiltersSchema,
  search: { middlewares: [stripSearchParams(DEFAULT_SEARCH)] },
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) =>
    Promise.all([
      context.queryClient.ensureQueryData(recentSegmentsQueryOptions()),
      context.queryClient.ensureQueryData(matchLeaderboardQueryOptions(deps)),
    ]),
  component: MatchesPage,
});

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
  // ClickHouse stores region as Int8, so the PG code 255 arrives as -1 here.
  if (code === 255 || code < 0) return "World / SDR";
  return REGION_NAMES[code] ?? `Region ${code}`;
}

type SearchPatch = Partial<ReturnType<typeof Route.useSearch>>;

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
  patch,
}: {
  children: React.ReactNode;
  active: boolean;
  patch: SearchPatch;
}) {
  return (
    <Link
      from={Route.fullPath}
      search={(prev) => ({ ...prev, ...patch })}
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
      <span className="w-20 shrink-0 text-right font-mono text-[11px] tracking-wider text-muted-foreground uppercase">
        {label}
      </span>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5">{children}</div>
    </div>
  );
}

const DAY_OPTIONS = [1, 3, 7, 14] as const;
const OBS_OPTIONS = [2, 3, 5, 8] as const;
const WINDOW_OPTIONS = [0, 5, 10, 20] as const;

function fmtPph(v: number | null): string {
  if (v === null) return "-";
  return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function fmtDuration(sec: number): string {
  const m = Math.round(sec / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function fmtAgo(unixSec: number): string {
  const mins = Math.max(0, Math.round((Date.now() - unixSec * 1000) / 60_000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

// Distinct hues for the region pie, cycled by slice index.
const REGION_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--muted-foreground)",
];

const mapConfig = {
  players: { label: "Players observed", color: "var(--primary)" },
} satisfies ChartConfig;

const histConfig = {
  players: { label: "Scorers", color: "var(--chart-2)" },
} satisfies ChartConfig;

const regionConfig = { players: { label: "Players" } } satisfies ChartConfig;

// pts/hr histogram edges; last bucket is open-ended.
const PPH_EDGES = [0, 100, 200, 300, 400, 500];

/** Hoverable overview charts derived entirely from the already-loaded data. */
function CasualSnapshot({ segments, leaders }: { segments: SegmentRow[]; leaders: LeaderRow[] }) {
  const byMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of segments) m.set(s.map, (m.get(s.map) ?? 0) + s.participants);
    return [...m.entries()]
      .map(([map, players]) => ({ map, players }))
      .sort((a, b) => b.players - a.players)
      .slice(0, 8);
  }, [segments]);

  const byRegion = useMemo(() => {
    const m = new Map<number, number>();
    for (const s of segments) m.set(s.region, (m.get(s.region) ?? 0) + s.participants);
    return [...m.entries()]
      .map(([region, players]) => ({ region: regionLabel(region), players }))
      .sort((a, b) => b.players - a.players);
  }, [segments]);

  const hist = useMemo(() => {
    const buckets = PPH_EDGES.map((lo, i) => {
      const hi = PPH_EDGES[i + 1];
      return {
        label: hi === undefined ? `${lo}+` : `${lo}–${hi}`,
        lo,
        hi: hi ?? Infinity,
        players: 0,
      };
    });
    for (const l of leaders) {
      const v = l.pointsPerHour;
      const b = buckets.find((x) => v >= x.lo && v < x.hi);
      if (b) b.players += 1;
    }
    return buckets;
  }, [leaders]);

  if (segments.length === 0 && leaders.length === 0) return null;

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card>
        <CardHeader>
          <CardTitle>Most-sampled maps</CardTitle>
        </CardHeader>
        <CardContent>
          <ChartContainer config={mapConfig} className="aspect-auto h-[240px] w-full">
            <BarChart data={byMap} layout="vertical" margin={{ left: 8, right: 12 }}>
              <CartesianGrid horizontal={false} />
              <XAxis type="number" tickLine={false} axisLine={false} />
              <YAxis
                type="category"
                dataKey="map"
                tickLine={false}
                axisLine={false}
                width={120}
                tick={{ fontSize: 11 }}
              />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Bar dataKey="players" fill="var(--color-players)" radius={4} />
            </BarChart>
          </ChartContainer>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Sampled players by region</CardTitle>
        </CardHeader>
        <CardContent>
          <ChartContainer config={regionConfig} className="mx-auto aspect-square h-[240px]">
            <PieChart>
              <ChartTooltip content={<ChartTooltipContent nameKey="region" hideLabel />} />
              <Pie data={byRegion} dataKey="players" nameKey="region" innerRadius={50} strokeWidth={2}>
                {byRegion.map((slice, i) => (
                  <Cell key={slice.region} fill={REGION_COLORS[i % REGION_COLORS.length] ?? "var(--chart-1)"} />
                ))}
              </Pie>
              <ChartLegend content={<ChartLegendContent nameKey="region" />} />
            </PieChart>
          </ChartContainer>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Observed pts/hr distribution</CardTitle>
        </CardHeader>
        <CardContent>
          <ChartContainer config={histConfig} className="aspect-auto h-[240px] w-full">
            <BarChart data={hist} margin={{ left: 4, right: 8, top: 8 }}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} tick={{ fontSize: 11 }} />
              <YAxis tickLine={false} axisLine={false} width={32} allowDecimals={false} />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Bar dataKey="players" fill="var(--color-players)" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ChartContainer>
        </CardContent>
      </Card>
    </div>
  );
}

function MatchesPage() {
  const search = Route.useSearch();
  const { data: segments } = useSuspenseQuery(recentSegmentsQueryOptions());
  const { data: leaders } = useSuspenseQuery(matchLeaderboardQueryOptions(search));
  const [openSegment, setOpenSegment] = useState<string | null>(null);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-heading text-2xl font-bold">Casual matches</h1>
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
          The sampler repeatedly queries populated Valve casual servers and records each player's
          score over time. Observed points/hour is measured directly as{" "}
          <span className="font-mono text-xs">(last score - first score) / hours observed</span> —
          the real scoring pace on casual, not the farmable Valve lifetime stat. Names are in-game
          display names, not linked Steam profiles.
        </p>
      </div>

      <CasualSnapshot segments={segments} leaders={leaders} />

      <section className="space-y-3">
        <h2 className="font-heading text-lg font-semibold">Fastest observed scorers</h2>

        <div className="space-y-3 rounded-lg border bg-card/50 p-4">
          <FilterRow label="Window">
            <Segmented>
              {DAY_OPTIONS.map((d) => (
                <Segment key={d} active={search.days === d} patch={{ days: d }}>
                  {d}d
                </Segment>
              ))}
            </Segmented>
            <span className="text-[11px] text-muted-foreground">segments started within</span>
          </FilterRow>
          <FilterRow label="Min obs">
            <Segmented>
              {OBS_OPTIONS.map((o) => (
                <Segment key={o} active={search.minObs === o} patch={{ minObs: o }}>
                  {o}
                </Segment>
              ))}
            </Segmented>
            <span className="text-[11px] text-muted-foreground">samples per player</span>
          </FilterRow>
          <FilterRow label="Min span">
            <Segmented>
              {WINDOW_OPTIONS.map((w) => (
                <Segment key={w} active={search.minWindowMin === w} patch={{ minWindowMin: w }}>
                  {w === 0 ? "any" : `${w}m`}
                </Segment>
              ))}
            </Segmented>
            <span className="text-[11px] text-muted-foreground">observed time window</span>
          </FilterRow>
        </div>

        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-10 text-right">#</TableHead>
              <TableHead>Player</TableHead>
              <TableHead className="w-28">Map</TableHead>
              <TableHead className="w-28">Region</TableHead>
              <TableHead className="w-24 text-right">Pts/hr</TableHead>
              <TableHead className="w-20 text-right">Span</TableHead>
              <TableHead className="w-16 text-right">Obs</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {leaders.map((row, i) => (
              <TableRow key={`${row.segmentId}:${row.name}`} className="h-9">
                <TableCell className="py-1 text-right font-mono text-muted-foreground">
                  {i + 1}
                </TableCell>
                <TableCell className="overflow-hidden py-1 text-ellipsis">{row.name}</TableCell>
                <TableCell className="overflow-hidden py-1 font-mono text-xs text-ellipsis text-muted-foreground">
                  {row.map}
                </TableCell>
                <TableCell className="py-1 text-xs text-muted-foreground">
                  {regionLabel(row.region)}
                </TableCell>
                <TableCell className="py-1 text-right font-mono text-sm tabular-nums">
                  {fmtPph(row.pointsPerHour)}
                </TableCell>
                <TableCell className="py-1 text-right font-mono text-xs tabular-nums text-muted-foreground">
                  {fmtDuration(row.windowSec)}
                </TableCell>
                <TableCell className="py-1 text-right font-mono text-xs tabular-nums text-muted-foreground">
                  {row.observations}
                </TableCell>
              </TableRow>
            ))}
            {leaders.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="py-4 text-center text-muted-foreground">
                  No participants match these thresholds yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </section>

      <section className="space-y-3">
        <h2 className="font-heading text-lg font-semibold">Recent segments</h2>
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-6" />
              <TableHead>Map</TableHead>
              <TableHead className="w-32">Region</TableHead>
              <TableHead className="w-28 text-right">Started</TableHead>
              <TableHead className="w-24 text-right">Duration</TableHead>
              <TableHead className="w-20 text-right">Players</TableHead>
              <TableHead className="w-20 text-right">Rounds</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {segments.map((seg) => {
              const isOpen = openSegment === seg.segmentId;
              return (
                <SegmentRows
                  key={seg.segmentId}
                  segmentId={seg.segmentId}
                  map={seg.map}
                  region={regionLabel(seg.region)}
                  startedAt={seg.startedAt}
                  durationSec={seg.durationSec}
                  participants={seg.participants}
                  rounds={seg.rounds}
                  isOpen={isOpen}
                  onToggle={() => setOpenSegment(isOpen ? null : seg.segmentId)}
                />
              );
            })}
            {segments.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="py-4 text-center text-muted-foreground">
                  No sampled segments yet. The sampler is warming up.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </section>
    </div>
  );
}

function SegmentRows({
  segmentId,
  map,
  region,
  startedAt,
  durationSec,
  participants,
  rounds,
  isOpen,
  onToggle,
}: {
  segmentId: string;
  map: string;
  region: string;
  startedAt: number;
  durationSec: number;
  participants: number;
  rounds: number;
  isOpen: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <TableRow className="h-9 cursor-pointer" onClick={onToggle}>
        <TableCell className="py-1 text-center font-mono text-[11px] text-primary/70">
          {isOpen ? "▾" : "▸"}
        </TableCell>
        <TableCell className="overflow-hidden py-1 font-mono text-xs text-ellipsis">
          {map}
        </TableCell>
        <TableCell className="py-1 text-xs text-muted-foreground">{region}</TableCell>
        <TableCell className="py-1 text-right font-mono text-xs tabular-nums text-muted-foreground">
          <span suppressHydrationWarning>{fmtAgo(startedAt)}</span>
        </TableCell>
        <TableCell className="py-1 text-right font-mono text-xs tabular-nums text-muted-foreground">
          {fmtDuration(durationSec)}
        </TableCell>
        <TableCell className="py-1 text-right font-mono text-sm tabular-nums">
          {participants.toLocaleString()}
        </TableCell>
        <TableCell className="py-1 text-right font-mono text-xs tabular-nums text-muted-foreground">
          {rounds}
        </TableCell>
      </TableRow>
      {isOpen && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={7} className="bg-secondary/20 p-0">
            <SegmentDetail segmentId={segmentId} />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

function SegmentDetail({ segmentId }: { segmentId: string }) {
  const { data, isLoading } = useQuery(segmentQueryOptions(segmentId));
  if (isLoading) {
    return <div className="px-4 py-3 font-mono text-xs text-muted-foreground">loading…</div>;
  }
  if (!data || data.participants.length === 0) {
    return (
      <div className="px-4 py-3 text-sm text-muted-foreground">
        No participant rows for this segment.
      </div>
    );
  }
  return (
    <div className="px-4 py-2">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-10 text-right">#</TableHead>
            <TableHead>Player</TableHead>
            <TableHead className="w-24 text-right">Pts/hr</TableHead>
            <TableHead className="w-28 text-right">Score</TableHead>
            <TableHead className="w-20 text-right">Max</TableHead>
            <TableHead className="w-20 text-right">Span</TableHead>
            <TableHead className="w-16 text-right">Obs</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.participants.map((p, i) => (
            <ParticipantRow key={p.name} p={p} rank={i + 1} />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function ParticipantRow({ p, rank }: { p: Participant; rank: number }) {
  return (
    <TableRow className="h-8">
      <TableCell className="py-0.5 text-right font-mono text-muted-foreground">{rank}</TableCell>
      <TableCell className="overflow-hidden py-0.5 text-ellipsis">{p.name}</TableCell>
      <TableCell className="py-0.5 text-right font-mono text-sm tabular-nums">
        {fmtPph(p.pointsPerHour)}
      </TableCell>
      <TableCell className="py-0.5 text-right font-mono text-xs tabular-nums text-muted-foreground">
        {p.firstScore} → {p.lastScore}
      </TableCell>
      <TableCell className="py-0.5 text-right font-mono text-xs tabular-nums text-muted-foreground">
        {p.maxScore}
      </TableCell>
      <TableCell className="py-0.5 text-right font-mono text-xs tabular-nums text-muted-foreground">
        {fmtDuration(p.windowSec)}
      </TableCell>
      <TableCell className="py-0.5 text-right font-mono text-xs tabular-nums text-muted-foreground">
        {p.observations}
      </TableCell>
    </TableRow>
  );
}
