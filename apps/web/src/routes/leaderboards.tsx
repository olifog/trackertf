import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, stripSearchParams, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "#/components/ui/table";
import { BOARD_MAP, BOARDS, type BoardDef, MIN_RATE_HOURS } from "@trackertf/db/boards";
import { avatarUrl, CLASS_NAMES } from "#/lib/tf2";
import { leaderboardQueryOptions } from "#/server/leaderboards";

const searchSchema = z.object({
  board: z
    .string()
    .refine((key) => BOARD_MAP.has(key))
    .catch("hours")
    .default("hours"),
});

export const Route = createFileRoute("/leaderboards")({
  validateSearch: searchSchema,
  search: { middlewares: [stripSearchParams({ board: "hours" })] },
  loaderDeps: ({ search }) => search,
  loader: ({ context, deps }) =>
    context.queryClient.ensureQueryData(leaderboardQueryOptions(deps.board)),
  component: LeaderboardsPage,
});

/** boards grouped by scope for the <select>: Overall first, then each class */
const BOARD_GROUPS: { label: string; boards: BoardDef[] }[] = [
  { label: "Overall", boards: BOARDS.filter((b) => b.scope === "overall") },
  ...Object.entries(CLASS_NAMES).map(([num, name]) => ({
    label: name,
    boards: BOARDS.filter((b) => b.scope === Number(num)),
  })),
];

function formatValue(value: number, decimals: number): string {
  return value.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function LeaderboardsPage() {
  const { board } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { data: rows } = useSuspenseQuery(leaderboardQueryOptions(board));
  const def = BOARD_MAP.get(board) as BoardDef;
  const perClass = def.scope !== "overall";

  return (
    <div className="space-y-5">
      <h1 className="font-heading text-2xl font-bold">Leaderboards</h1>

      <label className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">Board</span>
        <select
          value={board}
          onChange={(e) => void navigate({ search: { board: e.target.value } })}
          className="h-8 max-w-full rounded-md border bg-secondary/40 px-2 text-[13px] text-secondary-foreground"
        >
          {BOARD_GROUPS.map((group) => (
            <optgroup key={group.label} label={group.label}>
              {group.boards.map((b) => (
                <option key={b.key} value={b.key}>
                  {b.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>

      <p className="text-xs text-muted-foreground">
        Among crawled players with public profiles, no VAC bans. Rate boards require{" "}
        {MIN_RATE_HOURS}+ hours on the scope. The sample skews connected/veteran players — see{" "}
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
            {perClass && <TableHead className="w-24">Class</TableHead>}
            <TableHead className="w-40 text-right">{def.valueLabel}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
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
              {perClass && (
                <TableCell className="py-1 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1.5">
                    {CLASS_NAMES[def.scope as number] && (
                      <img
                        src={`/${CLASS_NAMES[def.scope as number]}.svg`}
                        alt=""
                        className="h-3.5 w-3.5"
                      />
                    )}
                    {CLASS_NAMES[def.scope as number]}
                  </span>
                </TableCell>
              )}
              <TableCell className="py-1 text-right font-mono text-sm tabular-nums">
                {formatValue(row.value, def.decimals)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
