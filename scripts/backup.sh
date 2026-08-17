#!/usr/bin/env bash
# Nightly pg_dump → R2. Cron: 0 4 * * * /home/ubuntu/services/trackertf/scripts/backup.sh
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose exec -T postgres pg_dump -U trackertf -Fc trackertf |
  docker compose run --rm -T --no-deps crawler bun run src/backup-upload.ts
