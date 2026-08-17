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
      // Next.js `revalidate: 3600`. Vercel maps this onto its ISR infra.
      routeRules: {
        "/usage": { isr: { expiration: 3600 } },
      },
    }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
});
