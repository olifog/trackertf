import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, stripSearchParams } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Switch } from "#/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "#/components/ui/table";
import { type UsageRow, usageFiltersSchema, usageQueryOptions } from "#/server/usage";

const DEFAULT_FILTERS = {
  class: -1,
  slot: -1,
  active: false,
  minutes: 0,
  merge: true,
  pdas: false,
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
  { num: 3, label: "Disguise Kit" },
  { num: 4, label: "Sapper" },
  { num: 5, label: "Constr. PDA" },
  { num: 6, label: "Watch" },
  { num: 7, label: "Cosmetic" },
  { num: 8, label: "Taunt" },
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
  if (/^TF_WEAPON_/i.test(n) || /^Upgradeable TF_WEAPON_/.test(n)) {
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
  loader: ({ context, deps }) => context.queryClient.ensureQueryData(usageQueryOptions(deps)),
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

function UsagePage() {
  const search = Route.useSearch();
  const { data } = useSuspenseQuery(usageQueryOptions(search));
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());

  const variantsByGroup = useMemo(() => {
    const map = new Map<number, UsageRow[]>();
    for (const v of data.variants) {
      if (v.reskinGroup === null) continue;
      const list = map.get(v.reskinGroup);
      if (list) list.push(v);
      else map.set(v.reskinGroup, [v]);
    }
    return map;
  }, [data.variants]);

  const items = data.rows.filter((r) => search.pdas || !PDA_NAMES.has(r.name ?? ""));
  const sample = data.rows[0]?.sampleSize;
  const computedAt = data.rows[0]?.computedAt;

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
      <div className="flex items-baseline justify-between">
        <h1 className="font-heading text-2xl font-bold">Weapon usage</h1>
        {sample !== undefined && (
          <p className="font-mono text-xs text-muted-foreground">
            n = {sample.toLocaleString()} players
            {computedAt && <span suppressHydrationWarning> · updated {formatAgo(computedAt)}</span>}
          </p>
        )}
      </div>

      <div className="space-y-3 rounded-lg border bg-card/50 p-4">
        <FilterRow label="Class">
          <Segmented>
            <Segment active={search.class === -1} patch={{ class: -1 }}>
              Any
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

        <FilterRow label="Slot">
          <Segmented>
            <Segment active={search.slot === -1} patch={{ slot: -1 }}>
              Any
            </Segment>
            {SLOTS.map((s) => (
              <Segment key={s.num} active={search.slot === s.num} patch={{ slot: s.num }}>
                {s.label}
              </Segment>
            ))}
          </Segmented>
        </FilterRow>

        <FilterRow label="Players">
          <SwitchFilter
            label="Active in the last 2 weeks"
            checked={search.active}
            patch={(next) => ({ active: next })}
          />
          <SwitchFilter
            label="2000+ hours played"
            checked={search.minutes > 0}
            patch={(next) => ({ minutes: next ? 120_000 : 0 })}
          />
        </FilterRow>

        <FilterRow label="Options">
          <SwitchFilter
            label="Merge reskins & stranges"
            checked={search.merge}
            patch={(next) => ({ merge: next })}
          />
          <SwitchFilter
            label="Hide PDAs"
            checked={!search.pdas}
            patch={(next) => ({ pdas: !next })}
          />
        </FilterRow>
      </div>

      {items.length === 0 ? (
        <p className="text-muted-foreground">
          No data yet for this filter combination — the crawler is warming up.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-10 text-right">#</TableHead>
              <TableHead className="w-9" />
              <TableHead>Item</TableHead>
              {search.class === -1 && <TableHead className="w-32">Classes</TableHead>}
              {search.slot === -1 && <TableHead className="w-24">Slot</TableHead>}
              <TableHead className="w-20 text-right">Players</TableHead>
              <TableHead className="w-44 text-right">Usage</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item, index) => {
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
                />
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function ItemName({ item, dim }: { item: UsageRow; dim?: boolean }) {
  return (
    <span className={dim ? "text-[13px] text-muted-foreground" : ""}>
      {displayName(item)}
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
}: {
  item: UsageRow;
  rank: number;
  variants: UsageRow[];
  expandable: boolean;
  isOpen: boolean;
  onToggle: () => void;
  showClasses: boolean;
  showSlot: boolean;
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
        <TableCell className="py-1">
          <ItemName item={item} />
          {expandable && (
            <span className="ml-1.5 font-mono text-[11px] text-primary/70">
              {isOpen ? "▾" : "▸"} {variants.length}{" "}
              {variants.length === 1 ? "variant" : "variants"}
            </span>
          )}
        </TableCell>
        {showClasses && (
          <TableCell className="py-1">
            <ClassIcons classes={item.usedByClasses} />
          </TableCell>
        )}
        {showSlot && (
          <TableCell className="py-1 text-xs text-muted-foreground">
            {item.slotName ? (SLOT_DISPLAY[item.slotName] ?? item.slotName) : ""}
          </TableCell>
        )}
        <TableCell className="py-1 text-right font-mono text-xs text-muted-foreground tabular-nums">
          {item.count.toLocaleString()}
        </TableCell>
        <TableCell className="py-1">
          <UsageBar usage={item.usage} />
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
            <TableCell className="py-0.5 pl-6" colSpan={1 + extraCols}>
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
              <div className="flex items-center justify-end">
                <span className="w-14 text-right font-mono text-xs text-muted-foreground tabular-nums">
                  {(v.usage * 100).toFixed(1)}%
                </span>
              </div>
            </TableCell>
          </TableRow>
        ))}
    </>
  );
}

function UsageBar({ usage }: { usage: number }) {
  return (
    <div className="flex items-center justify-end gap-2">
      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-secondary">
        <div
          className="h-full rounded-full bg-primary"
          style={{ width: `${Math.min(usage * 100, 100)}%` }}
        />
      </div>
      <span className="w-14 text-right font-mono text-sm tabular-nums">
        {(usage * 100).toFixed(1)}%
      </span>
    </div>
  );
}

function formatAgo(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}
