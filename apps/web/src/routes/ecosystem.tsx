import { createFileRoute, redirect } from "@tanstack/react-router";

// The ecosystem page was merged into /servers (live state) and /health → Data
// (crawled corpus + class playtime). This route now just redirects.
export const Route = createFileRoute("/ecosystem")({
  beforeLoad: () => {
    throw redirect({ to: "/servers" });
  },
});
