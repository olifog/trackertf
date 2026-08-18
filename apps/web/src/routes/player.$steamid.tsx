import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "#/components/ui/table";
import {
  avatarUrl,
  CLASS_NAMES,
  formatAgo,
  formatHours,
  itemDisplayName,
  SLOT_NAMES,
} from "#/lib/tf2";
import { BOARD_MAP } from "@trackertf/db/boards";
import { playerRanksQueryOptions } from "#/server/leaderboards";
import { playerQueryOptions } from "#/server/player";

export const Route = createFileRoute("/player/$steamid")({
  loader: ({ context, params }) =>
    Promise.all([
      context.queryClient.ensureQueryData(playerQueryOptions(params.steamid)),
      context.queryClient.ensureQueryData(playerRanksQueryOptions(params.steamid)),
    ]),
  component: PlayerPage,
});

const CLASS_ORDER = [1, 3, 7, 4, 6, 9, 5, 2, 8];

function PlayerPage() {
  const { steamid } = Route.useParams();
  const { data: p } = useSuspenseQuery(playerQueryOptions(steamid));
  const { data: ranks } = useSuspenseQuery(playerRanksQueryOptions(steamid));
  const bestRanks = ranks.slice(0, 20);

  if (!p.found) {
    return (
      <div className="space-y-3">
        <h1 className="font-heading text-2xl font-bold">Player not crawled yet</h1>
        <p className="text-muted-foreground">
          <span className="font-mono">{steamid}</span> isn't in the dataset yet.
          {p.queued
            ? " It's been queued for crawling — check back in a few minutes."
            : " Queueing failed; try again later."}
        </p>
      </div>
    );
  }

  const totalClassSeconds = p.classStats.reduce((a, c) => a + c.playtimeSeconds, 0);
  const sortedStats = p.classStats.toSorted((a, b) => b.playtimeSeconds - a.playtimeSeconds);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
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
        </div>
      </div>

      {sortedStats.length > 0 ? (
        <div>
          <h2 className="mb-2 font-heading text-lg font-semibold">Class stats (lifetime)</h2>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Class</TableHead>
                <TableHead className="text-right">Hours</TableHead>
                <TableHead className="text-right">Share</TableHead>
                <TableHead className="text-right">Kills</TableHead>
                <TableHead className="text-right">Kills / hr</TableHead>
                <TableHead className="text-right">Points / min</TableHead>
                <TableHead className="text-right">Dmg / min</TableHead>
                <TableHead className="text-right">Assists</TableHead>
                <TableHead className="text-right">Caps</TableHead>
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
                  <TableCell className="py-1 text-right font-mono text-xs tabular-nums text-muted-foreground">
                    {totalClassSeconds > 0
                      ? `${((c.playtimeSeconds / totalClassSeconds) * 100).toFixed(0)}%`
                      : "—"}
                  </TableCell>
                  <TableCell className="py-1 text-right font-mono text-sm tabular-nums">
                    {c.kills.toLocaleString()}
                  </TableCell>
                  <TableCell className="py-1 text-right font-mono text-sm tabular-nums">
                    {c.playtimeSeconds > 0
                      ? ((c.kills * 3600) / c.playtimeSeconds).toFixed(1)
                      : "—"}
                  </TableCell>
                  <TableCell className="py-1 text-right font-mono text-sm tabular-nums">
                    {c.playtimeSeconds > 0
                      ? ((c.pointsScored * 60) / c.playtimeSeconds).toFixed(2)
                      : "—"}
                  </TableCell>
                  <TableCell className="py-1 text-right font-mono text-sm tabular-nums">
                    {c.playtimeSeconds > 0
                      ? ((c.damageDealt * 60) / c.playtimeSeconds).toFixed(0)
                      : "—"}
                  </TableCell>
                  <TableCell className="py-1 text-right font-mono text-xs tabular-nums text-muted-foreground">
                    {c.killAssists.toLocaleString()}
                  </TableCell>
                  <TableCell className="py-1 text-right font-mono text-xs tabular-nums text-muted-foreground">
                    {c.captures.toLocaleString()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p className="mt-1 text-xs text-muted-foreground">
            No deaths stat exists in Steam's TF2 data, so no K/D — see{" "}
            <a href="/methodology" className="underline">
              methodology
            </a>
            .
          </p>
        </div>
      ) : (
        <p className="text-muted-foreground">Game stats are private for this player.</p>
      )}

      {bestRanks.length > 0 && (
        <div>
          <h2 className="mb-2 font-heading text-lg font-semibold">Leaderboard positions</h2>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Board</TableHead>
                <TableHead className="w-32 text-right">Rank</TableHead>
                <TableHead className="w-32 text-right">Value</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {bestRanks.map((r) => (
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
            </TableBody>
          </Table>
          <p className="mt-1 text-xs text-muted-foreground">
            Best {bestRanks.length} of {ranks.length} boards, ranked live among crawled players.
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
                      <li
                        key={`${e.slot}:${e.defindex}`}
                        className="flex items-center gap-2 text-[13px]"
                      >
                        {e.imageUrl && <img src={e.imageUrl} alt="" className="h-5 w-5" />}
                        <Link
                          to="/item/$defindex"
                          params={{ defindex: e.defindex }}
                          className="hover:underline"
                        >
                          {itemDisplayName(e)}
                        </Link>
                        <span className="ml-auto font-mono text-[10px] text-muted-foreground/60">
                          {SLOT_NAMES[e.slot]}
                        </span>
                      </li>
                    ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
