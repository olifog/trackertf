# tracker.tf

TF2 statistics — successor to [style.tf](https://style.tf). See `PLAN.md` for the
full architecture, verified Steam API research, and staged roadmap.

## Layout

- `apps/web` — TanStack Start site (Vercel; ISR on stat pages)
- `apps/crawler` — Bun crawler (Docker on the VPS)
- `packages/db` — Drizzle schema + Postgres client
- `packages/steam` — typed, zod-validated, rate-limited Steam Web API client
- `packages/tf2-schema` — TF2 item schema sync

## Dev

```sh
bun install
docker compose -f docker-compose.dev.yml up -d   # local postgres
cp .env.example .env                             # add your STEAM_API_KEY
bun run --cwd packages/db generate               # generate migrations
bun run --cwd packages/db migrate
bun run --cwd apps/crawler sync-schema           # populate item_schema
bun run --cwd apps/crawler seed <steamid64>      # seed the frontier
bun run dev                                      # turbo: web + crawler
```

Checks: `bun run typecheck` (tsgo), `bun run lint` (oxlint), `bun run fmt` (oxfmt).

## Deploy

- Web: Vercel, root directory `apps/web` (framework: TanStack Start/Vite).
- Crawler + Postgres: `docker compose up -d --build` on the VPS with `.env` set.
