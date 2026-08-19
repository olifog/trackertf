import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, stripSearchParams } from "@tanstack/react-router";
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
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import {
  ChartContainer,
  type ChartConfig,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "#/components/ui/chart";
import { CLASS_NAMES } from "#/lib/tf2";
import {
  ecosystemOverviewQueryOptions,
  GAMEMODES,
  type Gamemode,
  gamemodeTrendQueryOptions,
  trendRangeSchema,
} from "#/server/ecosystem";

export const Route = createFileRoute("/ecosystem")({
  validateSearch: (search: Record<string, unknown>) => ({
    trend: trendRangeSchema.catch("7d").parse(search["trend"]),
  }),
  search: { middlewares: [stripSearchParams({ trend: "7d" as const })] },
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) =>
    Promise.all([
      context.queryClient.ensureQueryData(ecosystemOverviewQueryOptions()),
      context.queryClient.ensureQueryData(gamemodeTrendQueryOptions(deps.trend)),
    ]),
  component: EcosystemPage,
});

const GM_CONFIG = {
  payload: { label: "Payload", color: "var(--chart-1)" },
  koth: { label: "King of the Hill", color: "var(--chart-2)" },
  controlPoint: { label: "Control Point", color: "var(--chart-3)" },
  ctf: { label: "Capture the Flag", color: "var(--chart-4)" },
  mvm: { label: "Mann vs Machine", color: "var(--chart-5)" },
  other: { label: "Other", color: "var(--muted-foreground)" },
} satisfies ChartConfig;

const rushConfig = {
  official: { label: "Official", color: "var(--chart-1)" },
  community: { label: "Community", color: "var(--chart-3)" },
} satisfies ChartConfig;

const classConfig = {
  playtimeHours: { label: "Hours played", color: "var(--primary)" },
} satisfies ChartConfig;

function fmtCompact(n: number): string {
  return n.toLocaleString(undefined, { notation: "compact", maximumFractionDigits: 1 });
}

function fmtInt(n: number): string {
  return n.toLocaleString();
}

function fmtTick(unixSec: number, range: "7d" | "14d"): string {
  const d = new Date(unixSec * 1000);
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(range === "7d" ? { hour: "numeric" } : {}),
  });
}

function fmtHourTick(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card size="sm" className="gap-1">
      <CardContent className="space-y-1">
        <div className="font-mono text-[11px] tracking-wider text-muted-foreground uppercase">
          {label}
        </div>
        <div className="font-heading text-2xl font-bold tabular-nums">{value}</div>
        {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
      </CardContent>
    </Card>
  );
}

function Segmented({ children }: { children: React.ReactNode }) {
  return (
    <div className="inline-flex divide-x divide-border overflow-hidden rounded-md border">
      {children}
    </div>
  );
}

function Segment({ children, active, to }: { children: React.ReactNode; active: boolean; to: "7d" | "14d" }) {
  return (
    <Link
      from={Route.fullPath}
      search={(prev) => ({ ...prev, trend: to })}
      className={`flex h-8 items-center px-3 text-[13px] leading-none transition-colors ${
        active
          ? "bg-primary font-medium text-primary-foreground"
          : "bg-secondary/40 text-secondary-foreground hover:bg-accent"
      }`}
    >
      {children}
    </Link>
  );
}

function EcosystemPage() {
  const search = Route.useSearch();
  const { data: o } = useSuspenseQuery(ecosystemOverviewQueryOptions());
  const { data: trend } = useSuspenseQuery(gamemodeTrendQueryOptions(search.trend));

  const officialShare =
    o.livePlayers > 0 ? Math.round((o.officialPlayers / o.livePlayers) * 100) : 0;

  const gamemodePie = o.byGamemode.map((g) => ({
    key: g.gamemode,
    label: GM_CONFIG[g.gamemode].label,
    players: g.players,
    fill: GM_CONFIG[g.gamemode].color,
  }));

  const classBars = o.byClass
    .map((c) => ({
      class: CLASS_NAMES[c.classNum] ?? `Class ${c.classNum}`,
      playtimeHours: c.playtimeHours,
    }))
    .sort((a, b) => b.playtimeHours - a.playtimeHours);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-heading text-2xl font-bold">TF2 ecosystem</h1>
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
          The live state of Team Fortress 2, from the crawled player corpus and 5-minute scans of
          the public server list. Gamemode is derived from the map name; "concurrent players" is
          the average across scans, not a running total.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard label="Players online" value={fmtInt(o.livePlayers)} sub={`${fmtInt(o.liveServers)} servers`} />
        <StatCard label="Official share" value={`${officialShare}%`} sub={`${fmtInt(o.officialPlayers)} on casual/MvM`} />
        <StatCard label="Servers online" value={fmtInt(o.liveServers)} sub={`${fmtInt(o.officialServers)} official`} />
        <StatCard label="Players tracked" value={fmtCompact(o.playersTracked)} sub={`${fmtInt(o.playersTracked)} profiles`} />
        <StatCard label="Active (2wk)" value={fmtCompact(o.activePlayers2wk)} sub="played last 14 days" />
        <StatCard label="Tracked playtime" value={`${fmtCompact(o.totalTrackedHours)}h`} sub="across all profiles" />
      </div>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-heading text-lg font-semibold">Players over time by gamemode</h2>
            <p className="text-xs text-muted-foreground">Average concurrent players on public servers, hourly.</p>
          </div>
          <Segmented>
            <Segment active={search.trend === "7d"} to="7d">
              7 days
            </Segment>
            <Segment active={search.trend === "14d"} to="14d">
              14 days
            </Segment>
          </Segmented>
        </div>
        <Card>
          <CardContent>
            {trend.length === 0 ? (
              <EmptyChart />
            ) : (
              <ChartContainer config={GM_CONFIG} className="aspect-auto h-[320px] w-full">
                <AreaChart data={trend} margin={{ left: 4, right: 8, top: 8 }}>
                  <CartesianGrid vertical={false} />
                  <XAxis
                    dataKey="t"
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    minTickGap={48}
                    tickFormatter={(v: number) => fmtTick(v, search.trend)}
                  />
                  <YAxis tickLine={false} axisLine={false} width={40} tickFormatter={fmtCompact} />
                  <ChartTooltip
                    content={
                      <ChartTooltipContent
                        labelFormatter={(_, payload) => {
                          const p = payload as Array<{ payload?: { t?: number } }> | undefined;
                          const t = p?.[0]?.payload?.t;
                          return t
                            ? new Date(t * 1000).toLocaleString(undefined, {
                                month: "short",
                                day: "numeric",
                                hour: "numeric",
                              })
                            : "";
                        }}
                      />
                    }
                  />
                  <ChartLegend content={<ChartLegendContent />} />
                  {GAMEMODES.map((g: Gamemode) => (
                    <Area
                      key={g}
                      dataKey={g}
                      type="monotone"
                      stackId="1"
                      stroke={`var(--color-${g})`}
                      fill={`var(--color-${g})`}
                      fillOpacity={0.25}
                    />
                  ))}
                </AreaChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Players by gamemode</CardTitle>
          </CardHeader>
          <CardContent>
            {gamemodePie.length === 0 ? (
              <EmptyChart />
            ) : (
              <ChartContainer config={GM_CONFIG} className="mx-auto aspect-square h-[280px]">
                <PieChart>
                  <ChartTooltip content={<ChartTooltipContent nameKey="label" hideLabel />} />
                  <Pie data={gamemodePie} dataKey="players" nameKey="label" innerRadius={60} strokeWidth={2}>
                    {gamemodePie.map((slice) => (
                      <Cell key={slice.key} fill={slice.fill} />
                    ))}
                  </Pie>
                  <ChartLegend content={<ChartLegendContent nameKey="label" />} />
                </PieChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Class playtime</CardTitle>
          </CardHeader>
          <CardContent>
            {classBars.length === 0 ? (
              <EmptyChart />
            ) : (
              <ChartContainer config={classConfig} className="aspect-auto h-[280px] w-full">
                <BarChart data={classBars} layout="vertical" margin={{ left: 8, right: 16 }}>
                  <CartesianGrid horizontal={false} />
                  <XAxis type="number" tickLine={false} axisLine={false} tickFormatter={fmtCompact} />
                  <YAxis
                    type="category"
                    dataKey="class"
                    tickLine={false}
                    axisLine={false}
                    width={68}
                  />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="playtimeHours" fill="var(--color-playtimeHours)" radius={4} />
                </BarChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>
      </div>

      <section className="space-y-3">
        <div>
          <h2 className="font-heading text-lg font-semibold">Rush hour</h2>
          <p className="text-xs text-muted-foreground">
            Average concurrent players by hour of day (UTC) over the last 7 days.
          </p>
        </div>
        <Card>
          <CardContent>
            {o.rushHour.length === 0 ? (
              <EmptyChart />
            ) : (
              <ChartContainer config={rushConfig} className="aspect-auto h-[260px] w-full">
                <BarChart data={o.rushHour} margin={{ left: 4, right: 8, top: 8 }}>
                  <CartesianGrid vertical={false} />
                  <XAxis
                    dataKey="hour"
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    tickFormatter={fmtHourTick}
                  />
                  <YAxis tickLine={false} axisLine={false} width={40} tickFormatter={fmtCompact} />
                  <ChartTooltip
                    content={
                      <ChartTooltipContent labelFormatter={(v) => `${fmtHourTick(Number(v))} UTC`} />
                    }
                  />
                  <ChartLegend content={<ChartLegendContent />} />
                  <Bar dataKey="official" stackId="p" fill="var(--color-official)" />
                  <Bar dataKey="community" stackId="p" fill="var(--color-community)" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

function EmptyChart() {
  return (
    <div className="flex h-[220px] items-center justify-center text-sm text-muted-foreground">
      No data yet — the scanner is warming up.
    </div>
  );
}
