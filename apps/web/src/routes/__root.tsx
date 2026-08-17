import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, HeadContent, Link, Scripts } from "@tanstack/react-router";

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
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  shellComponent: RootDocument,
});

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="bg-slate-950 text-slate-100">
      <head>
        <HeadContent />
      </head>
      <body className="min-h-screen">
        <header className="border-b border-slate-800 px-6 py-4">
          <nav className="mx-auto flex max-w-4xl items-center gap-6">
            <Link to="/" className="text-lg font-bold text-amber-400">
              tracker.tf
            </Link>
            <Link
              to="/usage"
              className="text-sm text-slate-300 hover:text-white"
              activeProps={{ className: "text-sm text-white font-semibold" }}
            >
              Weapon usage
            </Link>
          </nav>
        </header>
        <main className="mx-auto max-w-4xl px-6 py-8">{children}</main>
        <Scripts />
      </body>
    </html>
  );
}
