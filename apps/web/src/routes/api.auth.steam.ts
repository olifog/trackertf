import { createFileRoute } from "@tanstack/react-router";

const OPENID_NS = "http://specs.openid.net/auth/2.0";

export const Route = createFileRoute("/api/auth/steam")({
  server: {
    handlers: {
      GET: ({ request }) => {
        const origin = new URL(request.url).origin;
        const params = new URLSearchParams({
          "openid.ns": OPENID_NS,
          "openid.mode": "checkid_setup",
          "openid.identity": `${OPENID_NS}/identifier_select`,
          "openid.claimed_id": `${OPENID_NS}/identifier_select`,
          "openid.return_to": `${origin}/api/auth/steam/callback`,
          "openid.realm": origin,
        });
        return Response.redirect(`https://steamcommunity.com/openid/login?${params}`, 302);
      },
    },
  },
});
