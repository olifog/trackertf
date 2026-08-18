import { createFileRoute, Link } from "@tanstack/react-router";
import { buttonVariants } from "#/components/ui/button";
import { avatarUrl } from "#/lib/tf2";
import { fetchPlayer } from "#/server/player";
import { getSession } from "#/server/session";

export const Route = createFileRoute("/")({
  loader: async () => {
    const session = await getSession();
    if (!session) return { me: null };
    // fetchPlayer auto-enqueues unknown steamids into the crawl frontier
    return { me: await fetchPlayer({ data: { steamid: session.steamid } }) };
  },
  component: Home,
});

function Home() {
  const { me } = Route.useLoaderData();
  return (
    <div className="flex flex-col items-start gap-6">
      <div className="flex items-center gap-4">
        <img src="/logo.png" alt="tracker.tf logo" className="h-16 w-16" />
        <h1 className="font-heading text-4xl font-bold">tracker.tf</h1>
      </div>
      <p className="max-w-prose text-muted-foreground">
        Team Fortress 2 weapon usage rates, loadout combinations, class stats and playerbase trends,
        focused on official casual.
      </p>
      <Link to="/usage" className={buttonVariants({ size: "lg" })}>
        Weapon usage →
      </Link>
      {me && (
        <div className="flex w-full max-w-prose items-center gap-3 rounded-lg border bg-card/50 p-4">
          {avatarUrl(me.avatarHash) && (
            <img src={avatarUrl(me.avatarHash) as string} alt="" className="h-10 w-10 rounded-md" />
          )}
          <div className="min-w-0">
            <Link
              to="/player/$steamid"
              params={{ steamid: me.steamid }}
              className="font-medium text-primary hover:underline"
            >
              {me.found && me.personaname ? me.personaname : "Your stats"} →
            </Link>
            <p className="text-xs text-muted-foreground">
              {me.found
                ? "Your class stats and loadouts, as seen by the crawler."
                : "Your profile hasn't been crawled yet. It's queued, check back soon."}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
