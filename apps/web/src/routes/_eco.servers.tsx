import { keepPreviousData, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, stripSearchParams } from "@tanstack/react-router";
import { useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  XAxis,
  YAxis,
} from "recharts";
import { z } from "zod";
import { ListFilterInput, Segmented } from "#/components/ui/filter-bar";
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
import { InfoTip } from "#/components/ui/info-tip";
import { NOT_ENOUGH_DATA } from "#/lib/copy";
import { formatAgo } from "#/lib/tf2";
import {
  type ContinentRow,
  type GamemodeKey,
  serverOverviewQueryOptions,
  serverTrendQueryOptions,
  type TagStat,
  type TrendPoint,
  type TrendRange,
  trendRangeSchema,
} from "#/server/servers";

const DEFAULT_SEARCH = { range: "24h" } as const;

const searchSchema = z.object({
  range: trendRangeSchema.catch("24h").default("24h"),
});

export const Route = createFileRoute("/_eco/servers")({
  validateSearch: searchSchema,
  search: { middlewares: [stripSearchParams(DEFAULT_SEARCH)] },
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) => {
    // Block navigation (SSR data / pending skeleton) only when no trend query
    // holds data yet. Range switches on the page resolve instantly and keep
    // the old chart under a fetching overlay (keepPreviousData); the overview
    // is search-independent and stays cached across range clicks.
    const hasData = context.queryClient
      .getQueriesData({ queryKey: ["serverTrend"] })
      .some(([, data]) => data !== undefined);
    const ensured = Promise.all([
      context.queryClient.ensureQueryData(serverOverviewQueryOptions()),
      context.queryClient.ensureQueryData(serverTrendQueryOptions(deps.range)),
    ]);
    if (!hasData) return ensured;
    ensured.catch(() => {});
    return undefined;
  },
  component: ServersPage,
});

/**
 * Steam master-server region codes (approximate — GetServerList reports the
 * master-list region, not a geolocated one). 255 = "rest of the world"; almost
 * all post-2023 Valve servers land here because Steam Datagram Relay hides
 * their real address, so this bucket is labelled honestly rather than "World".
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
};

function regionLabel(code: number): string {
  // ClickHouse stores region as Int8, so 255 can arrive as -1; treat both as SDR.
  if (code === 255 || code < 0) return "SDR / unknown";
  return REGION_NAMES[code] ?? `Region ${code}`;
}

function displayMap(map: string): string {
  return map || "(unknown)";
}

const GAMEMODE_LABELS: Record<GamemodeKey, string> = {
  payload: "Payload",
  cp: "Control Point",
  koth: "King of the Hill",
  ctf: "Capture the Flag",
  mvm: "Mann vs. Machine",
  pd: "Player Destruction",
  other: "Other / Community",
};

const GAMEMODE_COLORS: Record<GamemodeKey, string> = {
  payload: "var(--chart-1)",
  cp: "var(--chart-2)",
  koth: "var(--chart-3)",
  ctf: "var(--chart-4)",
  mvm: "var(--chart-5)",
  pd: "var(--primary)",
  other: "var(--muted-foreground)",
};

const GAMEMODE_ORDER: GamemodeKey[] = ["payload", "cp", "koth", "ctf", "mvm", "pd", "other"];

const trendConfig = Object.fromEntries(
  GAMEMODE_ORDER.map((k) => [k, { label: GAMEMODE_LABELS[k], color: GAMEMODE_COLORS[k] }]),
) satisfies ChartConfig;

const rushConfig = {
  official: { label: "Official", color: "var(--chart-1)" },
  community: { label: "Community", color: "var(--chart-3)" },
} satisfies ChartConfig;

function fmtAxis(unixSec: number, range: TrendRange): string {
  const d = new Date(unixSec * 1000);
  return range === "24h"
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
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
      resetScroll={false}
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

function TrendChart({ points, range }: { points: TrendPoint[]; range: TrendRange }) {
  if (points.length < 2) {
    return (
      <div className="flex h-[260px] items-center justify-center text-sm text-muted-foreground">
        {NOT_ENOUGH_DATA}
      </div>
    );
  }
  return (
    <ChartContainer config={trendConfig} className="h-[260px] w-full">
      <AreaChart data={points} margin={{ left: 4, right: 8, top: 8 }}>
        <defs>
          {GAMEMODE_ORDER.map((k) => (
            <linearGradient key={k} id={`fill-${k}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={GAMEMODE_COLORS[k]} stopOpacity={0.7} />
              <stop offset="95%" stopColor={GAMEMODE_COLORS[k]} stopOpacity={0.05} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="t"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={40}
          tickFormatter={(v) => fmtAxis(Number(v), range)}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={44}
          tickFormatter={(v) => Number(v).toLocaleString()}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(v) => fmtAxis(Number(v), range)}
              indicator="dot"
            />
          }
        />
        {GAMEMODE_ORDER.map((k) => (
          <Area
            key={k}
            dataKey={k}
            type="monotone"
            stackId="players"
            stroke={GAMEMODE_COLORS[k]}
            fill={`url(#fill-${k})`}
            strokeWidth={1.5}
          />
        ))}
      </AreaChart>
    </ChartContainer>
  );
}

function GamemodePie({ data }: { data: { gamemode: GamemodeKey; players: number }[] }) {
  const slices = data.filter((d) => d.players > 0);
  if (slices.length === 0) {
    return (
      <div className="flex h-[260px] items-center justify-center text-sm text-muted-foreground">
        {NOT_ENOUGH_DATA}
      </div>
    );
  }
  const config = Object.fromEntries(
    slices.map((d) => [d.gamemode, { label: GAMEMODE_LABELS[d.gamemode] }]),
  ) satisfies ChartConfig;
  return (
    <ChartContainer config={config} className="mx-auto aspect-square h-[260px]">
      <PieChart>
        <ChartTooltip content={<ChartTooltipContent nameKey="gamemode" hideLabel />} />
        <Pie data={slices} dataKey="players" nameKey="gamemode" innerRadius={55} strokeWidth={2}>
          {slices.map((d) => (
            <Cell key={d.gamemode} fill={GAMEMODE_COLORS[d.gamemode]} stroke="var(--background)" />
          ))}
        </Pie>
      </PieChart>
    </ChartContainer>
  );
}

const TAG_LABELS: Record<string, string> = {
  alltalk: "All-talk",
  nocrits: "No random crits",
  respawntimes: "Modified respawn",
  maxplayers: "Increased max players",
  highlander: "Highlander",
};

const CONTINENT_COLORS: Record<string, string> = {
  "North America": "var(--chart-1)",
  "South America": "var(--chart-2)",
  Europe: "var(--chart-3)",
  Asia: "var(--chart-4)",
  Oceania: "var(--chart-5)",
  "Middle East": "var(--primary)",
  Africa: "var(--muted-foreground)",
};

const tagConfig = {
  count: { label: "Servers", color: "var(--chart-2)" },
} satisfies ChartConfig;

function TagBars({ tags }: { tags: TagStat[] }) {
  const data = tags
    .map((t) => ({ label: TAG_LABELS[t.key] ?? t.key, count: t.count }))
    .sort((a, b) => b.count - a.count);
  if (data.every((d) => d.count === 0)) {
    return (
      <div className="flex h-[220px] items-center justify-center text-sm text-muted-foreground">
        {NOT_ENOUGH_DATA}
      </div>
    );
  }
  return (
    <ChartContainer config={tagConfig} className="aspect-auto h-[220px] w-full">
      <BarChart data={data} layout="vertical" margin={{ left: 8, right: 24 }}>
        <CartesianGrid horizontal={false} />
        <XAxis type="number" tickLine={false} axisLine={false} allowDecimals={false} />
        <YAxis
          type="category"
          dataKey="label"
          tickLine={false}
          axisLine={false}
          width={96}
          tick={{ fontSize: 10 }}
        />
        <ChartTooltip content={<ChartTooltipContent />} />
        <Bar dataKey="count" fill="var(--color-count)" radius={4} />
      </BarChart>
    </ChartContainer>
  );
}

function ContinentPie({ data }: { data: ContinentRow[] }) {
  const slices = data.filter((d) => d.players > 0);
  if (slices.length === 0) {
    return (
      <div className="flex h-[260px] items-center justify-center text-sm text-muted-foreground">
        {NOT_ENOUGH_DATA}
      </div>
    );
  }
  const config = Object.fromEntries(
    slices.map((d) => [d.continent, { label: d.continent }]),
  ) satisfies ChartConfig;
  return (
    <ChartContainer config={config} className="mx-auto aspect-square h-[260px]">
      <PieChart>
        <ChartTooltip content={<ChartTooltipContent nameKey="continent" hideLabel />} />
        <Pie data={slices} dataKey="players" nameKey="continent" innerRadius={55} strokeWidth={2}>
          {slices.map((d) => (
            <Cell
              key={d.continent}
              fill={CONTINENT_COLORS[d.continent] ?? "var(--chart-1)"}
              stroke="var(--background)"
            />
          ))}
        </Pie>
      </PieChart>
    </ChartContainer>
  );
}

function RushHourChart({
  data,
}: {
  data: { hour: number; official: number; community: number }[];
}) {
  if (data.length === 0) {
    return (
      <div className="flex h-[220px] items-center justify-center text-sm text-muted-foreground">
        {NOT_ENOUGH_DATA}
      </div>
    );
  }
  return (
    <ChartContainer config={rushConfig} className="h-[220px] w-full">
      <BarChart data={data} margin={{ left: 4, right: 8, top: 8 }}>
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="hour"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          interval="preserveStartEnd"
          minTickGap={24}
          tickFormatter={(v) => `${String(v).padStart(2, "0")}:00`}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={44}
          tickFormatter={(v) => Number(v).toLocaleString()}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(v) => `${String(v).padStart(2, "0")}:00 UTC`}
              indicator="dot"
            />
          }
        />
        <ChartLegend content={<ChartLegendContent />} />
        <Bar dataKey="official" stackId="p" fill="var(--color-official)" />
        <Bar dataKey="community" stackId="p" fill="var(--color-community)" radius={[3, 3, 0, 0]} />
      </BarChart>
    </ChartContainer>
  );
}

function ServersPage() {
  const search = Route.useSearch();
  const { data: overview } = useSuspenseQuery(serverOverviewQueryOptions());
  const trendQuery = useQuery({
    ...serverTrendQueryOptions(search.range),
    placeholderData: keepPreviousData,
  });
  const trend = trendQuery.data ?? [];
  const { totals, byRegion, byMap, byGamemode, rushHour, tags, byContinent } = overview;
  const [mapFilter, setMapFilter] = useState("");
  const mapNeedle = mapFilter.trim().toLowerCase();
  // rank before filtering so filtered rows keep their true "#" position
  const rankedMaps = byMap.map((m, i) => ({ m, rank: i + 1 }));
  const visibleMaps = mapNeedle
    ? rankedMaps.filter(({ m }) => displayMap(m.map).toLowerCase().includes(mapNeedle))
    : rankedMaps;
  const communityPlayers = Math.max(0, totals.players - totals.officialPlayers);
  const communityServers = Math.max(0, totals.servers - totals.officialServers);
  const avgFill = totals.officialServers > 0 ? totals.officialPlayers / totals.officialServers : 0;
  const seatFill = totals.capacity > 0 ? totals.players / totals.capacity : 0;
  const emptyCommunity = totals.emptyCommunityServers;
  const communityTotal = communityServers + emptyCommunity;
  const communityOccupied = communityTotal > 0 ? communityServers / communityTotal : 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="flex items-center gap-1.5">
          <h1 className="font-heading text-2xl font-bold">Servers</h1>
          <InfoTip text='Latest 5-min GetServerList scan. "Official" = the Valve casual/MvM pool. Empty Valve servers are unmeasurable, and their locations are SDR-hidden ("SDR / unknown").' />
        </div>
        {overview.scannedAt && (
          <p className="font-mono text-xs text-muted-foreground" suppressHydrationWarning>
            scanned {formatAgo(overview.scannedAt)}
          </p>
        )}
      </div>

      {overview.scannedAt === null ? (
        <p className="text-muted-foreground">{NOT_ENOUGH_DATA}</p>
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
              sub={`${avgFill.toFixed(1)} avg / server`}
            />
            <Stat label="community players" value={communityPlayers.toLocaleString()} />
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
                <Segment active={search.range === "14d"} range="14d">
                  14d
                </Segment>
              </Segmented>
            </div>
            <div className="relative">
              <TrendChart points={trend} range={search.range} />
              {trendQuery.isPlaceholderData && (
                <div className="absolute inset-0 z-10 flex items-center justify-center rounded-md bg-background/60 backdrop-blur-[1px]">
                  <div className="flex items-center gap-2 rounded-md border bg-card px-3 py-2 text-sm text-muted-foreground shadow-sm">
                    <span className="size-4 animate-spin rounded-full border-2 border-muted-foreground/40 border-t-foreground" />
                    Updating…
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <div className="rounded-lg border bg-card/50 p-4">
              <h2 className="mb-3 flex items-center gap-1.5 font-heading text-lg font-semibold">
                Community occupancy
                <InfoTip text="Empty count is community-only; Valve empties are unmeasurable." />
              </h2>
              <div className="grid grid-cols-2 gap-3">
                <Stat
                  label="occupied"
                  value={`${(communityOccupied * 100).toFixed(0)}%`}
                  sub={`${communityServers.toLocaleString()} populated · ${emptyCommunity.toLocaleString()} empty`}
                />
                <Stat
                  label="seat fill"
                  value={`${(seatFill * 100).toFixed(0)}%`}
                  sub={`${totals.players.toLocaleString()} / ${totals.capacity.toLocaleString()} seats`}
                />
              </div>
            </div>

            <div className="rounded-lg border bg-card/50 p-4">
              <h2 className="mb-2 font-heading text-lg font-semibold">Gametype flags</h2>
              <TagBars tags={tags} />
            </div>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <div className="rounded-lg border bg-card/50 p-4">
              <h2 className="mb-2 font-heading text-lg font-semibold">Players by gamemode</h2>
              <GamemodePie data={byGamemode} />
              <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1">
                {byGamemode
                  .filter((g) => g.players > 0)
                  .map((g) => (
                    <div key={g.gamemode} className="flex items-center gap-1.5 text-xs">
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
                        style={{ backgroundColor: GAMEMODE_COLORS[g.gamemode] }}
                      />
                      <span className="text-muted-foreground">{GAMEMODE_LABELS[g.gamemode]}</span>
                      <span className="ml-auto font-mono tabular-nums">
                        {g.players.toLocaleString()}
                      </span>
                    </div>
                  ))}
              </div>
            </div>

            <div className="rounded-lg border bg-card/50 p-4">
              <h2 className="font-heading text-lg font-semibold">Rush hour</h2>
              <p className="mb-2 text-xs text-muted-foreground">UTC, 7d</p>
              <RushHourChart data={rushHour} />
            </div>
          </div>

          <div className="rounded-lg border bg-card/50 p-4">
            <h2 className="mb-2 flex items-center gap-1.5 font-heading text-lg font-semibold">
              Community players by continent
              <InfoTip text="Community servers only — Valve casual is SDR-hidden and can't be geolocated." />
            </h2>
            <div className="grid items-center gap-6 lg:grid-cols-2">
              <ContinentPie data={byContinent} />
              <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
                {byContinent
                  .filter((c) => c.players > 0)
                  .map((c) => (
                    <div key={c.continent} className="flex items-center gap-1.5 text-xs">
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
                        style={{
                          backgroundColor: CONTINENT_COLORS[c.continent] ?? "var(--chart-1)",
                        }}
                      />
                      <span className="text-muted-foreground">{c.continent}</span>
                      <span className="ml-auto font-mono tabular-nums">
                        {c.players.toLocaleString()}
                      </span>
                    </div>
                  ))}
              </div>
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
              <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <h2 className="font-heading text-lg font-semibold">
                  Top maps <span className="text-sm text-muted-foreground">(by players)</span>
                </h2>
                <ListFilterInput
                  value={mapFilter}
                  onChange={setMapFilter}
                  placeholder="filter maps…"
                  className="w-44"
                />
              </div>
              <Table containerClassName="max-h-[28rem] overflow-y-auto rounded-md border">
                <TableHeader className="sticky top-0 z-10 bg-background">
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-10 text-right">#</TableHead>
                    <TableHead>Map</TableHead>
                    <TableHead className="text-right">Players</TableHead>
                    <TableHead className="text-right">Official</TableHead>
                    <TableHead className="text-right">Servers</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleMaps.map(({ m, rank }) => (
                    <TableRow key={m.map} className="h-9">
                      <TableCell className="py-1 text-right font-mono text-muted-foreground">
                        {rank}
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
                  {visibleMaps.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} className="py-4 text-center text-muted-foreground">
                        {byMap.length === 0
                          ? "No map data in the latest scan."
                          : `No maps match "${mapFilter.trim()}".`}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
