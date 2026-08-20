import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, HeadContent, Link, Scripts } from "@tanstack/react-router";
import { Analytics } from "@vercel/analytics/react";
import { MenuIcon } from "lucide-react";
import { useState } from "react";
import { CommandPalette } from "#/components/command-palette";
import { Sheet, SheetContent, SheetTrigger } from "#/components/ui/sheet";
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

const NAV_ITEMS = [
  { to: "/usage", label: "Usage" },
  { to: "/combos", label: "Combos" },
  { to: "/performance", label: "Performance" },
  { to: "/leaderboards", label: "Leaderboards" },
  { to: "/servers", label: "Servers" },
  { to: "/matches", label: "Matches" },
  { to: "/health", label: "Data" },
] as const;

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

/** Hamburger drawer holding the nav links on < md screens. */
function MobileNav() {
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        render={
          <button
            type="button"
            aria-label="Open menu"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground md:hidden"
          />
        }
      >
        <MenuIcon className="h-5 w-5" />
      </SheetTrigger>
      <SheetContent side="left">
        <Link to="/" onClick={() => setOpen(false)} className="flex items-center gap-2">
          <img src="/logo.png" alt="" className="h-8 w-8" />
          <span className="font-heading text-lg font-bold text-primary">tracker.tf</span>
        </Link>
        <nav className="flex flex-col gap-1">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              onClick={() => setOpen(false)}
              className="rounded-md px-2 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
              activeProps={{
                className: "rounded-md bg-accent px-2 py-2 text-sm font-semibold text-foreground",
              }}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </SheetContent>
    </Sheet>
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
        <header className="border-b px-4 py-3 sm:px-6">
          <nav className="mx-auto flex max-w-7xl items-center gap-3 sm:gap-5">
            <Link to="/" className="flex items-center gap-2">
              <img src="/logo.png" alt="" className="h-8 w-8" />
              <span className="font-heading text-lg font-bold text-primary">tracker.tf</span>
            </Link>
            <div className="hidden items-center gap-5 md:flex">
              {NAV_ITEMS.map((item) => (
                <NavLink key={item.to} to={item.to}>
                  {item.label}
                </NavLink>
              ))}
            </div>
            <CommandPalette />
            <a
              href="https://github.com/olifog/trackertf"
              target="_blank"
              rel="noreferrer"
              title="Source on GitHub"
              className="hidden text-muted-foreground hover:text-foreground sm:inline"
            >
              <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5" aria-hidden="true">
                <path d="M12 .5C5.37.5 0 5.87 0 12.5c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58 0-.29-.01-1.04-.02-2.05-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.73.08-.73 1.21.09 1.84 1.24 1.84 1.24 1.07 1.84 2.81 1.31 3.5 1 .11-.78.42-1.31.76-1.61-2.67-.3-5.47-1.34-5.47-5.95 0-1.31.47-2.39 1.24-3.23-.13-.31-.54-1.53.11-3.19 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6.01 0c2.29-1.55 3.3-1.23 3.3-1.23.65 1.66.24 2.88.12 3.19.77.84 1.23 1.92 1.23 3.23 0 4.62-2.81 5.64-5.49 5.94.43.37.81 1.1.81 2.22 0 1.61-.01 2.9-.01 3.29 0 .32.21.7.82.58A12 12 0 0 0 24 12.5C24 5.87 18.63.5 12 .5z" />
              </svg>
            </a>
            <AuthNav user={user} />
            <MobileNav />
          </nav>
        </header>
        <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6">{children}</main>
        <Analytics />
        <Scripts />
      </body>
    </html>
  );
}
