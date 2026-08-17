import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, stripSearchParams } from "@tanstack/react-router";
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

type SearchPatch = Partial<ReturnType<typeof Route.useSearch>>;

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

function Chip({
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
      className={`inline-flex h-7 items-center gap-1.5 rounded px-2 text-[13px] leading-none transition-colors ${
        active
          ? "bg-primary font-medium text-primary-foreground"
          : "bg-secondary/60 text-secondary-foreground hover:bg-accent"
      }`}
    >
      {children}
    </Link>
  );
}

function FilterRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="w-16 shrink-0 text-right font-mono text-[11px] tracking-wider text-muted-foreground uppercase">
        {label}
      </span>
      <div className="flex flex-wrap items-center gap-1">{children}</div>
    </div>
  );
}

function UsagePage() {
  const search = Route.useSearch();
  const { data: rows } = useSuspenseQuery(usageQueryOptions(search));

  const items = rows.filter((r) => search.pdas || !PDA_NAMES.has(r.name ?? ""));
  const sample = rows[0]?.sampleSize;
  const computedAt = rows[0]?.computedAt;

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

      <div className="space-y-2.5 rounded-lg border bg-card/50 p-4">
        <FilterRow label="Class">
          <Chip active={search.class === -1} patch={{ class: -1 }}>
            Any
          </Chip>
          {CLASSES.map((c) => (
            <Chip
              key={c.num}
              active={search.class === c.num}
              patch={{ class: c.num }}
              title={c.label}
            >
              <img src={`/${c.label}.svg`} alt="" className="h-4 w-4" />
              <span className="hidden sm:inline">{c.label}</span>
            </Chip>
          ))}
        </FilterRow>

        <FilterRow label="Slot">
          <Chip active={search.slot === -1} patch={{ slot: -1 }}>
            Any
          </Chip>
          {SLOTS.map((s) => (
            <Chip key={s.num} active={search.slot === s.num} patch={{ slot: s.num }}>
              {s.label}
            </Chip>
          ))}
        </FilterRow>

        <FilterRow label="Players">
          <Chip active={search.active} patch={{ active: !search.active }}>
            {search.active ? "✓ " : ""}Active (played last 2 weeks)
          </Chip>
          <Chip active={search.minutes > 0} patch={{ minutes: search.minutes > 0 ? 0 : 120_000 }}>
            {search.minutes > 0 ? "✓ " : ""}Experienced (2000+ hours)
          </Chip>
        </FilterRow>

        <FilterRow label="Options">
          <Chip active={search.merge} patch={{ merge: !search.merge }}>
            {search.merge ? "✓ " : ""}Merge reskins &amp; stranges
          </Chip>
          <Chip active={!search.pdas} patch={{ pdas: !search.pdas }}>
            {!search.pdas ? "✓ " : ""}Hide PDAs
          </Chip>
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
              <TableHead className="w-20 text-right font-mono text-xs">defindex</TableHead>
              <TableHead className="w-44 text-right">Usage</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item, index) => (
              <TableRow key={item.defindex} className="h-9">
                <TableCell className="py-1 text-right font-mono text-muted-foreground">
                  {index + 1}
                </TableCell>
                <TableCell className="py-0.5">
                  {item.imageUrl && (
                    <img src={item.imageUrl} alt="" className="h-7 w-7" loading="lazy" />
                  )}
                </TableCell>
                <TableCell className="py-1">
                  {displayName(item)}
                  {search.merge && item.reskinGroup !== null && (
                    <span className="ml-1.5 text-[11px] text-muted-foreground">+reskins</span>
                  )}
                </TableCell>
                <TableCell className="py-1 text-right font-mono text-xs text-muted-foreground">
                  {item.defindex}
                </TableCell>
                <TableCell className="py-1">
                  <div className="flex items-center justify-end gap-2">
                    <div className="h-1.5 w-24 overflow-hidden rounded-full bg-secondary">
                      <div
                        className="h-full rounded-full bg-primary"
                        style={{ width: `${Math.min(item.usage * 100, 100)}%` }}
                      />
                    </div>
                    <span className="w-14 text-right font-mono text-sm tabular-nums">
                      {(item.usage * 100).toFixed(1)}%
                    </span>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function formatAgo(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}
