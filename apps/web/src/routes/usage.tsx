import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, stripSearchParams } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
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
import { formatPValue, twoProportionZTest } from "#/lib/stats";
import {
  DELTA_PERIODS,
  type DeltaPeriod,
  type UsageDelta,
  type UsageRow,
  usageDeltasQueryOptions,
  usageFiltersSchema,
  usageInfiniteQueryOptions,
} from "#/server/usage";

const DEFAULT_FILTERS = {
  class: -1,
  slot: -1,
  active: 0,
  minutes: 0,
  minutesB: 240_000,
  merge: true,
  pdas: false,
  xp: false,
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

const SLOTS = [
  { num: 0, label: "Primary" },
  { num: 1, label: "Secondary" },
  { num: 2, label: "Melee" },
  { num: 5, label: "PDA" },
  { num: 6, label: "Watch" },
  { num: 7, label: "Cosmetic" },
  { num: 8, label: "Taunt" },
] as const;

/** lifetime-playtime slider stops (values = minutes thresholds) */
const HOURS_STOPS = [
  { value: 0, label: "All" },
  { value: 30_000, label: "500h+" },
  { value: 60_000, label: "1000h+" },
  { value: 120_000, label: "2000h+" },
  { value: 240_000, label: "4000h+" },
] as const;

const HOURS_LABEL = new Map<number, string>(HOURS_STOPS.map((s) => [s.value, s.label]));

/** experience-compare needs a concrete class + slot; used when toggling it on from "Any" */
const COMPARE_DEFAULT_CLASS = 1;
const COMPARE_DEFAULT_SLOT = 0;

/** minutes-in-last-2-weeks slider stops */
const ACTIVE_STOPS = [
  { value: 0, label: "All" },
  { value: 1, label: "Played" },
  { value: 300, label: "5h+" },
  { value: 900, label: "15h+" },
] as const;

const CLASS_ICONS: Record<number, string> = {
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

const SLOT_DISPLAY: Record<string, string> = {
  primary: "Primary",
  secondary: "Secondary",
  melee: "Melee",
  pda: "PDA",
  pda2: "PDA2",
  building: "Building",
  misc: "Cosmetic",
  head: "Cosmetic",
  taunt: "Taunt",
  action: "Action",
};

/** stock melee defindexes per class; the pan family folds into these on
 * class-specific views (matching the analyser's class-aware merge) */
const STOCK_MELEES = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8]);
const PAN_GROUP = 264;

/** derive what kind of duplicate a variant defindex is from its schema name */
function variantKind(v: UsageRow): string | null {
  const n = v.name ?? "";
  if (/^TF_WEAPON_/i.test(n) || n.startsWith("Upgradeable TF_WEAPON_")) {
    return n.startsWith("Upgradeable") ? "renamed / strange" : "stock";
  }
  if (/botkiller/i.test(n)) return "botkiller";
  if (/^Festive/i.test(n)) return "festive";
  if (/australium/i.test(n)) return "australium";
  if (/^[a-z0-9_]+$/.test(n)) return "warpaint";
  return null;
}

/** PDA/builder pseudo-items every player of a class "equips" (~100% rows). */
const PDA_NAMES = new Set([
  "TF_WEAPON_PDA_ENGINEER_BUILD",
  "TF_WEAPON_PDA_ENGINEER_DESTROY",
  "TF_WEAPON_PDA_SPY",
  "TF_WEAPON_BUILDER",
  "TF_WEAPON_BUILDER_SPY",
]);

export const Route = createFileRoute("/usage")({
  validateSearch: usageFiltersSchema,
  search: { middlewares: [stripSearchParams(DEFAULT_FILTERS)] },
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) => {
    // Block navigation (SSR data / pending skeleton) only when no usage query
    // holds data yet. Filter changes on the page resolve instantly and keep
    // the old rows under a fetching overlay (keepPreviousData).
    const hasData = context.queryClient
      .getQueriesData({ queryKey: ["usage"] })
      .some(([, data]) => data !== undefined);
    const ensured = context.queryClient.ensureInfiniteQueryData(usageInfiniteQueryOptions(deps));
    if (!hasData) return ensured;
    ensured.catch(() => {});
    return undefined;
  },
  component: UsagePage,
});

/** Stock items carry localization tokens when tf_english lacks them. */
function displayName(item: UsageRow): string {
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

/** Switch bound to local component state (display overlay, not a URL filter). */
function LocalSwitch({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-[13px] text-secondary-foreground">
      <Switch size="sm" checked={checked} onCheckedChange={onChange} />
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

function UsagePage() {
  const search = Route.useSearch();
  const query = useInfiniteQuery({
    ...usageInfiniteQueryOptions(search),
    placeholderData: keepPreviousData,
  });
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const [filter, setFilter] = useState("");
  // Display overlays (local, not URL): they don't change the usage query.
  const [compare, setCompare] = useState(false);
  const [comparePeriod, setComparePeriod] = useState<DeltaPeriod>(7);

  // The experience-compare view (URL filter) owns the table; the local
  // time-compare overlay is mutually exclusive with it.
  const xp = search.xp;
  const showCompare = compare && !xp;

  // Deltas are only tracked for the default headline view.
  const isHeadline =
    search.class === -1 &&
    search.slot === -1 &&
    search.active === 0 &&
    search.minutes === 0 &&
    search.merge;

  const deltaQuery = useQuery({
    ...usageDeltasQueryOptions(comparePeriod),
    enabled: showCompare && isHeadline,
  });
  const deltaByDef = useMemo(() => {
    const m = new Map<number, UsageDelta>();
    for (const d of deltaQuery.data?.deltas ?? []) m.set(d.defindex, d);
    return m;
  }, [deltaQuery.data]);

  const pages = query.data?.pages;
  const rows = useMemo(() => pages?.flatMap((p) => p.rows) ?? [], [pages]);
  const variantsByGroup = useMemo(() => {
    const map = new Map<number, UsageRow[]>();
    for (const v of pages?.[0]?.variants ?? []) {
      if (v.reskinGroup === null) continue;
      const list = map.get(v.reskinGroup);
      if (list) list.push(v);
      else map.set(v.reskinGroup, [v]);
    }
    return map;
  }, [pages]);

  const needle = filter.trim().toLowerCase();
  const items = rows.filter(
    (r) =>
      (search.pdas || !PDA_NAMES.has(r.name ?? "")) &&
      (!needle ||
        displayName(r).toLowerCase().includes(needle) ||
        (r.name ?? "").toLowerCase().includes(needle) ||
        String(r.defindex).includes(needle)),
  );
  const sample = pages?.[0]?.sampleSize;
  const computedAt = pages?.[0]?.computedAt;
  const popA = pages?.[0]?.popA ?? null;
  const popB = pages?.[0]?.popB ?? null;

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

  function toggleExpand(defindex: number): void {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(defindex)) next.delete(defindex);
      else next.add(defindex);
      return next;
    });
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h1 className="font-heading text-2xl font-bold">Weapon usage</h1>
        {xp ? (
          popA !== null && (
            <p className="font-mono text-xs text-muted-foreground">
              low: {popA.toLocaleString()} · high: {(popB ?? 0).toLocaleString()} players
            </p>
          )
        ) : sample !== null && sample !== undefined ? (
          <p className="font-mono text-xs text-muted-foreground">
            n = {sample.toLocaleString()} players
            {computedAt && <span suppressHydrationWarning> · updated {formatAgo(computedAt)}</span>}
          </p>
        ) : null}
      </div>

      <div className="space-y-3 rounded-lg border bg-card/50 p-4">
        <FilterRow label="Class">
          <Segmented>
            {!xp && (
              <Segment active={search.class === -1} patch={{ class: -1 }}>
                Any
              </Segment>
            )}
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

        <FilterRow label="Slot">
          <Segmented>
            {!xp && (
              <Segment active={search.slot === -1} patch={{ slot: -1 }}>
                Any
              </Segment>
            )}
            {SLOTS.map((s) => (
              <Segment key={s.num} active={search.slot === s.num} patch={{ slot: s.num }}>
                {s.label}
              </Segment>
            ))}
          </Segmented>
        </FilterRow>

        <FilterRow label={xp ? "Exp. low" : "Hours"}>
          <StopSlider
            stops={HOURS_STOPS}
            value={search.minutes}
            patch={(next) => ({ minutes: next })}
          />
          <span className="text-[11px] text-muted-foreground">
            {xp ? "less-experienced players" : "lifetime TF2 playtime"}
          </span>
        </FilterRow>

        {xp && (
          <FilterRow label="Exp. high">
            <StopSlider
              stops={HOURS_STOPS}
              value={search.minutesB}
              patch={(next) => ({ minutesB: next })}
            />
            <span className="text-[11px] text-muted-foreground">experienced players</span>
          </FilterRow>
        )}

        {!xp && (
          <FilterRow label="Active">
            <StopSlider
              stops={ACTIVE_STOPS}
              value={search.active}
              patch={(next) => ({ active: next })}
            />
            <span className="text-[11px] text-muted-foreground">played in the last 2 weeks</span>
          </FilterRow>
        )}

        <FilterRow label="Search">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="name / schema name / defindex…"
            className="h-8 w-64 rounded-md border bg-secondary/40 px-2 font-mono text-xs outline-none placeholder:text-muted-foreground/60 focus:border-ring"
          />
        </FilterRow>

        <FilterRow label="Options">
          {!xp && (
            <SwitchFilter
              label="Merge reskins & stranges"
              checked={search.merge}
              patch={(next) => ({ merge: next })}
            />
          )}
          <SwitchFilter
            label="Hide PDAs"
            checked={!search.pdas}
            patch={(next) => ({ pdas: !next })}
          />
          <SwitchFilter
            label="Compare experience"
            checked={xp}
            patch={(next) => ({
              xp: next,
              sort: next ? "delta" : "usage",
              // the delta view needs a concrete class + slot; promote "Any"
              ...(next && search.class === -1 ? { class: COMPARE_DEFAULT_CLASS } : {}),
              ...(next && search.slot === -1 ? { slot: COMPARE_DEFAULT_SLOT } : {}),
            })}
          />
          {!xp && <LocalSwitch label="Compare usage" checked={compare} onChange={setCompare} />}
          {!xp && compare && (
            <div className="inline-flex divide-x divide-border overflow-hidden rounded-md border">
              {DELTA_PERIODS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setComparePeriod(p)}
                  className={`flex h-7 items-center px-2 font-mono text-[11px] leading-none transition-colors ${
                    comparePeriod === p
                      ? "bg-primary font-medium text-primary-foreground"
                      : "bg-secondary/40 text-secondary-foreground hover:bg-accent"
                  }`}
                >
                  {p}d
                </button>
              ))}
            </div>
          )}
          {xp && (
            <Segmented>
              <Segment active={search.sort === "delta"} patch={{ sort: "delta" }}>
                Biggest delta
              </Segment>
              <Segment active={search.sort === "usage"} patch={{ sort: "usage" }}>
                Usage high
              </Segment>
            </Segmented>
          )}
        </FilterRow>
      </div>

      {xp && (
        <p className="text-xs text-muted-foreground">
          Adoption among <span className="text-foreground">less-experienced</span> vs{" "}
          <span className="text-foreground">experienced</span> players for this class + slot: the
          share of each group who equip the item, and the percentage-point delta between them.
          Positive deltas are items veterans favour. Grouped by reskin family over the equip corpus,
          independent of recent activity.
        </p>
      )}
      {showCompare && !isHeadline && (
        <p className="text-xs text-muted-foreground">
          Deltas are tracked for the default view only — reset Class, Slot, Hours and Active to
          "Any"/"All" (merged) to compare.
        </p>
      )}
      {showCompare && isHeadline && deltaQuery.data && !deltaQuery.data.enoughHistory && (
        <p className="text-xs text-muted-foreground">
          Deltas accrue daily
          {deltaQuery.data.comparisonDay && <> — first snapshot {deltaQuery.data.comparisonDay}</>}.
          Check back in a few days.
        </p>
      )}
      {showCompare && isHeadline && deltaQuery.data?.enoughHistory && (
        <p className="text-xs text-muted-foreground">
          Usage change vs {deltaQuery.data.comparisonDay} ({deltaQuery.data.days}d), in percentage
          points.
        </p>
      )}

      {items.length === 0 && !query.isFetching ? (
        <p className="text-muted-foreground">
          No data yet for this filter combination. The crawler is warming up.
        </p>
      ) : (
        <div className="relative">
          <Table className="md:table-fixed">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-10 text-right">#</TableHead>
                <TableHead className="w-9" />
                <TableHead className="min-w-[9rem]">Item</TableHead>
                {!xp && search.class === -1 && (
                  <TableHead className="hidden w-27 sm:table-cell">Classes</TableHead>
                )}
                {!xp && search.slot === -1 && (
                  <TableHead className="hidden w-22 sm:table-cell">Slot</TableHead>
                )}
                {xp ? (
                  <>
                    <TableHead className="w-40 text-right">
                      Low<span className="text-muted-foreground/50"> · {HOURS_LABEL.get(search.minutes)}</span>
                    </TableHead>
                    <TableHead className="w-40 text-right">
                      High<span className="text-muted-foreground/50"> · {HOURS_LABEL.get(search.minutesB)}</span>
                    </TableHead>
                    <TableHead className="w-24 text-right">Delta</TableHead>
                  </>
                ) : (
                  <>
                    <TableHead className="w-18 text-right">Players</TableHead>
                    <TableHead className="w-38 text-right">Usage</TableHead>
                  </>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {xp
                ? items.map((item, index) => (
                    <DeltaRow key={item.defindex} item={item} rank={index + 1} />
                  ))
                : items.map((item, index) => {
                let variants =
                  search.merge && item.reskinGroup !== null
                    ? (variantsByGroup.get(item.reskinGroup) ?? [])
                    : [];
                // class views fold the pan family into the class's stock melee
                if (search.merge && search.class !== -1 && STOCK_MELEES.has(item.defindex)) {
                  variants = [...variants, ...(variantsByGroup.get(PAN_GROUP) ?? [])];
                }
                // a lone variant that IS the parent row adds nothing
                const expandable =
                  variants.length > 1 ||
                  (variants.length === 1 && variants[0]?.defindex !== item.defindex);
                const isOpen = expandable && expanded.has(item.defindex);
                return (
                  <ItemRows
                    key={item.defindex}
                    item={item}
                    rank={index + 1}
                    variants={variants}
                    expandable={expandable}
                    isOpen={isOpen}
                    onToggle={() => toggleExpand(item.defindex)}
                    showClasses={search.class === -1}
                    showSlot={search.slot === -1}
                    delta={
                      showCompare && isHeadline ? deltaByDef.get(item.defindex) : undefined
                    }
                  />
                );
              })}
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

function ItemName({ item, dim }: { item: UsageRow; dim?: boolean }) {
  return (
    <span className={dim ? "text-[13px] text-muted-foreground" : ""}>
      <Link
        to="/item/$defindex"
        params={{ defindex: item.defindex }}
        className="hover:underline"
        onClick={(e) => e.stopPropagation()}
      >
        {displayName(item)}
      </Link>
      <span className="ml-1.5 font-mono text-[11px] text-muted-foreground/50">
        #{item.defindex}
      </span>
    </span>
  );
}

function ClassIcons({ classes }: { classes: number[] | null }) {
  if (!classes) return null;
  if (classes.length === 9) {
    return <span className="text-[11px] text-muted-foreground">All classes</span>;
  }
  return (
    <span className="flex gap-0.5">
      {classes.map((c) => {
        const label = CLASS_ICONS[c];
        return label ? (
          <img
            key={c}
            src={`/${label}.svg`}
            alt={label}
            title={label}
            className="h-3.5 w-3.5 opacity-70"
          />
        ) : null;
      })}
    </span>
  );
}

function ItemRows({
  item,
  rank,
  variants,
  expandable,
  isOpen,
  onToggle,
  showClasses,
  showSlot,
  delta,
}: {
  item: UsageRow;
  rank: number;
  variants: UsageRow[];
  expandable: boolean;
  isOpen: boolean;
  onToggle: () => void;
  showClasses: boolean;
  showSlot: boolean;
  delta?: UsageDelta | undefined;
}) {
  const extraCols = (showClasses ? 1 : 0) + (showSlot ? 1 : 0);
  return (
    <>
      <TableRow
        className={`h-9 ${expandable ? "cursor-pointer" : ""}`}
        onClick={expandable ? onToggle : undefined}
      >
        <TableCell className="py-1 text-right font-mono text-muted-foreground">{rank}</TableCell>
        <TableCell className="py-0.5">
          {item.imageUrl && <img src={item.imageUrl} alt="" className="h-7 w-7" loading="lazy" />}
        </TableCell>
        <TableCell className="overflow-hidden py-1 text-ellipsis">
          <ItemName item={item} />
          {expandable && (
            <span className="ml-1.5 font-mono text-[11px] text-primary/70">
              {isOpen ? "▾" : "▸"} {variants.length}{" "}
              {variants.length === 1 ? "variant" : "variants"}
            </span>
          )}
        </TableCell>
        {showClasses && (
          <TableCell className="hidden py-1 sm:table-cell">
            <ClassIcons classes={item.usedByClasses} />
          </TableCell>
        )}
        {showSlot && (
          <TableCell className="hidden overflow-hidden py-1 text-xs text-ellipsis text-muted-foreground sm:table-cell">
            {item.slotName ? (SLOT_DISPLAY[item.slotName] ?? item.slotName) : ""}
          </TableCell>
        )}
        <TableCell className="py-1 text-right font-mono text-xs text-muted-foreground tabular-nums">
          {item.count.toLocaleString()}
        </TableCell>
        <TableCell className="py-1">
          <div className="flex items-center justify-end gap-2">
            {delta && <DeltaBadge d={delta} />}
            <UsageBar usage={item.usage} />
          </div>
        </TableCell>
      </TableRow>
      {isOpen &&
        variants.map((v) => (
          <TableRow key={v.defindex} className="h-8 bg-secondary/20 hover:bg-secondary/30">
            <TableCell className="py-0.5" />
            <TableCell className="py-0.5 text-right">
              {v.imageUrl && (
                <img src={v.imageUrl} alt="" className="ml-auto h-5 w-5" loading="lazy" />
              )}
            </TableCell>
            <TableCell
              className="overflow-hidden py-0.5 pl-6 text-ellipsis"
              colSpan={1 + extraCols}
            >
              <ItemName item={v} dim />
              {variantKind(v) && (
                <span className="ml-2 rounded bg-secondary/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                  {variantKind(v)}
                </span>
              )}
            </TableCell>
            <TableCell className="py-0.5 text-right font-mono text-xs text-muted-foreground/70 tabular-nums">
              {v.count.toLocaleString()}
            </TableCell>
            <TableCell className="py-0.5">
              <UsageBar usage={v.usage} dim />
            </TableCell>
          </TableRow>
        ))}
    </>
  );
}

function UsageBar({ usage, dim }: { usage: number; dim?: boolean }) {
  return (
    <div className="flex items-center justify-end gap-2">
      <div
        className={`h-1.5 shrink-0 overflow-hidden rounded-full bg-secondary ${dim ? "w-16" : "w-20"}`}
      >
        <div
          className={`h-full rounded-full ${dim ? "bg-chart-2/60" : "bg-primary"}`}
          style={{ width: `${Math.min(usage * 100, 100)}%` }}
        />
      </div>
      <span
        className={`w-14 shrink-0 text-right font-mono tabular-nums ${dim ? "text-xs text-muted-foreground" : "text-sm"}`}
      >
        {(usage * 100).toFixed(1)}%
      </span>
    </div>
  );
}

/**
 * Signed week-over-week usage change, in percentage points. A two-proportion
 * z-test (shared helper) over the raw equip counts / population sizes decides
 * whether the shift is real: significant deltas get full up/down coloring,
 * non-significant ones are greyed with an "ns" tag so tiny-sample or
 * bot-inflated noise can't masquerade as a trend. The p-value and both
 * count/population pairs live in the tooltip.
 */
function DeltaBadge({ d }: { d: UsageDelta }) {
  const test = twoProportionZTest(d.countNow, d.sampleSizeNow, d.countThen, d.sampleSizeThen);
  const pp = d.delta * 100;
  const arrow = d.delta > 0 ? "▲" : d.delta < 0 ? "▼" : "–";
  const title =
    `${formatPValue(test.pValue, test.significant)} · ` +
    `now ${d.countNow.toLocaleString()}/${d.sampleSizeNow.toLocaleString()} · ` +
    `then ${d.countThen.toLocaleString()}/${d.sampleSizeThen.toLocaleString()}`;
  if (!test.significant) {
    return (
      <span
        title={title}
        className="flex items-center gap-1 font-mono text-[11px] text-muted-foreground/50 tabular-nums"
      >
        {arrow}
        {Math.abs(pp).toFixed(2)}
        <span className="text-[9px] tracking-wider uppercase">ns</span>
      </span>
    );
  }
  return (
    <span
      title={title}
      className={`font-mono text-[11px] tabular-nums ${d.delta > 0 ? "text-emerald-400" : "text-red-400"}`}
    >
      {arrow}
      {Math.abs(pp).toFixed(2)}
    </span>
  );
}

/** One population's adoption bar in the experience-compare table (low or high). */
function CompareBar({ usage, count }: { usage: number; count: number }) {
  return (
    <div
      className="flex items-center justify-end gap-2"
      title={`${count.toLocaleString()} players`}
    >
      <div className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-secondary">
        <div
          className="h-full rounded-full bg-primary"
          style={{ width: `${Math.min(usage * 100, 100)}%` }}
        />
      </div>
      <span className="w-12 shrink-0 text-right font-mono text-sm tabular-nums">
        {(usage * 100).toFixed(1)}%
      </span>
    </div>
  );
}

/**
 * Low-vs-high adoption gap in percentage points. Positive (veterans favour it)
 * is chart-2, negative is destructive, near-zero is muted so noise reads flat.
 */
function DeltaCell({ delta }: { delta: number }) {
  const pp = delta * 100;
  const color =
    Math.abs(pp) < 0.05 ? "text-muted-foreground" : pp > 0 ? "text-chart-2" : "text-destructive";
  return (
    <span className={`font-mono text-sm tabular-nums ${color}`}>
      {pp > 0 ? "+" : ""}
      {pp.toFixed(1)}
      <span className="ml-0.5 text-[10px] text-muted-foreground/60">pp</span>
    </span>
  );
}

/** One item row in the experience-compare view: low usage, high usage, delta. */
function DeltaRow({ item, rank }: { item: UsageRow; rank: number }) {
  return (
    <TableRow className="h-9">
      <TableCell className="py-1 text-right font-mono text-muted-foreground">{rank}</TableCell>
      <TableCell className="py-0.5">
        {item.imageUrl && <img src={item.imageUrl} alt="" className="h-7 w-7" loading="lazy" />}
      </TableCell>
      <TableCell className="overflow-hidden py-1 text-ellipsis">
        <ItemName item={item} />
      </TableCell>
      <TableCell className="py-1">
        <CompareBar usage={item.usage} count={item.count} />
      </TableCell>
      <TableCell className="py-1">
        <CompareBar usage={item.usageB ?? 0} count={item.countB ?? 0} />
      </TableCell>
      <TableCell className="py-1 text-right">
        <DeltaCell delta={item.delta ?? 0} />
      </TableCell>
    </TableRow>
  );
}

function formatAgo(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}
