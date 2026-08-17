import type { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  HeadContent,
  Link,
  Scripts,
  useNavigate,
} from "@tanstack/react-router";
import { useState } from "react";
import { lookupPlayer } from "#/server/player";

import appCss from "../styles.css?url";

export interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "tracker.tf | TF2 statistics" },
      {
        name: "description",
        content:
          "Team Fortress 2 statistics: weapon usage rates, loadouts, class stats and playerbase trends.",
      },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: "/favicon.ico" },
    ],
  }),
  shellComponent: RootDocument,
});

function NavLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <Link
      to={to}
      className="text-sm text-muted-foreground hover:text-foreground"
      activeProps={{ className: "text-sm font-semibold text-foreground" }}
    >
      {children}
    </Link>
  );
}

function PlayerSearch() {
  const navigate = useNavigate();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!value.trim() || busy) return;
    setBusy(true);
    try {
      const { steamid } = await lookupPlayer({ data: { query: value } });
      if (steamid) {
        setValue("");
        await navigate({ to: "/player/$steamid", params: { steamid } });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="ml-auto">
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="steamid / profile url…"
        className={`h-7 w-44 rounded-md border bg-secondary/40 px-2 font-mono text-xs outline-none placeholder:text-muted-foreground/60 focus:border-ring ${busy ? "opacity-50" : ""}`}
      />
    </form>
  );
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        <HeadContent />
      </head>
      <body className="min-h-screen">
        <header className="border-b px-6 py-3">
          <nav className="mx-auto flex max-w-4xl items-center gap-5">
            <Link to="/" className="flex items-center gap-2">
              <img src="/logo.png" alt="" className="h-8 w-8" />
              <span className="font-heading text-lg font-bold text-primary">tracker.tf</span>
            </Link>
            <NavLink to="/usage">Usage</NavLink>
            <NavLink to="/leaderboards">Leaderboards</NavLink>
            <NavLink to="/health">Health</NavLink>
            <NavLink to="/methodology">Methodology</NavLink>
            <PlayerSearch />
          </nav>
        </header>
        <main className="mx-auto max-w-4xl px-6 py-8">{children}</main>
        <Scripts />
      </body>
    </html>
  );
}
