import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  return (
    <div className="space-y-4">
      <h1 className="text-3xl font-bold">tracker.tf</h1>
      <p className="text-slate-300">
        A central source for Team Fortress 2 statistics — the successor to style.tf. Weapon usage
        rates, loadout combinations, class stats and playerbase trends, focused on official casual.
      </p>
      <Link
        to="/usage"
        className="inline-block rounded bg-amber-500 px-4 py-2 font-semibold text-slate-950 hover:bg-amber-400"
      >
        Explore weapon usage →
      </Link>
    </div>
  );
}
