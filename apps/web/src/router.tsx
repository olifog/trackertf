import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { Skeleton } from "./components/ui/skeleton";
import { routeTree } from "./routeTree.gen";

/** generic page shape (heading + filter card + table rows) shown while a
 * route's loader is in flight for more than defaultPendingMs */
function PendingSkeleton() {
  return (
    <div className="space-y-5">
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-24 w-full rounded-lg" />
      <div className="space-y-2 pt-2">
        {Array.from({ length: 12 }, (_, i) => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton className="h-6 w-8" />
            <Skeleton className="h-6 w-6" />
            <Skeleton className="h-6 flex-1" />
            <Skeleton className="h-6 w-28" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function getRouter() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: 60_000 } },
  });

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreload: "intent",
    defaultPendingComponent: PendingSkeleton,
    defaultPendingMs: 100,
    defaultPendingMinMs: 300,
  });

  setupRouterSsrQueryIntegration({ router, queryClient });

  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
