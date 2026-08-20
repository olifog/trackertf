import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "#/components/ui/table";
import { qualityColor, qualityName, qualityRank } from "#/lib/quality";
import { avatarUrl, CLASS_NAMES, itemDisplayName } from "#/lib/tf2";
import { itemPairsQueryOptions, itemQueryOptions } from "#/server/item";
import { HALE_OWN_KILLS, itemStrangeBoardQueryOptions } from "#/server/leaderboards";

export const Route = createFileRoute("/item/$defindex")({
  params: {
    parse: (p) => ({ defindex: Number(p.defindex) }),
    stringify: (p) => ({ defindex: String(p.defindex) }),
  },
  loader: async ({ context, params }) => {
    const data = await context.queryClient.ensureQueryData(itemQueryOptions(params.defindex));
    if (!data) throw notFound();
  },
  component: ItemPage,
});

function ItemPage() {
  const { defindex } = Route.useParams();
  const { data } = useSuspenseQuery(itemQueryOptions(defindex));
  if (!data) return null;
  const { item, groupMembers, usage, perf, variantQualities } = data;

  const qualitiesByVariant = new Map<number, { quality: number; count: number }[]>();
  for (const v of variantQualities) {
    const list = qualitiesByVariant.get(v.defindex) ?? [];
    list.push({ quality: v.quality, count: v.count });
    qualitiesByVariant.set(v.defindex, list);
  }
  for (const list of qualitiesByVariant.values()) {
    list.sort((a, b) => qualityRank(a.quality) - qualityRank(b.quality));
  }

  const populations = [
    { label: "All players", active: false, minutes: 0 },
    { label: "Active", active: true, minutes: 0 },
    { label: "Experienced", active: false, minutes: 120_000 },
    { label: "Active + exp.", active: true, minutes: 120_000 },
  ];
  const classRows = [...new Set(usage.map((u) => u.classNum))].filter((c) => c !== -1).toSorted();
  const cell = (classNum: number, active: boolean, minutes: number) =>
    usage.find(
      (u) => u.classNum === classNum && u.activeOnly === active && u.minutesThreshold === minutes,
    );

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        {item.imageUrl && <img src={item.imageUrl} alt="" className="h-16 w-16" />}
        <div>
          <h1 className="font-heading text-2xl font-bold">
            {itemDisplayName(item)}
            <span className="ml-2 font-mono text-sm text-muted-foreground/60">
              #{item.defindex}
            </span>
          </h1>
          <p className="text-sm text-muted-foreground">
            {item.slot ?? "-"} ·{" "}
            {item.usedByClasses.length === 9
              ? "all classes"
              : item.usedByClasses.map((c) => CLASS_NAMES[c]).join(", ")}
            {item.reskinGroup !== null && item.reskinGroup !== item.defindex && (
              <>
                {" "}
                · variant of{" "}
                <Link
                  to="/item/$defindex"
                  params={{ defindex: item.reskinGroup }}
                  className="underline"
                >
                  #{item.reskinGroup}
                </Link>
              </>
            )}
          </p>
        </div>
      </div>

      {usage.length > 0 && (
        <div>
          <h2 className="mb-2 font-heading text-lg font-semibold">
            Usage by class{" "}
            <span className="text-sm font-normal text-muted-foreground">
              (reskins merged; n = {usage[0]?.sampleSize.toLocaleString()} for all players)
            </span>
          </h2>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Class</TableHead>
                {populations.map((p) => (
                  <TableHead key={p.label} className="text-right">
                    {p.label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {classRows.map((c) => (
                <TableRow key={c} className="h-9">
                  <TableCell className="py-1">
                    <span className="flex items-center gap-2">
                      {CLASS_NAMES[c] && (
                        <img src={`/${CLASS_NAMES[c]}.svg`} alt="" className="h-4 w-4" />
                      )}
                      {CLASS_NAMES[c] ?? c}
                    </span>
                  </TableCell>
                  {populations.map((p) => {
                    const u = cell(c, p.active, p.minutes);
                    return (
                      <TableCell
                        key={p.label}
                        className="py-1 text-right font-mono text-sm tabular-nums"
                      >
                        {u ? `${(u.usage * 100).toFixed(1)}%` : "-"}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {perf.length > 0 && (
        <div>
          <h2 className="mb-2 font-heading text-lg font-semibold">
            Performance of players equipping this{" "}
            <span className="text-sm font-normal text-muted-foreground">
              (lifetime per-class rates, 10h+ on class, correlation not causation)
            </span>
          </h2>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Class</TableHead>
                <TableHead className="text-right">Players</TableHead>
                <TableHead className="text-right">Points / min</TableHead>
                <TableHead className="text-right">Kills / hour</TableHead>
                <TableHead className="text-right">Damage / min</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {perf
                .toSorted((a, b) => b.players - a.players)
                .map((p) => (
                  <TableRow key={p.classNum} className="h-9">
                    <TableCell className="py-1">
                      <span className="flex items-center gap-2">
                        {CLASS_NAMES[p.classNum] && (
                          <img src={`/${CLASS_NAMES[p.classNum]}.svg`} alt="" className="h-4 w-4" />
                        )}
                        {CLASS_NAMES[p.classNum] ?? p.classNum}
                      </span>
                    </TableCell>
                    <TableCell className="py-1 text-right font-mono text-xs tabular-nums text-muted-foreground">
                      {p.players.toLocaleString()}
                    </TableCell>
                    <TableCell className="py-1 text-right font-mono text-sm tabular-nums">
                      {p.avgPointsPerMin.toFixed(2)}
                    </TableCell>
                    <TableCell className="py-1 text-right font-mono text-sm tabular-nums">
                      {p.avgKillsPerHour.toFixed(1)}
                    </TableCell>
                    <TableCell className="py-1 text-right font-mono text-sm tabular-nums">
                      {p.avgDamagePerMin.toFixed(0)}
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </div>
      )}

      <StrangeLeaderboard defindex={item.defindex} />

      {groupMembers.length > 1 && (
        <div>
          <h2 className="mb-2 font-heading text-lg font-semibold">
            Variants{" "}
            <span className="text-sm font-normal text-muted-foreground">
              ({groupMembers.length} in this functional group)
            </span>
          </h2>
          <div className="flex flex-wrap gap-2">
            {groupMembers.map((m) => {
              const quals = qualitiesByVariant.get(m.defindex);
              return (
                <Link
                  key={m.defindex}
                  to="/item/$defindex"
                  params={{ defindex: m.defindex }}
                  className={`flex flex-col gap-0.5 rounded-md border px-2.5 py-1.5 transition-colors hover:bg-accent ${m.defindex === item.defindex ? "border-primary" : ""}`}
                >
                  <span className="flex items-center gap-2 text-[13px]">
                    {m.imageUrl && <img src={m.imageUrl} alt="" className="h-5 w-5" />}
                    {itemDisplayName(m)}
                    <span className="font-mono text-[10px] text-muted-foreground/60">
                      #{m.defindex}
                    </span>
                  </span>
                  {quals && quals.length > 0 && (
                    <span className="flex flex-wrap gap-x-1.5 font-mono text-[10px]">
                      {quals.map((q, i) => (
                        <span key={q.quality} className="text-muted-foreground/60">
                          {i > 0 && <span className="mr-1.5">·</span>}
                          <span style={{ color: qualityColor(q.quality) }}>
                            {qualityName(q.quality)}
                          </span>{" "}
                          ×{q.count.toLocaleString()}
                        </span>
                      ))}
                    </span>
                  )}
                </Link>
              );
            })}
          </div>
        </div>
      )}

      <PairedWeapons defindex={item.defindex} />
    </div>
  );
}

/**
 * Top players by Strange kill-eater count on this specific defindex. Rendered
 * only when the item actually has Strange (quality 11) equippers, so it stays
 * hidden for items that are never run Strange. Mirrors the leaderboards-page
 * table style; the Hale's Own threshold (25,000) is flagged inline.
 */
function StrangeLeaderboard({ defindex }: { defindex: number }) {
  const { data } = useQuery(itemStrangeBoardQueryOptions(defindex));
  if (!data || data.length === 0) return null;

  return (
    <div>
      <h2 className="mb-2 font-heading text-lg font-semibold">
        Top Strange kills{" "}
        <span className="text-sm font-normal text-muted-foreground">
          (highest kill-eater counters on this item; public profiles, no VAC bans)
        </span>
      </h2>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-10 text-right">#</TableHead>
            <TableHead className="w-9" />
            <TableHead>Player</TableHead>
            <TableHead className="w-40 text-right">Strange kills</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.map((row) => {
            const haleOwn = row.kills >= HALE_OWN_KILLS;
            return (
              <TableRow key={row.steamid} className="h-9">
                <TableCell className="py-1 text-right font-mono text-muted-foreground">
                  {row.rank}
                </TableCell>
                <TableCell className="py-0.5">
                  {avatarUrl(row.avatarHash) && (
                    <img
                      src={avatarUrl(row.avatarHash) as string}
                      alt=""
                      className="h-6 w-6 rounded-sm"
                      loading="lazy"
                    />
                  )}
                </TableCell>
                <TableCell className="py-1">
                  <Link
                    to="/player/$steamid"
                    params={{ steamid: row.steamid }}
                    className="hover:underline"
                  >
                    {row.personaname ?? row.steamid}
                  </Link>
                </TableCell>
                <TableCell className="py-1 text-right font-mono text-sm tabular-nums">
                  <span className="inline-flex items-center justify-end gap-1.5">
                    {haleOwn && (
                      <span
                        title="Hale's Own (25,000+ kills)"
                        className="rounded border px-1 py-0.5 text-[10px] font-medium tracking-wide uppercase"
                        style={{ color: qualityColor(11), borderColor: qualityColor(11) }}
                      >
                        Hale's Own
                      </span>
                    )}
                    {row.kills.toLocaleString()}
                  </span>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

const PAIR_POPULATIONS = [
  { label: "All players", minutes: 0 },
  { label: "Experienced", minutes: 120_000 },
] as const;

function PairedWeapons({ defindex }: { defindex: number }) {
  const [minutes, setMinutes] = useState(0);
  const { data, isLoading } = useQuery(itemPairsQueryOptions(defindex, minutes));

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="font-heading text-lg font-semibold">
          Most commonly paired weapons{" "}
          <span className="text-sm font-normal text-muted-foreground">
            (equipped in the same loadout; reskins merged)
          </span>
        </h2>
        <div className="inline-flex divide-x divide-border overflow-hidden rounded-md border">
          {PAIR_POPULATIONS.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => setMinutes(p.minutes)}
              className={`flex h-8 items-center px-2.5 text-[13px] leading-none transition-colors ${
                minutes === p.minutes
                  ? "bg-primary font-medium text-primary-foreground"
                  : "bg-secondary/40 text-secondary-foreground hover:bg-accent"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
      {isLoading ? (
        <div className="py-4 font-mono text-xs text-muted-foreground">loading…</div>
      ) : !data || data.pairs.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">
          Not enough loadout data for this item yet.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-10 text-right">#</TableHead>
              <TableHead>Weapon</TableHead>
              <TableHead className="text-right">Loadouts</TableHead>
              <TableHead className="text-right">Share</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.pairs.map((p, i) => (
              <TableRow key={p.defindex} className="h-9">
                <TableCell className="py-1 text-right font-mono text-muted-foreground">
                  {i + 1}
                </TableCell>
                <TableCell className="py-1">
                  <Link
                    to="/item/$defindex"
                    params={{ defindex: p.defindex }}
                    className="flex items-center gap-2 transition-colors hover:text-primary"
                  >
                    {p.imageUrl && <img src={p.imageUrl} alt="" className="h-5 w-5" />}
                    {itemDisplayName(p)}
                  </Link>
                </TableCell>
                <TableCell className="py-1 text-right font-mono text-xs tabular-nums text-muted-foreground">
                  {p.count.toLocaleString()}
                </TableCell>
                <TableCell className="py-1 text-right font-mono text-sm tabular-nums">
                  {(p.share * 100).toFixed(1)}%
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
