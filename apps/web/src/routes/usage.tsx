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
  { num: -1, label: "Any" },
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
  { num: -1, label: "Any" },
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

function UsagePage() {
  const search = Route.useSearch();
  const { data: items } = useSuspenseQuery(usageQueryOptions(search));

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Weapon usage rates</h1>

      <div className="flex flex-wrap gap-2">
        <Toggle
          label="Active players"
          searchPatch={{ active: !search.active }}
          enabled={search.active}
        />
        <Toggle
          label="Experienced (2000h+)"
          searchPatch={{ minutes: search.minutes > 0 ? 0 : 120_000 }}
          enabled={search.minutes > 0}
        />
        <Toggle
          label="Merge reskins"
          searchPatch={{ merge: !search.merge }}
          enabled={search.merge}
        />
      </div>

      <FilterRow options={CLASSES} current={search.class} toPatch={(num) => ({ class: num })} />
      <FilterRow options={SLOTS} current={search.slot} toPatch={(num) => ({ slot: num })} />

      {items.length === 0 ? (
        <p className="text-slate-400">
          No data yet for this filter combination — the crawler is warming up.
        </p>
      ) : (
        <ol className="space-y-2">
          {items.map((item, index) => (
            <li
              key={item.defindex}
              className="flex items-center gap-4 rounded border border-slate-800 bg-slate-900 px-4 py-2"
            >
              <span className="w-8 text-right font-mono text-slate-400">#{index + 1}</span>
              {item.imageUrl ? (
                <img src={item.imageUrl} alt="" className="h-10 w-10" loading="lazy" />
              ) : (
                <span className="h-10 w-10" />
              )}
              <span className="flex-1">{item.itemName ?? item.name ?? item.defindex}</span>
              <span className="font-mono text-amber-400">{(item.usage * 100).toFixed(1)}%</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function Toggle({
  label,
  searchPatch,
  enabled,
}: {
  label: string;
  searchPatch: Partial<ReturnType<typeof Route.useSearch>>;
  enabled: boolean;
}) {
  return (
    <Link
      from={Route.fullPath}
      search={(prev) => ({ ...prev, ...searchPatch })}
      className={`rounded px-3 py-1 text-sm ${
        enabled ? "bg-emerald-600 text-white" : "bg-slate-800 text-slate-300"
      }`}
    >
      {label}
    </Link>
  );
}

function FilterRow<T extends number>({
  options,
  current,
  toPatch,
}: {
  options: readonly { num: T; label: string }[];
  current: number;
  toPatch: (num: T) => Partial<ReturnType<typeof Route.useSearch>>;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {options.map((opt) => (
        <Link
          key={opt.num}
          from={Route.fullPath}
          search={(prev) => ({ ...prev, ...toPatch(opt.num) })}
          className={`rounded px-3 py-1 text-sm ${
            current === opt.num ? "bg-amber-500 text-slate-950" : "bg-slate-800 text-slate-300"
          }`}
        >
          {opt.label}
        </Link>
      ))}
    </div>
  );
}
