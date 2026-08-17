import { createFileRoute, Link } from "@tanstack/react-router";
import { buttonVariants } from "#/components/ui/button";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  return (
    <div className="flex flex-col items-start gap-6">
      <div className="flex items-center gap-4">
        <img src="/logo.png" alt="tracker.tf logo" className="h-16 w-16" />
        <h1 className="font-heading text-4xl font-bold">tracker.tf</h1>
      </div>
      <p className="max-w-prose text-muted-foreground">
        A central source for Team Fortress 2 statistics — the successor to style.tf. Weapon usage
        rates, loadout combinations, class stats and playerbase trends, focused on official casual.
      </p>
      <Link to="/usage" className={buttonVariants({ size: "lg" })}>
        Explore weapon usage →
      </Link>
    </div>
  );
}
