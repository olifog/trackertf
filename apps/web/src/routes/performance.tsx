import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { createFileRoute, Link, stripSearchParams } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "#/components/ui/table";
import { Slider } from "#/components/ui/slider";
import {
  METRICS,
  type MetricKey,
  type PerfItemInfo,
  performanceFiltersSchema,
  performanceInfiniteQueryOptions,
  type Subject,
} from "#/server/performance";

const DEFAULT_FILTERS = {
  subject: "items",
  metric: "points_hr",
  class: -1,
  minutes: 0,
} as const;

const CLASSES = [
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

const SUBJECT_LABELS: Record<Subject, string> = {
  items: "Items",
  combo2: "2-weapon",
  combo3: "3-weapon",
};

const METRIC_ORDER = Object.keys(METRICS) as MetricKey[];

/** lifetime-playtime slider stops (values = minutes thresholds) */
const HOURS_STOPS = [
  { value: 0, label: "All" },
  { value: 6_000, label: "100h+" },
  { value: 30_000, label: "500h+" },
  { value: 60_000, label: "1000h+" },
  { value: 120_000, label: "2000h+" },
  { value: 240_000, label: "4000h+" },
] as const;

export const Route = createFileRoute("/performance")({
  validateSearch: performanceFiltersSchema,
  search: { middlewares: [stripSearchParams(DEFAULT_FILTERS)] },
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) => {
    // Block navigation (SSR data / pending skeleton) only when no performance
    // query holds data yet. Filter changes on the page resolve instantly and
    // keep the old rows under a fetching overlay (keepPreviousData).
    const hasData = context.queryClient
      .getQueriesData({ queryKey: ["performance"] })
      .some(([, data]) => data !== undefined);
    const ensured = context.queryClient.ensureInfiniteQueryData(
      performanceInfiniteQueryOptions(deps),
    );
    if (!hasData) return ensured;
    ensured.catch(() => {});
    return undefined;
  },
  component: PerformancePage,
});

/** Stock items carry localization tokens when tf_english lacks them. */
function displayName(item: PerfItemInfo): string {
  if (item.itemName && !item.itemName.startsWith("#")) return item.itemName;
  const source = item.itemName?.slice(1) ?? item.name ?? String(item.defindex);
  return source
    .replace(/^TF_WEAPON_/i, "")
    .replaceAll("_", " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatMetric(value: number): string {
  return value.toLocaleString(undefined, {
    maximumFractionDigits: value >= 100 ? 0 : 1,
  });
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
  title,
}: {
  children: React.ReactNode;
  active: boolean;
  patch: SearchPatch;
  title?: string;
}) {
  return (
    <Link
      from={Route.fullPath}
      search={(prev) => ({ ...prev, ...patch })}
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

/** slider over discrete precomputed stops; drags snap, labels jump on click */
function StopSlider({
  stops,
  value,
  patch,
}: {
  stops: readonly { value: number; label: string }[];
  value: number;
  patch: (next: number) => SearchPatch;
}) {
  const navigate = Route.useNavigate();
  const committed = Math.max(
    0,
    stops.findIndex((s) => s.value === value),
  );
  const [dragging, setDragging] = useState<number | null>(null);
  const index = dragging ?? committed;
  const commit = (i: number) =>
    void navigate({ search: (prev) => ({ ...prev, ...patch(stops[i]?.value ?? 0) }) });
  return (
    <div className="w-72 pt-1">
      <Slider
        value={[index]}
        min={0}
        max={stops.length - 1}
        step={1}
        onValueChange={(v) => setDragging(Array.isArray(v) ? (v[0] ?? 0) : v)}
        onValueCommitted={(v) => {
          setDragging(null);
          commit(Array.isArray(v) ? (v[0] ?? 0) : v);
        }}
      />
      <div className="mt-1.5 flex justify-between">
        {stops.map((s, i) => (
          <button
            key={s.value}
            type="button"
            onClick={() => commit(i)}
            className={`cursor-pointer font-mono text-[10px] leading-none transition-colors first:text-left last:text-right ${
              i === index ? "font-semibold text-foreground" : "text-muted-foreground/70"
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function PerformancePage() {
  const search = Route.useSearch();
  const query = useInfiniteQuery({
    ...performanceInfiniteQueryOptions(search),
    placeholderData: keepPreviousData,
  });

  const rows = useMemo(() => query.data?.pages.flatMap((p) => p.rows) ?? [], [query.data]);
  // the ranked list is metric-desc, so row 0 is the ceiling for the dim bars
  const topValue = rows[0]?.value ?? 0;
  const metric = METRICS[search.metric];

  // infinite scroll: sentinel below the table pulls the next page into view
  const sentinelRef = useRef<HTMLDivElement>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasNextPage) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && !isFetchingNextPage) void fetchNextPage();
      },
      { rootMargin: "600px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  return (
    <div className="space-y-5">
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="font-heading text-2xl font-bold">Weapon performance</h1>
        <p className="max-w-md text-right text-[11px] text-muted-foreground">
          Correlational. Each value is the average {metric.label.toLowerCase()} of players who equip
          the item, not the weapon's isolated effect.
        </p>
      </div>

      <div className="space-y-3 rounded-lg border bg-card/50 p-4">
        <FilterRow label="Subject">
          <Segmented>
            {(Object.keys(SUBJECT_LABELS) as Subject[]).map((s) => (
              <Segment key={s} active={search.subject === s} patch={{ subject: s }}>
                {SUBJECT_LABELS[s]}
              </Segment>
            ))}
          </Segmented>
        </FilterRow>

        <FilterRow label="Metric">
          <Segmented>
            {METRIC_ORDER.map((key) => (
              <Segment key={key} active={search.metric === key} patch={{ metric: key }}>
                {METRICS[key].label}
              </Segment>
            ))}
          </Segmented>
        </FilterRow>

        <FilterRow label="Class">
          <Segmented>
            <Segment active={search.class === -1} patch={{ class: -1 }}>
              Overall
            </Segment>
            {CLASSES.map((c) => (
              <Segment
                key={c.num}
                active={search.class === c.num}
                patch={{ class: c.num }}
                title={c.label}
              >
                <img
                  src={`/${c.label}.svg`}
                  alt={c.label}
                  className={`h-4.5 w-4.5 ${search.class === c.num ? "" : "opacity-80"}`}
                />
              </Segment>
            ))}
          </Segmented>
        </FilterRow>

        <FilterRow label="Hours">
          <StopSlider
            stops={HOURS_STOPS}
            value={search.minutes}
            patch={(next) => ({ minutes: next })}
          />
          <span className="text-[11px] text-muted-foreground">min lifetime TF2 playtime</span>
        </FilterRow>
      </div>

      {rows.length === 0 && !query.isFetching ? (
        <p className="text-muted-foreground">
          No data yet for this filter combination. The crawler is warming up.
        </p>
      ) : (
        <div className="relative">
          <Table className="table-fixed">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-10 text-right">#</TableHead>
                <TableHead>{search.subject === "items" ? "Item" : "Combo"}</TableHead>
                <TableHead className="w-32 text-right">Sample</TableHead>
                <TableHead className="w-44 text-right">{metric.label}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row, index) => (
                <TableRow key={row.key} className="h-9">
                  <TableCell className="py-1 text-right font-mono text-muted-foreground">
                    {index + 1}
                  </TableCell>
                  <TableCell className="overflow-hidden py-1">
                    <Members members={row.members} />
                  </TableCell>
                  <TableCell className="py-1 text-right font-mono text-xs text-muted-foreground tabular-nums">
                    {row.players.toLocaleString()}
                    <span className="text-muted-foreground/50">
                      {" "}
                      · {Math.round(row.avgHours).toLocaleString()}h avg
                    </span>
                  </TableCell>
                  <TableCell className="py-1">
                    <MetricBar value={row.value} top={topValue} unit={metric.unit} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {query.isPlaceholderData && (
            <div className="absolute inset-0 z-10 flex items-start justify-center rounded-md bg-background/60 pt-24 backdrop-blur-[1px]">
              <div className="flex items-center gap-2 rounded-md border bg-card px-3 py-2 text-sm text-muted-foreground shadow-sm">
                <span className="size-4 animate-spin rounded-full border-2 border-muted-foreground/40 border-t-foreground" />
                Updating…
              </div>
            </div>
          )}
        </div>
      )}
      <div ref={sentinelRef} className="h-px" />
      {isFetchingNextPage && (
        <p className="py-2 text-center font-mono text-xs text-muted-foreground">loading more…</p>
      )}
    </div>
  );
}

function Members({ members }: { members: PerfItemInfo[] }) {
  return (
    <div className="flex items-center gap-2 overflow-hidden">
      <span className="flex shrink-0 gap-0.5">
        {members.map((m) => (
          <img
            key={m.defindex}
            src={m.imageUrl ?? ""}
            alt=""
            title={displayName(m)}
            className="h-7 w-7"
            loading="lazy"
          />
        ))}
      </span>
      <span className="overflow-hidden text-ellipsis whitespace-nowrap">
        {members.map((m, i) => (
          <span key={m.defindex}>
            {i > 0 && <span className="mx-1 text-muted-foreground/40">+</span>}
            <Link
              to="/item/$defindex"
              params={{ defindex: m.defindex }}
              className="hover:underline"
            >
              {displayName(m)}
            </Link>
          </span>
        ))}
      </span>
    </div>
  );
}

function MetricBar({ value, top, unit }: { value: number; top: number; unit: string }) {
  const pct = top > 0 ? (value / top) * 100 : 0;
  return (
    <div className="flex items-center justify-end gap-2">
      <div className="h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-secondary">
        <div
          className="h-full rounded-full bg-primary"
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
      <span className="w-24 shrink-0 text-right font-mono text-sm tabular-nums">
        {formatMetric(value)}
        <span className="ml-1 text-[10px] text-muted-foreground/60">{unit}</span>
      </span>
    </div>
  );
}
