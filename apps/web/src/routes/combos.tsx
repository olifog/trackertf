import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { createFileRoute, Link, stripSearchParams } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Slider } from "#/components/ui/slider";
import { Switch } from "#/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "#/components/ui/table";
import {
  type ComboMember,
  type ComboRow,
  comboFiltersSchema,
  combosInfiniteQueryOptions,
} from "#/server/combos";

const DEFAULT_FILTERS = {
  class: 1,
  size: 2,
  minutes: 0,
  minutesB: 240_000,
  compare: false,
  sort: "usage",
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

const ENGINEER = 9;

/** lifetime-playtime experience stops (values = minutes thresholds) */
const HOURS_STOPS = [
  { value: 0, label: "All" },
  { value: 6_000, label: "100h+" },
  { value: 30_000, label: "500h+" },
  { value: 60_000, label: "1000h+" },
  { value: 120_000, label: "2000h+" },
  { value: 240_000, label: "4000h+" },
] as const;

const HOURS_LABEL = new Map<number, string>(HOURS_STOPS.map((s) => [s.value, s.label]));

export const Route = createFileRoute("/combos")({
  validateSearch: comboFiltersSchema,
  search: { middlewares: [stripSearchParams(DEFAULT_FILTERS)] },
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) => {
    // Block navigation (SSR data / pending skeleton) only when no combos query
    // holds data yet. Filter changes on the page resolve instantly and keep the
    // old rows under a fetching overlay (keepPreviousData).
    const hasData = context.queryClient
      .getQueriesData({ queryKey: ["combos"] })
      .some(([, data]) => data !== undefined);
    const ensured = context.queryClient.ensureInfiniteQueryData(combosInfiniteQueryOptions(deps));
    if (!hasData) return ensured;
    ensured.catch(() => {});
    return undefined;
  },
  component: CombosPage,
});

/** Stock items carry localization tokens when tf_english lacks them. */
function displayName(item: ComboMember): string {
  if (item.itemName && !item.itemName.startsWith("#")) return item.itemName;
  const source = item.itemName?.slice(1) ?? item.name ?? String(item.defindex);
  return source
    .replace(/^TF_WEAPON_/i, "")
    .replaceAll("_", " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
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

function SwitchFilter({
  label,
  checked,
  patch,
}: {
  label: string;
  checked: boolean;
  patch: (next: boolean) => SearchPatch;
}) {
  const navigate = Route.useNavigate();
  return (
    <label className="flex cursor-pointer items-center gap-2 text-[13px] text-secondary-foreground">
      <Switch
        size="sm"
        checked={checked}
        onCheckedChange={(next) => navigate({ search: (prev) => ({ ...prev, ...patch(next) }) })}
      />
      {label}
    </label>
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
    <div className="w-64 pt-1">
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

function CombosPage() {
  const search = Route.useSearch();
  const query = useInfiniteQuery({
    ...combosInfiniteQueryOptions(search),
    placeholderData: keepPreviousData,
  });

  const pages = query.data?.pages;
  const rows = useMemo(() => pages?.flatMap((p) => p.rows) ?? [], [pages]);
  const first = pages?.[0];
  const popA = first?.popA ?? null;
  const popB = first?.popB ?? null;
  const compare = search.compare;
  // the server clamps size 4 to 3 off Engineer; reflect that in the picker too
  const effectiveSize = search.size === 4 && search.class !== ENGINEER ? 3 : search.size;

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
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="font-heading text-2xl font-bold">Weapon combos</h1>
          <p className="text-sm text-muted-foreground">
            Which weapons players run together, per class.
          </p>
        </div>
        {popA !== null && (
          <p className="font-mono text-xs text-muted-foreground">
            {compare ? (
              <>
                A: {popA.toLocaleString()} · B: {(popB ?? 0).toLocaleString()} players
              </>
            ) : (
              <>n = {popA.toLocaleString()} players</>
            )}
          </p>
        )}
      </div>

      <div className="space-y-3 rounded-lg border bg-card/50 p-4">
        <FilterRow label="Class">
          <Segmented>
            <Segment
              active={search.class === -1}
              patch={{ class: -1, ...(search.size === 4 ? { size: 3 } : {}) }}
              title="All classes (pooled)"
            >
              All
            </Segment>
            {CLASSES.map((c) => (
              <Segment
                key={c.num}
                active={search.class === c.num}
                patch={{
                  class: c.num,
                  ...(c.num !== ENGINEER && search.size === 4 ? { size: 3 } : {}),
                }}
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

        <FilterRow label="Size">
          <Segmented>
            <Segment active={effectiveSize === 2} patch={{ size: 2 }} title="Pairs">
              2
            </Segment>
            <Segment active={effectiveSize === 3} patch={{ size: 3 }} title="Triples">
              3
            </Segment>
            {search.class === ENGINEER && (
              <Segment active={effectiveSize === 4} patch={{ size: 4 }} title="Quads (Engineer)">
                4
              </Segment>
            )}
          </Segmented>
          <span className="text-[11px] text-muted-foreground">weapons run together</span>
        </FilterRow>

        <FilterRow label={compare ? "Exp. A" : "Exp."}>
          <StopSlider
            stops={HOURS_STOPS}
            value={search.minutes}
            patch={(next) => ({ minutes: next })}
          />
          <span className="text-[11px] text-muted-foreground">min lifetime TF2 playtime</span>
        </FilterRow>

        {compare && (
          <FilterRow label="Exp. B">
            <StopSlider
              stops={HOURS_STOPS}
              value={search.minutesB}
              patch={(next) => ({ minutesB: next })}
            />
            <span className="text-[11px] text-muted-foreground">compared against group A</span>
          </FilterRow>
        )}

        <FilterRow label="Options">
          <SwitchFilter
            label="Compare experience"
            checked={compare}
            patch={(next) => ({ compare: next, sort: next ? "delta" : "usage" })}
          />
          {compare && (
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-muted-foreground">Sort</span>
              <Segmented>
                <Segment active={search.sort === "delta"} patch={{ sort: "delta" }}>
                  Biggest delta
                </Segment>
                <Segment active={search.sort === "usage"} patch={{ sort: "usage" }}>
                  Usage (A)
                </Segment>
              </Segmented>
            </div>
          )}
        </FilterRow>
      </div>

      {rows.length === 0 && !query.isFetching ? (
        <p className="text-muted-foreground">
          No combos yet for this filter combination. The crawler is warming up.
        </p>
      ) : (
        <div className="relative">
          <Table className="table-fixed">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-10 text-right">#</TableHead>
                <TableHead>Combo</TableHead>
                {compare ? (
                  <>
                    <TableHead className="w-40 text-right">
                      A · {HOURS_LABEL.get(search.minutes) ?? "All"}
                    </TableHead>
                    <TableHead className="w-40 text-right">
                      B · {HOURS_LABEL.get(search.minutesB) ?? "All"}
                    </TableHead>
                    <TableHead className="w-24 text-right">Delta</TableHead>
                  </>
                ) : (
                  <>
                    <TableHead className="w-20 text-right">Players</TableHead>
                    <TableHead className="w-38 text-right">Usage</TableHead>
                  </>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row, index) => (
                <ComboRowView
                  key={row.gids.join("-")}
                  row={row}
                  rank={index + 1}
                  compare={compare}
                />
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

function ComboMembers({ members }: { members: ComboMember[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-1 gap-y-1">
      {members.map((m, i) => (
        <span key={m.defindex} className="flex items-center gap-1">
          {i > 0 && <span className="mr-1 font-mono text-muted-foreground/40">+</span>}
          {m.imageUrl && <img src={m.imageUrl} alt="" className="h-6 w-6" loading="lazy" />}
          <Link
            to="/item/$defindex"
            params={{ defindex: m.defindex }}
            className="text-[13px] hover:underline"
          >
            {displayName(m)}
          </Link>
        </span>
      ))}
    </div>
  );
}

function ComboRowView({ row, rank, compare }: { row: ComboRow; rank: number; compare: boolean }) {
  return (
    <TableRow className="h-9">
      <TableCell className="py-1 text-right font-mono text-muted-foreground">{rank}</TableCell>
      <TableCell className="overflow-hidden py-1">
        <ComboMembers members={row.members} />
      </TableCell>
      {compare ? (
        <>
          <TableCell className="py-1">
            <UsagePct usage={row.usageA} count={row.countA} />
          </TableCell>
          <TableCell className="py-1">
            <UsagePct usage={row.usageB ?? 0} count={row.countB ?? 0} />
          </TableCell>
          <TableCell className="py-1 text-right">
            <DeltaCell delta={row.delta ?? 0} />
          </TableCell>
        </>
      ) : (
        <>
          <TableCell className="py-1 text-right font-mono text-xs text-muted-foreground tabular-nums">
            {row.countA.toLocaleString()}
          </TableCell>
          <TableCell className="py-1">
            <UsagePct usage={row.usageA} />
          </TableCell>
        </>
      )}
    </TableRow>
  );
}

/** usage percentage, plus the raw player count in compare mode (no bar — the
 * bars overlapped the labels and were near-empty for most combos) */
function UsagePct({ usage, count }: { usage: number; count?: number }) {
  return (
    <div className="flex items-center justify-end gap-3 font-mono tabular-nums">
      <span className="text-sm">{(usage * 100).toFixed(1)}%</span>
      {count !== undefined && (
        <span className="w-14 shrink-0 text-right text-[11px] text-muted-foreground/60">
          {count.toLocaleString()}
        </span>
      )}
    </div>
  );
}

function DeltaCell({ delta }: { delta: number }) {
  const pp = delta * 100;
  const sign = pp > 0 ? "+" : "";
  const color =
    pp > 0.05 ? "text-chart-2" : pp < -0.05 ? "text-destructive" : "text-muted-foreground";
  return (
    <span className={`font-mono text-sm tabular-nums ${color}`}>
      {sign}
      {pp.toFixed(1)}
      <span className="ml-0.5 text-[10px] text-muted-foreground/60">pp</span>
    </span>
  );
}
