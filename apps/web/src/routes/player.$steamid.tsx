import { useMutation, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { Segmented } from "#/components/ui/filter-bar";
import { FilterableList } from "#/components/ui/filterable-list";
import { InfoTip } from "#/components/ui/info-tip";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "#/components/ui/table";
import { regionLabel } from "#/lib/geo";
import { qualityColor, qualityName } from "#/lib/quality";
import {
  avatarUrl,
  CLASS_NAMES,
  formatAgo,
  formatHours,
  itemDisplayName,
  SLOT_NAMES,
} from "#/lib/tf2";
import { type BoardScope, BOARD_MAP } from "@trackertf/db/boards";
import { type PlayerRankRow, playerRanksQueryOptions } from "#/server/leaderboards";
import {
  friendRanksQueryOptions,
  type InventoryRow,
  playerFriendsQueryOptions,
  playerInventoryQueryOptions,
  playerQueryOptions,
  type RecrawlResult,
  requestRecrawl,
} from "#/server/player";
import { type PlayerSessions, playerSessionsQueryOptions } from "#/server/sessions";
import { type PlayerSightings, playerSightingsQueryOptions } from "#/server/sightings";

export const Route = createFileRoute("/player/$steamid")({
  loader: ({ context, params }) =>
    Promise.all([
      context.queryClient.ensureQueryData(playerQueryOptions(params.steamid)),
      context.queryClient.ensureQueryData(playerRanksQueryOptions(params.steamid)),
      context.queryClient.ensureQueryData(playerInventoryQueryOptions(params.steamid)),
      context.queryClient.ensureQueryData(playerFriendsQueryOptions(params.steamid)),
      context.queryClient.ensureQueryData(friendRanksQueryOptions(params.steamid)),
      context.queryClient.ensureQueryData(playerSightingsQueryOptions(params.steamid)),
      context.queryClient.ensureQueryData(playerSessionsQueryOptions(params.steamid)),
    ]),
  component: PlayerPage,
});

const CLASS_ORDER = [1, 3, 7, 4, 6, 9, 5, 2, 8];

// Strange (quality 11) rendering. Mirrors packages/tf2-schema/src/strange.ts —
// inlined here to avoid adding a cross-package dependency to the web app.
const STRANGE_QUALITY = 11;
const HALE_OWN_KILLS = 8500;
// Kill-eater rank tiers, ascending by min. Top rank is "Hale's Own" at 8500.
const STRANGE_RANKS: readonly { min: number; name: string }[] = [
  { min: 0, name: "Strange" },
  { min: 10, name: "Unremarkable" },
  { min: 25, name: "Scarcely Lethal" },
  { min: 45, name: "Mildly Menacing" },
  { min: 70, name: "Somewhat Threatening" },
  { min: 100, name: "Uncharitable" },
  { min: 135, name: "Notably Dangerous" },
  { min: 175, name: "Sufficiently Lethal" },
  { min: 225, name: "Truly Feared" },
  { min: 275, name: "Spectacularly Lethal" },
  { min: 350, name: "Gore-Spattered" },
  { min: 500, name: "Wicked Nasty" },
  { min: 750, name: "Positively Inhumane" },
  { min: 999, name: "Totally Ordinary" },
  { min: 1000, name: "Face-Melting" },
  { min: 1500, name: "Rage-Inducing" },
  { min: 2500, name: "Server-Clearing" },
  { min: 5000, name: "Epic" },
  { min: 7500, name: "Legendary" },
  { min: 7616, name: "Australian" },
  { min: 8500, name: "Hale's Own" },
];
function strangeRank(kills: number): string {
  let name = STRANGE_RANKS[0]!.name;
  for (const tier of STRANGE_RANKS) {
    if (kills >= tier.min) name = tier.name;
    else break;
  }
  return name;
}
function haleOwnPct(kills: number): number {
  return Math.min(100, (kills / HALE_OWN_KILLS) * 100);
}

/** the board scope a rank row belongs to (overall / class number) */
function rankScope(r: PlayerRankRow): BoardScope {
  return BOARD_MAP.get(r.boardKey)?.scope ?? "overall";
}

/** One class-scope pill in the ranks section's `Segmented` strip — same visual
 * language as the leaderboards-page picker, but a plain button over local
 * state (the player page's rank filters never touch the URL). */
function ScopePill({
  children,
  active,
  onClick,
  title,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
  title?: string | undefined;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`flex h-9 shrink-0 items-center px-2.5 text-[13px] leading-none transition-colors sm:h-8 ${
        active
          ? "bg-primary font-medium text-primary-foreground"
          : "bg-secondary/40 text-secondary-foreground hover:bg-accent"
      }`}
    >
      {children}
    </button>
  );
}

/** "Leaderboard positions": every board rank this player holds (up to 256),
 * percentile-sorted, behind class-scope pills + a label filter + a capped
 * scroll instead of the old top-20/"show all" expander. */
function RanksSection({ ranks }: { ranks: PlayerRankRow[] }) {
  const [scope, setScope] = useState<BoardScope | "all">("all");
  const presentScopes = new Set(ranks.map(rankScope));
  // ranks arrive percentile-sorted; filtering preserves that order
  const scoped = scope === "all" ? ranks : ranks.filter((r) => rankScope(r) === scope);

  return (
    <div>
      <h2 className="mb-2 font-heading text-lg font-semibold">Leaderboard positions</h2>
      <div className="space-y-3">
        <Segmented>
          <ScopePill active={scope === "all"} onClick={() => setScope("all")}>
            All
          </ScopePill>
          {presentScopes.has("overall") && (
            <ScopePill active={scope === "overall"} onClick={() => setScope("overall")}>
              Overall
            </ScopePill>
          )}
          {CLASS_ORDER.filter((c) => presentScopes.has(c)).map((c) => (
            <ScopePill
              key={c}
              active={scope === c}
              onClick={() => setScope(c)}
              title={CLASS_NAMES[c]}
            >
              <img
                src={`/${CLASS_NAMES[c]}.svg`}
                alt={CLASS_NAMES[c]}
                className={`h-4.5 w-4.5 ${scope === c ? "" : "opacity-80"}`}
              />
            </ScopePill>
          ))}
        </Segmented>
        <FilterableList items={scoped} filterBy={(r) => r.label} noun="boards">
          {({ visible, scrollClass, stickyHeaderClass, emptyText }) => (
            <Table containerClassName={scrollClass}>
              <TableHeader className={stickyHeaderClass}>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Board</TableHead>
                  <TableHead className="w-24 text-right">Percentile</TableHead>
                  <TableHead className="w-32 text-right">Rank</TableHead>
                  <TableHead className="w-32 text-right">Value</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((r) => (
                  <TableRow key={r.boardKey} className="h-8">
                    <TableCell className="py-1">
                      <Link
                        to="/leaderboards"
                        search={{ board: r.boardKey }}
                        className="hover:underline"
                      >
                        {r.label}
                      </Link>
                    </TableCell>
                    <TableCell className="py-1 text-right">
                      <span className="rounded bg-secondary/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                        top {((100 * r.rank) / r.of).toFixed(1)}%
                      </span>
                    </TableCell>
                    <TableCell className="py-1 text-right font-mono text-xs tabular-nums">
                      #{r.rank.toLocaleString()}
                      <span className="text-muted-foreground"> / {r.of.toLocaleString()}</span>
                    </TableCell>
                    <TableCell className="py-1 text-right font-mono text-xs tabular-nums">
                      {r.value.toLocaleString(undefined, {
                        maximumFractionDigits: BOARD_MAP.get(r.boardKey)?.decimals ?? 0,
                      })}
                    </TableCell>
                  </TableRow>
                ))}
                {emptyText && (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={4} className="py-4 text-center text-muted-foreground">
                      {emptyText}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </FilterableList>
      </div>
    </div>
  );
}

function PlayerPage() {
  const { steamid } = Route.useParams();
  const { data: p } = useSuspenseQuery(playerQueryOptions(steamid));
  const { data: ranks } = useSuspenseQuery(playerRanksQueryOptions(steamid));
  const { data: inventory } = useSuspenseQuery(playerInventoryQueryOptions(steamid));
  const { data: friends } = useSuspenseQuery(playerFriendsQueryOptions(steamid));
  const { data: friendRanks } = useSuspenseQuery(friendRanksQueryOptions(steamid));
  const { data: sightings } = useSuspenseQuery(playerSightingsQueryOptions(steamid));
  const { data: sessions } = useSuspenseQuery(playerSessionsQueryOptions(steamid));
  const recrawl = useMutation({
    mutationFn: () => requestRecrawl({ data: { steamid } }),
  });

  if (!p.found) {
    return (
      <div className="space-y-3">
        <h1 className="font-heading text-2xl font-bold">Player not crawled yet</h1>
        <p className="text-muted-foreground">
          <span className="font-mono">{steamid}</span> isn't in the dataset yet.
          {p.queued ? " Queued for crawling — check back soon." : " Queueing failed; try again."}
        </p>
      </div>
    );
  }

  const totalClassSeconds = p.classStats.reduce((a, c) => a + c.playtimeSeconds, 0);
  const sortedStats = p.classStats.toSorted((a, b) => b.playtimeSeconds - a.playtimeSeconds);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start gap-4">
        {avatarUrl(p.avatarHash) && (
          <img src={avatarUrl(p.avatarHash) as string} alt="" className="h-16 w-16 rounded-md" />
        )}
        <div>
          <h1 className="font-heading text-2xl font-bold">
            {p.personaname ?? p.steamid}
            {p.vacBanned && (
              <span className="ml-2 rounded bg-destructive/20 px-1.5 py-0.5 font-mono text-xs text-destructive">
                VAC banned
              </span>
            )}
          </h1>
          <p className="font-mono text-sm text-muted-foreground">
            {formatHours(p.tf2Minutes)} in TF2
            {(p.tf2Minutes2wk ?? 0) > 0 && ` · ${p.tf2Minutes2wk}min last 2 weeks`}
            {p.lastCrawled && (
              <span suppressHydrationWarning> · crawled {formatAgo(p.lastCrawled)}</span>
            )}
          </p>
          <p className="font-mono text-xs text-muted-foreground/70">
            {p.steamid} · backpack: {p.itemsStatus} · stats: {p.statsStatus}
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <ExternalLink href={`https://steamcommunity.com/profiles/${p.steamid}`}>
              Steam profile
            </ExternalLink>
            <ExternalLink href={`https://backpack.tf/profiles/${p.steamid}`}>
              backpack.tf
            </ExternalLink>
          </div>
        </div>
        <RecrawlButton
          onClick={() => recrawl.mutate()}
          pending={recrawl.isPending}
          result={recrawl.data ?? null}
        />
      </div>

      {sortedStats.length > 0 ? (
        <div>
          <h2 className="mb-2 font-heading text-lg font-semibold">
            Class stats (lifetime)
            <InfoTip className="ml-1.5" text="No deaths stat in Steam's TF2 data, so no K/D." />
          </h2>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Class</TableHead>
                <TableHead className="text-right">Hours</TableHead>
                <TableHead className="hidden text-right md:table-cell">Share</TableHead>
                <TableHead className="text-right">Kills</TableHead>
                <TableHead className="text-right">Kills / hr</TableHead>
                <TableHead className="text-right">Points / min</TableHead>
                <TableHead className="hidden text-right sm:table-cell">Dmg / min</TableHead>
                <TableHead className="hidden text-right md:table-cell">Assists</TableHead>
                <TableHead className="hidden text-right md:table-cell">Caps</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedStats.map((c) => (
                <TableRow key={c.classNum} className="h-9">
                  <TableCell className="py-1">
                    <span className="flex items-center gap-2">
                      {CLASS_NAMES[c.classNum] && (
                        <img src={`/${CLASS_NAMES[c.classNum]}.svg`} alt="" className="h-4 w-4" />
                      )}
                      {CLASS_NAMES[c.classNum] ?? c.classNum}
                    </span>
                  </TableCell>
                  <TableCell className="py-1 text-right font-mono text-sm tabular-nums">
                    {(c.playtimeSeconds / 3600).toFixed(0)}
                  </TableCell>
                  <TableCell className="hidden py-1 text-right font-mono text-xs tabular-nums text-muted-foreground md:table-cell">
                    {totalClassSeconds > 0
                      ? `${((c.playtimeSeconds / totalClassSeconds) * 100).toFixed(0)}%`
                      : "-"}
                  </TableCell>
                  <TableCell className="py-1 text-right font-mono text-sm tabular-nums">
                    {c.kills.toLocaleString()}
                  </TableCell>
                  <TableCell className="py-1 text-right font-mono text-sm tabular-nums">
                    {c.playtimeSeconds > 0
                      ? ((c.kills * 3600) / c.playtimeSeconds).toFixed(1)
                      : "-"}
                  </TableCell>
                  <TableCell className="py-1 text-right font-mono text-sm tabular-nums">
                    {c.playtimeSeconds > 0
                      ? ((c.pointsScored * 60) / c.playtimeSeconds).toFixed(2)
                      : "-"}
                  </TableCell>
                  <TableCell className="hidden py-1 text-right font-mono text-sm tabular-nums sm:table-cell">
                    {c.playtimeSeconds > 0
                      ? ((c.damageDealt * 60) / c.playtimeSeconds).toFixed(0)
                      : "-"}
                  </TableCell>
                  <TableCell className="hidden py-1 text-right font-mono text-xs tabular-nums text-muted-foreground md:table-cell">
                    {c.killAssists.toLocaleString()}
                  </TableCell>
                  <TableCell className="hidden py-1 text-right font-mono text-xs tabular-nums text-muted-foreground md:table-cell">
                    {c.captures.toLocaleString()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <p className="text-muted-foreground">Game stats are private for this player.</p>
      )}

      {(sightings.sightings.length > 0 || sightings.ambiguous > 0) && (
        <SightingsSection sightings={sightings} />
      )}

      {sessions.sessions.length > 0 && <SessionsSection sessions={sessions} />}

      {ranks.length > 0 && <RanksSection ranks={ranks} />}

      {friendRanks.hasData && (
        <div>
          <h2 className="mb-2 font-heading text-lg font-semibold">Rank among friends</h2>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Board</TableHead>
                <TableHead className="w-32 text-right">Rank</TableHead>
                <TableHead className="w-32 text-right">Value</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {friendRanks.ranks.map((r) => (
                <TableRow key={r.metric} className="h-8">
                  <TableCell className="py-1">{r.label}</TableCell>
                  <TableCell className="py-1 text-right font-mono text-xs tabular-nums">
                    #{r.rank.toLocaleString()}
                    <span className="text-muted-foreground">
                      {" "}
                      / {friendRanks.total.toLocaleString()}
                    </span>
                  </TableCell>
                  <TableCell className="py-1 text-right font-mono text-xs tabular-nums">
                    {r.value.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p className="mt-1 text-xs text-muted-foreground">
            {friendRanks.total.toLocaleString()} crawled friends.
          </p>
        </div>
      )}

      {p.equipped.length > 0 && (
        <div>
          <h2 className="mb-2 font-heading text-lg font-semibold">Active loadouts</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {CLASS_ORDER.filter((c) => p.equipped.some((e) => e.classNum === c)).map((c) => (
              <div key={c} className="rounded-lg border bg-card/50 p-3">
                <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
                  <img src={`/${CLASS_NAMES[c]}.svg`} alt="" className="h-4 w-4" />
                  {CLASS_NAMES[c]}
                </div>
                <ul className="space-y-1">
                  {p.equipped
                    .filter((e) => e.classNum === c && e.slot <= 6)
                    .toSorted((a, b) => a.slot - b.slot)
                    .map((e) => (
                      <li key={`${e.slot}:${e.defindex}`} className="text-[13px]">
                        <div className="flex items-center gap-2">
                          {e.imageUrl && <img src={e.imageUrl} alt="" className="h-5 w-5" />}
                          <Link
                            to="/item/$defindex"
                            params={{ defindex: e.defindex }}
                            className="hover:underline"
                            style={{ color: qualityColor(e.quality) }}
                            title={qualityName(e.quality)}
                          >
                            {itemDisplayName(e)}
                          </Link>
                          <span className="ml-auto font-mono text-[10px] text-muted-foreground/60">
                            {SLOT_NAMES[e.slot]}
                          </span>
                        </div>
                        {e.quality === STRANGE_QUALITY && e.strangeKills > 0 && (
                          <div className="pl-7 font-mono text-[10px] text-muted-foreground">
                            <span style={{ color: qualityColor(STRANGE_QUALITY) }}>
                              {strangeRank(e.strangeKills)}
                            </span>{" "}
                            · {e.strangeKills.toLocaleString()} kills ·{" "}
                            {haleOwnPct(e.strangeKills).toFixed(1)}% to Hale's Own
                          </div>
                        )}
                      </li>
                    ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}

      {inventory.length > 0 && <InventorySection rows={inventory} />}

      {friends.hasData && friends.totalFriends > 0 && (
        <div>
          <h2 className="mb-2 font-heading text-lg font-semibold">Friends</h2>
          {friends.friends.length > 0 && (
            <FilterableList
              items={friends.friends}
              filterBy={(f) => f.personaname ?? f.steamid}
              noun="friends"
              placeholder="filter friends…"
              minFilterItems={12}
              maxHeightClassName="max-h-[24rem]"
            >
              {({ visible, scrollClass, emptyText }) =>
                emptyText ? (
                  <p className="text-sm text-muted-foreground">{emptyText}</p>
                ) : (
                  <div className={`${scrollClass} grid gap-2 p-2 sm:grid-cols-2 lg:grid-cols-3`}>
                    {visible.map((f) => (
                      <Link
                        key={f.steamid}
                        to="/player/$steamid"
                        params={{ steamid: f.steamid }}
                        className="flex items-center gap-2 rounded-md border bg-card/50 px-2.5 py-1.5 transition-colors hover:bg-accent"
                      >
                        {avatarUrl(f.avatarHash) && (
                          <img
                            src={avatarUrl(f.avatarHash) as string}
                            alt=""
                            className="h-7 w-7 rounded"
                          />
                        )}
                        <span className="truncate text-[13px]">{f.personaname ?? f.steamid}</span>
                        {f.friendSince > 0 && (
                          <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground/60">
                            since {new Date(f.friendSince * 1000).getFullYear()}
                          </span>
                        )}
                      </Link>
                    ))}
                  </div>
                )
              }
            </FilterableList>
          )}
          {friends.totalFriends > friends.friends.length && (
            <p className="mt-2 text-xs text-muted-foreground">
              {friends.friends.length > 0 ? "and " : ""}
              {(friends.totalFriends - friends.friends.length).toLocaleString()} uncrawled friend
              {friends.totalFriends - friends.friends.length === 1 ? "" : "s"}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** Small external-link pill (Steam profile, backpack.tf) for the header. Opens
 * in a new tab; rel="noreferrer" since these are third-party destinations. */
function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="rounded-md border px-2.5 py-1 font-mono text-xs text-muted-foreground transition-colors hover:bg-accent"
    >
      {children} ↗
    </a>
  );
}

/** Header action: enqueue this player for a fresh crawl. The frontier role is
 * INSERT-only with on-conflict-do-nothing, so this is safe to expose. */
function RecrawlButton({
  onClick,
  pending,
  result,
}: {
  onClick: () => void;
  pending: boolean;
  result: RecrawlResult | null;
}) {
  const done = result?.queued ?? false;
  const label = pending
    ? "queueing…"
    : result
      ? result.queued
        ? result.alreadyQueued
          ? "already queued"
          : "queued ✓"
        : "couldn't queue — retry"
      : "request recrawl";
  return (
    <div className="ml-auto flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={onClick}
        disabled={pending || done}
        className="rounded-md border px-2.5 py-1 font-mono text-xs text-muted-foreground transition-colors hover:bg-accent disabled:cursor-default disabled:opacity-70"
      >
        {label}
      </button>
      {result?.queued && (
        <span className="max-w-44 text-right text-[10px] leading-tight text-muted-foreground/70">
          {recrawlEta(result)}
        </span>
      )}
    </div>
  );
}

/** Human ETA line for a queued recrawl: position in line + rough wait. */
function recrawlEta(r: RecrawlResult): string {
  const where =
    r.position != null ? (r.position <= 1 ? "next in line" : `#${r.position} in line`) : "queued";
  if (r.etaSeconds == null) return `${where} · crawled soon`;
  const mins = Math.max(1, Math.round(r.etaSeconds / 60));
  const wait = r.etaSeconds < 90 ? "under a minute" : mins < 60 ? `~${mins} min` : "~1 hr+";
  return `${where} · ${wait}`;
}

/** Casual matches we've observed this player in — name match plus provable
 * concurrent play, with no same-name ambiguity (see server/sightings.ts). */
function SightingsSection({ sightings }: { sightings: PlayerSightings }) {
  return (
    <div>
      <h2 className="mb-2 font-heading text-lg font-semibold">
        Recent sightings
        <InfoTip
          className="ml-1.5"
          text="Name seen by sampler + confirmed by playtime gain, last 30d. Strong inference, not certain."
        />
      </h2>
      {sightings.sightings.length > 0 ? (
        <FilterableList
          items={sightings.sightings}
          filterBy={(s) => s.map ?? ""}
          noun="sightings"
          placeholder="filter maps…"
          minFilterItems={12}
          maxHeightClassName="max-h-[24rem]"
        >
          {({ visible, scrollClass, stickyHeaderClass, emptyText }) => (
            <Table containerClassName={scrollClass}>
              <TableHeader className={stickyHeaderClass}>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Map</TableHead>
                  <TableHead className="w-40">Region</TableHead>
                  <TableHead className="w-28 text-right">When</TableHead>
                  <TableHead className="w-28 text-right">Score gain</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((s) => (
                  <TableRow key={s.segmentId} className="h-9">
                    <TableCell className="py-1 font-mono text-xs">{s.map || "—"}</TableCell>
                    <TableCell className="py-1 text-xs text-muted-foreground">
                      {regionLabel(s.region)}
                    </TableCell>
                    <TableCell
                      className="py-1 text-right font-mono text-xs tabular-nums text-muted-foreground"
                      suppressHydrationWarning
                    >
                      {formatAgo(new Date(s.startedAt * 1000).toISOString())}
                    </TableCell>
                    <TableCell className="py-1 text-right font-mono text-xs tabular-nums">
                      {s.scoreGain === null ? "—" : `+${s.scoreGain.toLocaleString()}`}
                    </TableCell>
                  </TableRow>
                ))}
                {emptyText && (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={4} className="py-4 text-center text-muted-foreground">
                      {emptyText}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </FilterableList>
      ) : (
        <p className="text-sm text-muted-foreground">
          No unambiguous sightings in the last 30 days.
        </p>
      )}
      {sightings.ambiguous > 0 && (
        <p className="mt-1 text-xs text-muted-foreground">
          {sightings.ambiguous.toLocaleString()} hidden (name shared by another active player).
        </p>
      )}
    </div>
  );
}

/** Compact play-length label from seconds: "1h 20m", "45m", or "<1m". */
function formatSessionLength(seconds: number): string {
  const mins = Math.round(seconds / 60);
  if (mins < 1) return "<1m";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h${m > 0 ? ` ${m}m` : ""}` : `${m}m`;
}

/** Reconstructed play sessions from stat-snapshot deltas (server/sessions.ts):
 * when the player played, how long, on which class(es), and the map when we
 * can pin it. Only shown for players the attributor has matched to sampler
 * segments — hence gated on a non-empty list by the caller. */
function SessionsSection({ sessions }: { sessions: PlayerSessions }) {
  return (
    <div>
      <h2 className="mb-2 font-heading text-lg font-semibold">
        Recent sessions
        <InfoTip
          className="ml-1.5"
          text="Reconstructed from stat-snapshot gaps. Map shown only when pinnable."
        />
      </h2>
      <FilterableList items={sessions.sessions} maxHeightClassName="max-h-[24rem]">
        {({ visible, scrollClass, stickyHeaderClass }) => (
          <Table containerClassName={scrollClass}>
            <TableHeader className={stickyHeaderClass}>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-28 text-right">When</TableHead>
                <TableHead className="w-24 text-right">Played</TableHead>
                <TableHead>Classes</TableHead>
                <TableHead className="hidden w-40 sm:table-cell">Map</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((s) => (
                <TableRow key={`${s.startedAt}:${s.endedAt}`} className="h-9">
                  <TableCell
                    className="py-1 text-right font-mono text-xs tabular-nums text-muted-foreground"
                    suppressHydrationWarning
                  >
                    {formatAgo(new Date(s.endedAt * 1000).toISOString())}
                  </TableCell>
                  <TableCell className="py-1 text-right font-mono text-sm tabular-nums">
                    {formatSessionLength(s.playtimeSeconds)}
                  </TableCell>
                  <TableCell className="py-1">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      {s.classes.map((c) => (
                        <span key={c.classNum} className="flex items-center gap-1">
                          {CLASS_NAMES[c.classNum] && (
                            <img
                              src={`/${CLASS_NAMES[c.classNum]}.svg`}
                              alt={CLASS_NAMES[c.classNum]}
                              title={CLASS_NAMES[c.classNum]}
                              className="h-4 w-4"
                            />
                          )}
                          <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                            {formatSessionLength(c.seconds)}
                          </span>
                        </span>
                      ))}
                    </span>
                  </TableCell>
                  <TableCell className="hidden py-1 font-mono text-xs text-muted-foreground sm:table-cell">
                    {s.map ?? "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </FilterableList>
    </div>
  );
}

const INVENTORY_PREVIEW = 96;

function InventorySection({ rows }: { rows: InventoryRow[] }) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? rows : rows.slice(0, INVENTORY_PREVIEW);
  const totalItems = rows.reduce((a, r) => a + r.count, 0);

  return (
    <div>
      <h2 className="mb-2 font-heading text-lg font-semibold">
        Inventory{" "}
        <span className="text-sm font-normal text-muted-foreground">
          ({totalItems.toLocaleString()} items, {rows.length.toLocaleString()} distinct)
        </span>
      </h2>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(3rem,1fr))] gap-1.5">
        {visible.map((r) => (
          <Link
            key={`${r.defindex}:${r.quality}`}
            to="/item/$defindex"
            params={{ defindex: r.defindex }}
            title={`${qualityName(r.quality)} ${itemDisplayName(r)}${r.count > 1 ? ` ×${r.count}` : ""}`}
            className="relative flex aspect-square items-center justify-center rounded border bg-card/50 p-1 transition-colors hover:bg-accent"
            style={{ borderColor: qualityColor(r.quality) }}
          >
            {r.imageUrl ? (
              <img src={r.imageUrl} alt="" loading="lazy" className="max-h-full max-w-full" />
            ) : (
              <span className="font-mono text-[9px] text-muted-foreground">#{r.defindex}</span>
            )}
            {r.count > 1 && (
              <span className="absolute right-0.5 bottom-0.5 rounded bg-background/80 px-0.5 font-mono text-[9px] leading-tight text-muted-foreground">
                ×{r.count}
              </span>
            )}
          </Link>
        ))}
      </div>
      {!showAll && rows.length > INVENTORY_PREVIEW && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="mt-2 rounded-md border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent"
        >
          show all {rows.length.toLocaleString()}
        </button>
      )}
    </div>
  );
}
