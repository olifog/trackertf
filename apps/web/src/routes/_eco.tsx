import { createFileRoute, Link, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/_eco")({
  component: EcoLayout,
});

const ECO_TABS = [
  { to: "/servers", label: "Servers" },
  { to: "/matches", label: "Matches" },
  { to: "/health", label: "Data" },
] as const;

/** Persistent sub-tab bar shared by the ecosystem section (Servers · Matches ·
 * Data). Pathless layout, so the public URLs stay unchanged. */
function EcoLayout() {
  return (
    <div className="space-y-6">
      <div className="-mx-4 overflow-x-auto border-b px-4 sm:mx-0 sm:px-0">
        <nav className="flex items-center gap-1">
          {ECO_TABS.map((tab) => (
            <Link
              key={tab.to}
              to={tab.to}
              className="-mb-px shrink-0 border-b-2 border-transparent px-3 pb-2 pt-1 text-sm text-muted-foreground transition-colors hover:border-border hover:text-foreground"
              activeProps={{
                className:
                  "-mb-px shrink-0 border-b-2 border-primary px-3 pb-2 pt-1 text-sm font-semibold text-foreground",
              }}
            >
              {tab.label}
            </Link>
          ))}
        </nav>
      </div>
      <Outlet />
    </div>
  );
}
