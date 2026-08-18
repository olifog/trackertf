import { createFileRoute } from "@tanstack/react-router";
import { sessionClearCookie } from "#/server/session.ts";

export const Route = createFileRoute("/api/auth/logout")({
  server: {
    handlers: {
      GET: ({ request }) =>
        new Response(null, {
          status: 302,
          headers: {
            location: `${new URL(request.url).origin}/`,
            "set-cookie": sessionClearCookie(),
          },
        }),
    },
  },
});
