import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [
    nitro({
      // ISR on stat pages — the tracker.tf equivalent of styletf's
      // Next.js `revalidate: 3600`. allowQuery is REQUIRED: without it Vercel
      // caches one page for every filter combination (query params ignored).
      routeRules: {
        "/usage": {
          isr: {
            expiration: 3600,
            allowQuery: ["class", "slot", "active", "minutes", "merge", "pdas"],
          },
        },
      },
    }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
});
