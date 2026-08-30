import { keepPreviousData, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, stripSearchParams } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { FilterRow, ListFilterInput, Segmented } from "#/components/ui/filter-bar";
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
import { InfoTip } from "#/components/ui/info-tip";
import { NOT_ENOUGH_DATA } from "#/lib/copy";
import { avatarUrl } from "#/lib/tf2";
import { type DurationRow, matchDurationsQueryOptions } from "#/server/matchDurations";
import { type MapClassRow, mapClassPlaytimeQueryOptions } from "#/server/mapClass";
import {
  type MapDetail,
  type MapRegular,
  type MapScorer,
  type MapWeapon,
  mapDetailQueryOptions,
} from "#/server/mapDetail";
import type { GamemodeKey } from "#/server/servers";
import {
  attributionsForSegmentsQueryOptions,
  matchLeaderboardQueryOptions,
  type LeaderRow,
  matchLeaderFiltersSchema,
  type Participant,
  type ProfileCandidate,
  recentSegmentsQueryOptions,
  resolveParticipantQueryOptions,
  type SegmentAttribution,
  type SegmentRow,
  segmentQueryOptions,
} from "#/server/matches";

const DEFAULT_SEARCH = { days: 3, minObs: 3, minWindowMin: 5 } as const;

export const Route = createFileRoute("/_eco/matches")({
  validateSearch: matchLeaderFiltersSchema,
  search: { middlewares: [stripSearchParams(DEFAULT_SEARCH)] },
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) => {
    // Block navigation (SSR data / pending skeleton) only when no scorer
    // leaderboard query holds data yet. Filter changes on the page resolve
    // instantly and keep the old rows under a fetching overlay
    // (keepPreviousData); recent segments are search-independent and stay
    // cached across filter clicks.
    const hasData = context.queryClient
      .getQueriesData({ queryKey: ["matchLeaderboard"] })
      .some(([, data]) => data !== undefined);
    const ensured = Promise.all([
      context.queryClient.ensureQueryData(recentSegmentsQueryOptions()),
      context.queryClient.ensureQueryData(matchLeaderboardQueryOptions(deps)),
    ]);
    if (!hasData) return ensured;
    ensured.catch(() => {});
    return undefined;
  },
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

const mapConfig = {
  players: { label: "Players observed", color: "var(--primary)" },
} satisfies ChartConfig;

const histConfig = {
  players: { label: "Scorers", color: "var(--chart-2)" },
} satisfies ChartConfig;

/** 2-letter ISO country code → regional-indicator flag emoji ("" if invalid). */
function countryFlag(code: string | null): string {
  if (!code || !/^[a-zA-Z]{2}$/.test(code)) return "";
  const base = 0x1f1e6;
  return String.fromCodePoint(...[...code.toUpperCase()].map((c) => base + c.charCodeAt(0) - 65));
}

function fmtHours2wk(min: number | null): string {
  if (!min || min <= 0) return "dormant";
  const h = min / 60;
  return h < 10 ? `${h.toFixed(1)}h/2wk` : `${Math.round(h)}h/2wk`;
}

const TIER_STYLE: Record<ProfileCandidate["tier"], string> = {
  strong: "bg-primary/20 text-primary border-primary/40",
  possible: "bg-secondary/60 text-secondary-foreground border-border",
  weak: "bg-transparent text-muted-foreground border-border",
};

function TierBadge({ tier, confidence }: { tier: ProfileCandidate["tier"]; confidence: number }) {
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px] tracking-wider uppercase ${TIER_STYLE[tier]}`}
      title={`confidence ${(confidence * 100).toFixed(0)}%`}
    >
      {tier} · {(confidence * 100).toFixed(0)}%
    </span>
  );
}

function SignalChip({ on, children }: { on: boolean; children: React.ReactNode }) {
  return (
    <span
      className={`rounded px-1 py-0.5 font-mono text-[10px] ${
        on ? "bg-primary/15 text-primary" : "text-muted-foreground/50 line-through"
      }`}
    >
      {children}
    </span>
  );
}

function CandidateCard({ c }: { c: ProfileCandidate }) {
  const avatar = avatarUrl(c.avatarHash);
  const flag = countryFlag(c.loccountrycode);
  return (
    <div className="flex items-center gap-3 rounded-md border bg-card/40 px-3 py-2">
      {avatar ? (
        <img src={avatar} alt="" className="h-8 w-8 shrink-0 rounded" />
      ) : (
        <div className="h-8 w-8 shrink-0 rounded bg-secondary/60" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Link
            to="/player/$steamid"
            params={{ steamid: c.steamid }}
            className="truncate font-medium text-primary hover:underline"
          >
            {c.personaname ?? c.steamid}
          </Link>
          {flag && <span title={c.loccountrycode ?? undefined}>{flag}</span>}
          <TierBadge tier={c.tier} confidence={c.confidence} />
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          <span className="font-mono">{fmtHours2wk(c.tf2Minutes2wk)}</span>
          <SignalChip on={c.signals.exactName}>exact name</SignalChip>
          <SignalChip on={c.signals.recentlyActive}>active</SignalChip>
          <SignalChip on={c.signals.deltaCorroborated}>Δ playtime verified</SignalChip>
        </div>
      </div>
    </div>
  );
}

/** Lazily-loaded probabilistic profile candidates for one observed name. */
function CandidatePanel({ segmentId, name }: { segmentId: string; name: string }) {
  const { data, isLoading } = useQuery(resolveParticipantQueryOptions(segmentId, name));
  if (isLoading) {
    return <div className="px-4 py-3 font-mono text-xs text-muted-foreground">matching…</div>;
  }
  if (!data || data.candidates.length === 0) {
    return (
      <div className="px-4 py-3 text-xs text-muted-foreground">
        No profile candidates for this name.
      </div>
    );
  }
  return (
    <div className="space-y-2 px-4 py-3">
      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        Profile candidates for <span className="font-mono">"{data.observedName}"</span>
        <InfoTip text="Ranked by name, recent playtime and stat deltas. Not a certain match." />
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        {data.candidates.slice(0, 8).map((c) => (
          <CandidateCard key={c.steamid} c={c} />
        ))}
      </div>
    </div>
  );
}

/** A clickable observed name that toggles its candidate panel. */
function MatchableName({
  name,
  open,
  onToggle,
}: {
  name: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`max-w-full truncate text-left hover:text-primary hover:underline ${
        open ? "text-primary" : ""
      }`}
      title="Show possible Steam profiles"
    >
      {name}
    </button>
  );
}

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
    <div className="grid gap-6 lg:grid-cols-2">
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
                width={96}
                tick={{ fontSize: 10 }}
              />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Bar dataKey="players" fill="var(--color-players)" radius={4} />
            </BarChart>
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
              <XAxis
                dataKey="label"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                tick={{ fontSize: 11 }}
              />
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

const GAMEMODE_LABELS: Record<GamemodeKey, string> = {
  payload: "Payload",
  cp: "Control Point",
  koth: "King of the Hill",
  ctf: "Capture the Flag",
  mvm: "Mann vs. Machine",
  pd: "Player Destruction",
  other: "Other",
};

/**
 * Median casual match length by gamemode and map, from completed segments the
 * sampler witnessed start-to-finish (see server/matchDurations.ts). Lazy,
 * non-blocking, and degrades to an empty state while the sampler accrues
 * enough both-ends-witnessed matches.
 */
function MatchDurationsSection() {
  const { data, isLoading } = useQuery(matchDurationsQueryOptions());
  const byGamemode = data?.byGamemode ?? [];
  const byMap = data?.byMap ?? [];
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLowerCase();
  const visibleMaps = needle
    ? byMap.filter((m) => (m.map ?? "").toLowerCase().includes(needle))
    : byMap;

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-1.5">
        <h2 className="font-heading text-lg font-semibold">How long matches take</h2>
        <InfoTip text="Median length of matches the sampler saw start-to-finish. Truncated observations excluded." />
      </div>

      {byGamemode.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {byGamemode.map((g) => (
            <div key={g.gamemode} className="rounded-lg border bg-card/50 p-3">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                {GAMEMODE_LABELS[g.gamemode]}
              </div>
              <div className="mt-1 font-heading text-xl font-bold tabular-nums">
                {fmtDuration(g.medianSec)}
              </div>
              <div className="mt-0.5 text-[11px] text-muted-foreground tabular-nums">
                {fmtDuration(g.p25Sec)}–{fmtDuration(g.p75Sec)} · {g.matches.toLocaleString()}{" "}
                {g.matches === 1 ? "match" : "matches"}
              </div>
            </div>
          ))}
        </div>
      )}

      {byMap.length > 0 && (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <ListFilterInput value={filter} onChange={setFilter} placeholder="filter maps…" />
            <span className="font-mono text-[11px] text-muted-foreground">
              {visibleMaps.length.toLocaleString()} of {byMap.length.toLocaleString()} maps
            </span>
          </div>
          <Table containerClassName="max-h-[28rem] overflow-y-auto rounded-md border">
            <TableHeader className="sticky top-0 z-10 bg-background">
              <TableRow className="hover:bg-transparent">
                <TableHead>Map</TableHead>
                <TableHead className="w-40">Mode</TableHead>
                <TableHead className="w-24 text-right">Median</TableHead>
                <TableHead className="w-32 text-right">Typical range</TableHead>
                <TableHead className="w-24 text-right">Matches</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleMaps.map((m: DurationRow) => (
                <TableRow key={m.map}>
                  <TableCell className="font-mono text-xs">{m.map}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {GAMEMODE_LABELS[m.gamemode]}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {fmtDuration(m.medianSec)}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground tabular-nums">
                    {fmtDuration(m.p25Sec)}–{fmtDuration(m.p75Sec)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {m.matches.toLocaleString()}
                  </TableCell>
                </TableRow>
              ))}
              {visibleMaps.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-4 text-center text-muted-foreground">
                    No maps match "{filter.trim()}".
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </>
      )}

      {!isLoading && byGamemode.length === 0 && (
        <div className="rounded-lg border bg-card/50 p-4 text-sm text-muted-foreground">
          {NOT_ENOUGH_DATA}
        </div>
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Forward attribution (>= 0.9): committed name→profile links                   */
/* -------------------------------------------------------------------------- */

type AttrMap = Map<string, SegmentAttribution>;
const attrKey = (segmentId: string, name: string) => `${segmentId}:${name}`;

/** Inline link to the profile the attributor committed to for an observed name. */
function AttributedLink({ a }: { a: SegmentAttribution }) {
  const avatar = avatarUrl(a.avatarHash);
  return (
    <Link
      to="/player/$steamid"
      params={{ steamid: a.steamid }}
      onClick={(e) => e.stopPropagation()}
      className="ml-1.5 inline-flex max-w-[10rem] items-center gap-1 align-middle rounded bg-primary/10 px-1 py-0.5 text-primary hover:bg-primary/20"
      title={`Attributed to ${a.personaname ?? a.steamid} — confidence ${(a.confidence * 100).toFixed(0)}%${a.strong ? " (strong)" : ""}`}
    >
      {avatar ? <img src={avatar} alt="" className="h-3.5 w-3.5 shrink-0 rounded-sm" /> : null}
      <span className="truncate text-[11px] font-medium">→ {a.personaname ?? a.steamid}</span>
    </Link>
  );
}

const CLASS_NAMES: Record<number, string> = {
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

// 9-hue categorical palette (Tableau-10 derived), indexed by classNum-1. Chosen
// for mutual contrast and adequate legibility in both light and dark themes.
const CLASS_COLORS = [
  "#4e79a7",
  "#f28e2b",
  "#e15759",
  "#76b7b2",
  "#59a14f",
  "#edc948",
  "#b07aa1",
  "#ff9da7",
  "#9c755f",
] as const;

function classColor(classNum: number): string {
  return CLASS_COLORS[(classNum - 1) % CLASS_COLORS.length] ?? "var(--muted-foreground)";
}

/**
 * Class playtime by map — the per-class lifetime-playtime delta attributed to a
 * single map over "pure-map" windows (see server/mapClass.ts). A stacked share
 * bar per map shows how the class mix shifts between maps. Attributed, not
 * directly observed, so it accrues slowly and degrades to an empty state.
 */
function MapClassSection() {
  const { data, isLoading } = useQuery(mapClassPlaytimeQueryOptions());
  const maps = data?.maps ?? [];
  const [openMap, setOpenMap] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLowerCase();
  const visibleMaps = needle ? maps.filter((m) => m.map.toLowerCase().includes(needle)) : maps;

  return (
    <section className="space-y-3">
      <h2 className="font-heading text-lg font-semibold">Maps</h2>
      <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
        Class mix by map. Click a map for detail.
        <InfoTip text="Inferred from attributed players' per-class playtime; a trend, not a census." />
      </p>

      {maps.length > 0 && (
        <>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {Object.entries(CLASS_NAMES).map(([n, label]) => (
              <span key={n} className="inline-flex items-center gap-1.5 text-[11px]">
                <span
                  className="inline-block h-2.5 w-2.5 rounded-sm"
                  style={{ backgroundColor: classColor(Number(n)) }}
                />
                {label}
              </span>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <ListFilterInput value={filter} onChange={setFilter} placeholder="filter maps…" />
            <span className="font-mono text-[11px] text-muted-foreground">
              {visibleMaps.length.toLocaleString()} of {maps.length.toLocaleString()} maps
            </span>
          </div>
          <div className="max-h-[28rem] space-y-1 overflow-y-auto rounded-md border p-1">
            {visibleMaps.map((m: MapClassRow) => {
              const isOpen = openMap === m.map;
              return (
                <div key={m.map} className="rounded-md">
                  <button
                    type="button"
                    onClick={() => setOpenMap(isOpen ? null : m.map)}
                    className={`grid w-full grid-cols-[1rem_10rem_1fr_5rem] items-center gap-3 rounded-md px-1 py-1 text-left transition-colors hover:bg-accent/50 ${
                      isOpen ? "bg-accent/40" : ""
                    }`}
                  >
                    <span className="text-center font-mono text-[11px] text-primary/70">
                      {isOpen ? "▾" : "▸"}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate font-mono text-xs">{m.map}</span>
                      <span className="block text-[10px] text-muted-foreground">
                        {GAMEMODE_LABELS[m.gamemode]}
                      </span>
                    </span>
                    <span className="flex h-4 w-full overflow-hidden rounded bg-secondary/40">
                      {m.classes.map((c) => (
                        <span
                          key={c.classNum}
                          className="h-full"
                          style={{
                            width: `${c.share * 100}%`,
                            backgroundColor: classColor(c.classNum),
                          }}
                          title={`${CLASS_NAMES[c.classNum] ?? c.classNum}: ${fmtDuration(c.seconds)} (${(c.share * 100).toFixed(0)}%)`}
                        />
                      ))}
                    </span>
                    <span className="text-right text-[11px] tabular-nums text-muted-foreground">
                      {fmtDuration(m.totalSeconds)}
                    </span>
                  </button>
                  {isOpen && <MapDetailPanel map={m.map} />}
                </div>
              );
            })}
            {visibleMaps.length === 0 && (
              <p className="px-2 py-3 text-sm text-muted-foreground">
                No maps match "{filter.trim()}".
              </p>
            )}
          </div>
        </>
      )}

      {!isLoading && maps.length === 0 && (
        <div className="rounded-lg border bg-card/50 p-4 text-sm text-muted-foreground">
          {NOT_ENOUGH_DATA}
        </div>
      )}
    </section>
  );
}

/** Expanded per-map surface: full class mix, observed top scorers, regulars,
 * and (indirect) the loadouts those regulars run. Lazy, non-blocking. */
function MapDetailPanel({ map }: { map: string }) {
  const { data, isLoading } = useQuery(mapDetailQueryOptions(map));
  if (isLoading || !data) {
    return <div className="px-6 py-3 font-mono text-xs text-muted-foreground">loading map…</div>;
  }
  return (
    <div className="grid gap-6 rounded-b-md border-x border-b bg-card/40 px-4 py-4 lg:grid-cols-2">
      <MapClassMix detail={data} />
      <MapScorers scorers={data.topScorers} />
      <MapRegulars regulars={data.regulars} regularCount={data.regularCount} />
      <MapWeapons weapons={data.weapons} />
    </div>
  );
}

function MapClassMix({ detail }: { detail: MapDetail }) {
  const withTime = detail.classMix.filter((c) => c.seconds > 0);
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold">Class mix</h3>
      {withTime.length > 0 ? (
        <>
          <div className="space-y-1">
            {withTime.map((c) => (
              <div key={c.classNum} className="flex items-center gap-2 text-xs">
                <span
                  className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
                  style={{ backgroundColor: classColor(c.classNum) }}
                />
                <span className="w-16 shrink-0">{CLASS_NAMES[c.classNum] ?? c.classNum}</span>
                <span className="h-2 flex-1 overflow-hidden rounded bg-secondary/40">
                  <span
                    className="block h-full"
                    style={{
                      width: `${c.share * 100}%`,
                      backgroundColor: classColor(c.classNum),
                    }}
                  />
                </span>
                <span className="w-10 text-right tabular-nums text-muted-foreground">
                  {(c.share * 100).toFixed(0)}%
                </span>
                <span className="w-14 text-right tabular-nums text-muted-foreground">
                  {fmtDuration(c.seconds)}
                </span>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground">
            {fmtDuration(detail.totalSeconds)} attributed · ~{detail.classPlayers} players ·{" "}
            {detail.windows} windows
          </p>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          No attributed class playtime for this map yet.
        </p>
      )}
    </div>
  );
}

function MapScorers({ scorers }: { scorers: MapScorer[] }) {
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold">Fastest observed scorers</h3>
      {scorers.length > 0 ? (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-8 text-right">#</TableHead>
              <TableHead>Name</TableHead>
              <TableHead className="w-24 text-right">Pts/hr</TableHead>
              <TableHead className="w-16 text-right">Span</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {scorers.map((s, i) => (
              <TableRow key={`${s.segmentId}:${s.name}`} className="h-8">
                <TableCell className="py-0.5 text-right font-mono text-muted-foreground">
                  {i + 1}
                </TableCell>
                <TableCell className="max-w-0 overflow-hidden py-0.5 truncate font-mono text-xs">
                  {s.name}
                </TableCell>
                <TableCell className="py-0.5 text-right font-mono text-sm tabular-nums">
                  {fmtPph(s.pointsPerHour)}
                </TableCell>
                <TableCell className="py-0.5 text-right font-mono text-xs tabular-nums text-muted-foreground">
                  {fmtDuration(s.windowSec)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <p className="text-xs text-muted-foreground">{NOT_ENOUGH_DATA}</p>
      )}
    </div>
  );
}

function MapRegulars({ regulars, regularCount }: { regulars: MapRegular[]; regularCount: number }) {
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold">Regulars</h3>
      {regulars.length > 0 ? (
        <>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {regulars.map((r) => {
              const avatar = avatarUrl(r.avatarHash);
              return (
                <Link
                  key={r.steamid}
                  to="/player/$steamid"
                  params={{ steamid: r.steamid }}
                  className="flex items-center gap-2 rounded border bg-card/40 px-2 py-1 hover:bg-accent/40"
                >
                  {avatar ? (
                    <img src={avatar} alt="" className="h-6 w-6 shrink-0 rounded" />
                  ) : (
                    <span className="h-6 w-6 shrink-0 rounded bg-secondary/60" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-xs text-primary">
                    {r.personaname ?? r.steamid}
                  </span>
                  <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                    ×{r.segments}
                  </span>
                </Link>
              );
            })}
          </div>
          <p className="text-[11px] text-muted-foreground">
            {regularCount} profile{regularCount === 1 ? "" : "s"} attributed (≥ 0.9). ×N = sampled
            segments here.
          </p>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">{NOT_ENOUGH_DATA}</p>
      )}
    </div>
  );
}

function MapWeapons({ weapons }: { weapons: MapWeapon[] }) {
  return (
    <div className="space-y-2">
      <h3 className="flex items-center gap-1.5 text-sm font-semibold">
        What the regulars run
        <InfoTip text="Global loadouts of this map's regulars, not per-map performance." />
      </h3>
      {weapons.length > 0 ? (
        <>
          <div className="flex flex-wrap gap-1.5">
            {weapons.map((w) => (
              <span
                key={w.defindex}
                className="inline-flex items-center gap-1.5 rounded border bg-card/40 px-2 py-1 text-xs"
                title={`${w.players} of this map's regulars equip ${w.name}`}
              >
                {w.imageUrl ? (
                  <img src={w.imageUrl} alt="" className="h-5 w-5 shrink-0 object-contain" />
                ) : null}
                <span className="max-w-[9rem] truncate">{w.name}</span>
                <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                  {w.players}
                </span>
              </span>
            ))}
          </div>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">{NOT_ENOUGH_DATA}</p>
      )}
    </div>
  );
}

const NO_LEADERS: LeaderRow[] = [];

function MatchesPage() {
  const search = Route.useSearch();
  const { data: segments } = useSuspenseQuery(recentSegmentsQueryOptions());
  const leadersQuery = useQuery({
    ...matchLeaderboardQueryOptions(search),
    placeholderData: keepPreviousData,
  });
  const leaders = leadersQuery.data ?? NO_LEADERS;
  const [openSegment, setOpenSegment] = useState<string | null>(null);
  const [segmentFilter, setSegmentFilter] = useState("");
  const segmentNeedle = segmentFilter.trim().toLowerCase();
  const visibleSegments = segmentNeedle
    ? segments.filter((s) => s.map.toLowerCase().includes(segmentNeedle))
    : segments;

  const segmentIds = useMemo(() => {
    const s = new Set<string>();
    for (const seg of segments) s.add(seg.segmentId);
    for (const l of leaders) s.add(l.segmentId);
    return [...s];
  }, [segments, leaders]);
  const { data: attrList } = useQuery(attributionsForSegmentsQueryOptions(segmentIds));
  const attr: AttrMap = useMemo(() => {
    const m: AttrMap = new Map();
    for (const a of attrList ?? []) m.set(attrKey(a.segmentId, a.name), a);
    return m;
  }, [attrList]);

  return (
    <div className="space-y-8">
      <div className="flex items-center gap-1.5">
        <h1 className="font-heading text-2xl font-bold">Casual matches</h1>
        <InfoTip text="Pts/hr = (last − first score) / hours observed on casual. Names are in-game; profile matches are probabilistic." />
      </div>

      <CasualSnapshot segments={segments} leaders={leaders} />

      <MatchDurationsSection />

      <MapClassSection />

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

        <div className="relative">
          <Table containerClassName="max-h-[36rem] overflow-y-auto rounded-md border">
            <TableHeader className="sticky top-0 z-10 bg-background">
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
                <LeaderRows
                  key={`${row.segmentId}:${row.name}`}
                  row={row}
                  rank={i + 1}
                  attribution={attr.get(attrKey(row.segmentId, row.name))}
                />
              ))}
              {leaders.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="py-4 text-center text-muted-foreground">
                    No participants match these filters.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          {leadersQuery.isPlaceholderData && (
            <div className="absolute inset-0 z-10 flex items-start justify-center rounded-md bg-background/60 pt-24 backdrop-blur-[1px]">
              <div className="flex items-center gap-2 rounded-md border bg-card px-3 py-2 text-sm text-muted-foreground shadow-sm">
                <span className="size-4 animate-spin rounded-full border-2 border-muted-foreground/40 border-t-foreground" />
                Updating…
              </div>
            </div>
          )}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="font-heading text-lg font-semibold">Recent segments</h2>
        {segments.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <ListFilterInput
              value={segmentFilter}
              onChange={setSegmentFilter}
              placeholder="filter maps…"
            />
            <span className="font-mono text-[11px] text-muted-foreground">
              {visibleSegments.length.toLocaleString()} of {segments.length.toLocaleString()}{" "}
              segments
            </span>
          </div>
        )}
        <Table containerClassName="max-h-[32rem] overflow-y-auto rounded-md border">
          <TableHeader className="sticky top-0 z-10 bg-background">
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
            {visibleSegments.map((seg) => {
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
                  attr={attr}
                />
              );
            })}
            {visibleSegments.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="py-4 text-center text-muted-foreground">
                  {segments.length === 0
                    ? NOT_ENOUGH_DATA
                    : `No segments match "${segmentFilter.trim()}".`}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </section>
    </div>
  );
}

/** One leaderboard row; clicking the name expands its profile candidates. */
function LeaderRows({
  row,
  rank,
  attribution,
}: {
  row: LeaderRow;
  rank: number;
  attribution: SegmentAttribution | undefined;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <TableRow className="h-9">
        <TableCell className="py-1 text-right font-mono text-muted-foreground">{rank}</TableCell>
        <TableCell className="overflow-hidden py-1 text-ellipsis">
          <MatchableName name={row.name} open={open} onToggle={() => setOpen((o) => !o)} />
          {attribution && <AttributedLink a={attribution} />}
        </TableCell>
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
      {open && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={7} className="bg-secondary/20 p-0">
            <CandidatePanel segmentId={row.segmentId} name={row.name} />
          </TableCell>
        </TableRow>
      )}
    </>
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
  attr,
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
  attr: AttrMap;
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
            <SegmentDetail segmentId={segmentId} attr={attr} />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

function SegmentDetail({ segmentId, attr }: { segmentId: string; attr: AttrMap }) {
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
            <ParticipantRow
              key={p.name}
              p={p}
              rank={i + 1}
              segmentId={segmentId}
              attribution={attr.get(attrKey(segmentId, p.name))}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function ParticipantRow({
  p,
  rank,
  segmentId,
  attribution,
}: {
  p: Participant;
  rank: number;
  segmentId: string;
  attribution: SegmentAttribution | undefined;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <TableRow className="h-8">
        <TableCell className="py-0.5 text-right font-mono text-muted-foreground">{rank}</TableCell>
        <TableCell className="overflow-hidden py-0.5 text-ellipsis">
          <MatchableName name={p.name} open={open} onToggle={() => setOpen((o) => !o)} />
          {attribution && <AttributedLink a={attribution} />}
        </TableCell>
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
      {open && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={7} className="bg-background/60 p-0">
            <CandidatePanel segmentId={segmentId} name={p.name} />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
