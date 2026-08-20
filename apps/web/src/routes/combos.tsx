import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { createFileRoute, Link, stripSearchParams } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { bySlot } from "#/lib/slots";
import { formatPValue, type ProportionTest, twoProportionZTest } from "#/lib/stats";
import { FilterRow, Segmented } from "#/components/ui/filter-bar";
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
  minutes: 6_000,
  minutesB: 120_000,
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

/**
 * Stock/default weapon group ids (mirror of STOCK_ITEMS in
 * apps/crawler/src/parse.ts, PDA/builder entries dropped since those never
 * reach a combo). weapon_gids stores the reskin-collapsed cgid, and stock
 * melees fold to the per-class pan cgid 0-8 — which are exactly the melee
 * defindexes listed here — so a stock weapon's cgid equals its defindex. A
 * combo whose every member is in this set is all-stock: high-hour bot/idle
 * accounts that equip nothing inflate the stock population, so its share and
 * (especially) its compare-mode delta are unreliable.
 */
const STOCK_GIDS = new Set([
  13, 23, 0, 14, 16, 3, 18, 10, 6, 19, 20, 1, 17, 29, 8, 15, 11, 5, 21, 12, 2, 24, 4, 30, 9, 22, 7,
]);

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
    <div className="w-full max-w-72 pt-1">
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

  const [filter, setFilter] = useState("");
  const pages = query.data?.pages;
  const rows = useMemo(() => pages?.flatMap((p) => p.rows) ?? [], [pages]);
  const first = pages?.[0];
  const popA = first?.popA ?? null;
  const popB = first?.popB ?? null;
  const compare = search.compare;
  // the server clamps size 4 to 3 (no class has 4 non-PDA weapon slots)
  const effectiveSize = search.size === 4 ? 3 : search.size;

  // client-side name search: keep a combo if ANY of its items matches
  const needle = filter.trim().toLowerCase();
  const visibleRows = useMemo(
    () =>
      needle
        ? rows.filter((r) =>
            r.members.some(
              (m) =>
                displayName(m).toLowerCase().includes(needle) ||
                (m.name ?? "").toLowerCase().includes(needle) ||
                String(m.defindex).includes(needle),
            ),
          )
        : rows,
    [rows, needle],
  );

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
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
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
            <Segment active={search.class === -1} patch={{ class: -1 }} title="All classes (pooled)">
              All
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

        <FilterRow label="Size">
          <Segmented>
            <Segment active={effectiveSize === 2} patch={{ size: 2 }} title="Pairs">
              2
            </Segment>
            <Segment active={effectiveSize === 3} patch={{ size: 3 }} title="Triples">
              3
            </Segment>
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

        <FilterRow label="Search">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="item name / schema name / defindex…"
            className="h-8 w-64 rounded-md border bg-secondary/40 px-2 font-mono text-xs outline-none placeholder:text-muted-foreground/60 focus:border-ring"
          />
        </FilterRow>

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

      {(search.minutes === 240_000 || search.minutesB === 240_000) && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[13px] text-amber-200/90">
          The 4000h+ bucket skews heavily toward idle and bot accounts, which
          barely change loadouts — its shares aren't representative of how the
          weapon is actually played. Prefer 100h+ → 2000h+ for meaningful
          comparisons.
        </div>
      )}

      {visibleRows.length === 0 && !query.isFetching ? (
        <p className="text-muted-foreground">
          {needle
            ? "No combos match that search."
            : "No combos yet for this filter combination. The crawler is warming up."}
        </p>
      ) : (
        <div className="relative">
          <Table className="md:table-fixed">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-10 text-right">#</TableHead>
                <TableHead className="min-w-[9rem]">Combo</TableHead>
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
              {visibleRows.map((row, index) => (
                <ComboRowView
                  key={row.gids.join("-")}
                  row={row}
                  rank={index + 1}
                  compare={compare}
                  popA={popA}
                  popB={popB}
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
  // order items by canonical slot so both pages read the same left-to-right
  const ordered = bySlot(members);
  return (
    <div className="flex flex-wrap items-center gap-x-1 gap-y-1">
      {ordered.map((m, i) => (
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

function ComboRowView({
  row,
  rank,
  compare,
  popA,
  popB,
}: {
  row: ComboRow;
  rank: number;
  compare: boolean;
  popA: number | null;
  popB: number | null;
}) {
  const allStock = row.gids.length > 0 && row.gids.every((g) => STOCK_GIDS.has(g));
  // two-proportion z-test on the raw per-bucket player counts vs each bucket's
  // population — flags deltas that are pure sampling noise (ns).
  const test: ProportionTest | undefined =
    compare && popA != null && popB != null
      ? twoProportionZTest(row.countA, popA, row.countB ?? 0, popB)
      : undefined;
  return (
    <TableRow className={`h-9 ${allStock ? "bg-amber-500/[0.06] hover:bg-amber-500/[0.12]" : ""}`}>
      <TableCell className="py-1 text-right font-mono text-muted-foreground">{rank}</TableCell>
      <TableCell className="overflow-hidden py-1">
        <div className="flex items-center gap-2">
          <ComboMembers members={row.members} />
          {allStock && <StockBadge />}
        </div>
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
            <DeltaCell delta={row.delta ?? 0} test={test} popA={popA} popB={popB} />
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

/** small tinted badge warning that an all-stock combo's stats are unreliable */
function StockBadge() {
  return (
    <span
      title="All-stock combo. High-hour bot/idle accounts that never equip anything inflate the high-experience stock population, so this combo's share — and especially its compare-mode delta — is unreliable."
      className="inline-flex shrink-0 items-center rounded border border-amber-500/30 bg-amber-500/10 px-1 py-0.5 font-mono text-[10px] leading-none text-amber-600 dark:text-amber-400"
    >
      ⚠ stock
    </span>
  );
}

/** A-vs-B delta in percentage points. In compare mode a two-proportion z-test
 * decides whether the shift is real: non-significant deltas are greyed and
 * tagged "ns" (up/down coloring is reserved for significant ones); the tooltip
 * carries the p-value and both buckets' sample sizes. */
function DeltaCell({
  delta,
  test,
  popA,
  popB,
}: {
  delta: number;
  test?: ProportionTest | undefined;
  popA?: number | null;
  popB?: number | null;
}) {
  const pp = delta * 100;
  const sign = pp > 0 ? "+" : "";
  const significant = test ? test.significant : true;
  const color = !significant
    ? "text-muted-foreground/50"
    : pp > 0.05
      ? "text-chart-2"
      : pp < -0.05
        ? "text-destructive"
        : "text-muted-foreground";
  const title = test
    ? `${formatPValue(test.pValue, test.significant)} · A n=${(popA ?? 0).toLocaleString()} · B n=${(popB ?? 0).toLocaleString()}`
    : undefined;
  return (
    <span className={`font-mono text-sm tabular-nums ${color}`} title={title}>
      {sign}
      {pp.toFixed(1)}
      <span className="ml-0.5 text-[10px] text-muted-foreground/60">pp</span>
      {test && !test.significant && (
        <span className="ml-1 text-[10px] tracking-wide text-muted-foreground/60 uppercase">
          ns
        </span>
      )}
    </span>
  );
}
