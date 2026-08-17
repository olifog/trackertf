FROM oven/bun:1.3-slim AS base
WORKDIR /app

# Install with the full workspace context so workspace:* links resolve.
COPY package.json bun.lock ./
COPY apps/crawler/package.json apps/crawler/
# web manifest is needed so the workspace lockfile validates (app itself isn't copied)
COPY apps/web/package.json apps/web/
COPY packages/db/package.json packages/db/
COPY packages/steam/package.json packages/steam/
COPY packages/tf2-schema/package.json packages/tf2-schema/
RUN bun install --frozen-lockfile --production

COPY packages packages
COPY apps/crawler apps/crawler

WORKDIR /app/apps/crawler
USER bun
CMD ["bun", "run", "src/index.ts"]
