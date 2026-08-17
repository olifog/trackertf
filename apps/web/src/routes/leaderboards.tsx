import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, stripSearchParams } from "@tanstack/react-router";
import { z } from "zod";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "#/components/ui/table";
import { avatarUrl, CLASS_NAMES } from "#/lib/tf2";
import { BOARD_LABELS, type BoardKey, leaderboardQueryOptions } from "#/server/leaderboards";

const searchSchema = z.object({
  board: z.enum(["hours", "kills", "killsPerHour", "pointsPerMin"]).catch("hours").default("hours"),
});

export const Route = createFileRoute("/leaderboards")({
  validateSearch: searchSchema,
  search: { middlewares: [stripSearchParams({ board: "hours" })] },
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) =>
    context.queryClient.ensureQueryData(leaderboardQueryOptions(deps.board)),
  component: LeaderboardsPage,
});

function LeaderboardsPage() {
  const { board } = Route.useSearch();
  const { data: rows } = useSuspenseQuery(leaderboardQueryOptions(board));

  return (
    <div className="space-y-5">
      <h1 className="font-heading text-2xl font-bold">Leaderboards</h1>

      <div className="inline-flex overflow-hidden rounded-md border divide-x divide-border">
        {(Object.keys(BOARD_LABELS) as BoardKey[]).map((key) => (
          <Link
            key={key}
            from={Route.fullPath}
            search={{ board: key }}
            className={`flex h-8 items-center px-3 text-[13px] leading-none transition-colors ${
              board === key
                ? "bg-primary font-medium text-primary-foreground"
                : "bg-secondary/40 text-secondary-foreground hover:bg-accent"
            }`}
          >
            {BOARD_LABELS[key]}
          </Link>
        ))}
      </div>

      <p className="text-xs text-muted-foreground">
        Among crawled players with public profiles, no VAC bans. Rate boards require 50+ hours on
        the class. The sample skews connected/veteran players — see{" "}
        <a href="/methodology" className="underline">
          methodology
        </a>
        .
      </p>

      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-10 text-right">#</TableHead>
            <TableHead className="w-9" />
            <TableHead>Player</TableHead>
            {(board === "killsPerHour" || board === "pointsPerMin") && (
              <TableHead className="w-24">Class</TableHead>
            )}
            <TableHead className="w-32 text-right">{BOARD_LABELS[board]}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, i) => (
            <TableRow key={row.steamid} className="h-9">
              <TableCell className="py-1 text-right font-mono text-muted-foreground">
                {i + 1}
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
              {(board === "killsPerHour" || board === "pointsPerMin") && (
                <TableCell className="py-1 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1.5">
                    {row.classNum !== null && CLASS_NAMES[row.classNum] && (
                      <img
                        src={`/${CLASS_NAMES[row.classNum]}.svg`}
                        alt=""
                        className="h-3.5 w-3.5"
                      />
                    )}
                    {row.classNum !== null ? CLASS_NAMES[row.classNum] : ""}
                  </span>
                </TableCell>
              )}
              <TableCell className="py-1 text-right font-mono text-sm tabular-nums">
                {row.value.toLocaleString()}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
