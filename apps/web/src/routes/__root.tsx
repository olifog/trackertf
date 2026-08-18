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
import { getSessionUser, type SessionUser } from "#/server/session";

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
  loader: () => getSessionUser(),
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

function AuthNav({ user }: { user: SessionUser | null | undefined }) {
  if (!user) {
    return (
      <a href="/api/auth/steam" className="text-sm text-muted-foreground hover:text-foreground">
        Sign in through Steam
      </a>
    );
  }
  return (
    <div className="flex items-center gap-2.5">
      <Link
        to="/player/$steamid"
        params={{ steamid: user.steamid }}
        title={user.personaname ?? "Your profile"}
        className="flex items-center"
      >
        {user.avatarHash ? (
          <img
            src={`https://avatars.steamstatic.com/${user.avatarHash}.jpg`}
            alt={user.personaname ?? "Your profile"}
            className="h-6 w-6 rounded"
          />
        ) : (
          <span className="text-sm text-muted-foreground hover:text-foreground">
            {user.personaname ?? "Profile"}
          </span>
        )}
      </Link>
      <a href="/api/auth/logout" className="text-xs text-muted-foreground hover:text-foreground">
        Sign out
      </a>
    </div>
  );
}

function RootDocument({ children }: { children: React.ReactNode }) {
  const user = Route.useLoaderData();
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
            <AuthNav user={user} />
          </nav>
        </header>
        <main className="mx-auto max-w-4xl px-6 py-8">{children}</main>
        <Scripts />
      </body>
    </html>
  );
}
