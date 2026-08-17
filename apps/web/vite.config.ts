import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [
    nitro({
      // CDN caching on stat pages (equivalent of styletf's revalidate: 3600).
      // NOT Vercel ISR: its prerender wrapper strips query params from the
      // request (verified 2026-08-17), breaking filtered SSR. s-maxage caches
      // per full URL (query included) on Vercel's CDN instead.
      routeRules: {
        "/usage": {
          headers: {
            "cache-control": "public, s-maxage=3600, stale-while-revalidate=86400",
          },
        },
      },
    }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
});
