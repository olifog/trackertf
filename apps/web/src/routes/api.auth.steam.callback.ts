import { createFileRoute } from "@tanstack/react-router";
import { schema } from "@trackertf/db";
import { eq, sql } from "drizzle-orm";
import { getDb } from "#/server/db.ts";
import { sessionSetCookie } from "#/server/session.ts";

export const Route = createFileRoute("/api/auth/steam/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const origin = url.origin;
        if (url.searchParams.get("openid.mode") !== "id_res") {
          return Response.redirect(`${origin}/`, 302);
        }

        // verify the assertion directly with Steam
        const verify = new URLSearchParams(url.searchParams);
        verify.set("openid.mode", "check_authentication");
        const res = await fetch("https://steamcommunity.com/openid/login", {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            accept: "text/plain",
          },
          body: verify.toString(),
        });
        const body = res.ok ? await res.text() : "";
        if (!/is_valid\s*:\s*true/.test(body)) {
          return new Response("Steam OpenID verification failed", { status: 403 });
        }

        const claimed = url.searchParams.get("openid.claimed_id") ?? "";
        const steamid = claimed.match(
          /^https?:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/,
        )?.[1];
        if (!steamid) return new Response("Unexpected claimed_id", { status: 400 });

        // enqueue for crawling if we've never seen this player
        try {
          const db = getDb();
          const [known] = await db
            .select({ steamid: schema.players.steamid })
            .from(schema.players)
            .where(eq(schema.players.steamid, steamid))
            .limit(1);
          if (!known) {
            await db.execute(sql`
              insert into crawl_frontier (steamid, source, priority)
              values (${steamid}, 'seed', 10)
              on conflict (steamid) do nothing
            `);
          }
        } catch {
          // login still succeeds if the frontier insert fails
        }

        return new Response(null, {
          status: 302,
          headers: {
            location: `${origin}/player/${steamid}`,
            "set-cookie": sessionSetCookie(steamid),
          },
        });
      },
    },
  },
});
