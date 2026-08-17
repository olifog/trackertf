import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, stripSearchParams } from "@tanstack/react-router";
import { usageFiltersSchema, usageQueryOptions } from "#/server/usage";

const DEFAULT_FILTERS = {
  class: -1,
  slot: -1,
  active: false,
  minutes: 0,
  merge: false,
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
  { num: -1, label: "Any slot" },
  { num: 0, label: "Primary" },
  { num: 1, label: "Secondary" },
  { num: 2, label: "Melee" },
  { num: 7, label: "Cosmetic" },
  { num: 8, label: "Taunt" },
] as const;

export const Route = createFileRoute("/usage")({
  validateSearch: usageFiltersSchema,
  search: { middlewares: [stripSearchParams(DEFAULT_FILTERS)] },
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) => context.queryClient.ensureQueryData(usageQueryOptions(deps)),
  component: UsagePage,
});

type SearchPatch = Partial<ReturnType<typeof Route.useSearch>>;

function FilterChip({
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
      className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors ${
        active
          ? "bg-primary text-primary-foreground"
          : "bg-secondary text-secondary-foreground hover:bg-accent"
      }`}
    >
      {children}
    </Link>
  );
}

function UsagePage() {
  const search = Route.useSearch();
  const { data: items } = useSuspenseQuery(usageQueryOptions(search));

  return (
    <div className="space-y-6">
      <h1 className="font-heading text-2xl font-bold">Weapon usage rates</h1>

      <div className="flex flex-wrap gap-2">
        <FilterChip active={search.active} patch={{ active: !search.active }}>
          Active players
        </FilterChip>
        <FilterChip
          active={search.minutes > 0}
          patch={{ minutes: search.minutes > 0 ? 0 : 120_000 }}
        >
          Experienced (2000h+)
        </FilterChip>
        <FilterChip active={search.merge} patch={{ merge: !search.merge }}>
          Merge reskins
        </FilterChip>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <FilterChip active={search.class === -1} patch={{ class: -1 }}>
          Any class
        </FilterChip>
        {CLASSES.map((c) => (
          <FilterChip
            key={c.num}
            active={search.class === c.num}
            patch={{ class: c.num }}
            title={c.label}
          >
            <img src={`/${c.label}.svg`} alt={c.label} className="h-5 w-5" />
          </FilterChip>
        ))}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {SLOTS.map((s) => (
          <FilterChip key={s.num} active={search.slot === s.num} patch={{ slot: s.num }}>
            {s.label}
          </FilterChip>
        ))}
      </div>

      {items.length === 0 ? (
        <p className="text-muted-foreground">
          No data yet for this filter combination — the crawler is warming up.
        </p>
      ) : (
        <ol className="space-y-2">
          {items.map((item, index) => (
            <li
              key={item.defindex}
              className="flex items-center gap-4 rounded-lg border bg-card px-4 py-2"
            >
              <span className="w-8 text-right font-mono text-muted-foreground">#{index + 1}</span>
              {item.imageUrl ? (
                <img src={item.imageUrl} alt="" className="h-10 w-10" loading="lazy" />
              ) : (
                <span className="h-10 w-10" />
              )}
              <span className="flex-1">{item.itemName ?? item.name ?? item.defindex}</span>
              <span className="font-mono font-semibold text-primary">
                {(item.usage * 100).toFixed(1)}%
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
