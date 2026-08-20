#!/usr/bin/env bash
# Deploy the crawler stack + apply DB migrations to the EC2 box.
#
# The web app (apps/web) deploys itself via Vercel's GitHub integration on push
# to main — this script only handles the half that Vercel can't: the crawler
# image (analyser/crawler/syncer/scanner/sampler) and the Drizzle migrations
# against RDS (RDS is only reachable from inside the VPC, i.e. from this box).
#
# Idempotent. Run from the repo root:  ./scripts/deploy.sh
#
# Prereqs on the runner:
#   - SSH access to the box (your IP must be in trackertf-sg's port-22 rule; a
#     rotated dynamic IP is the usual reason this hangs — re-add it with:
#     aws ec2 authorize-security-group-ingress --group-id <sg> \
#       --ip-permissions 'IpProtocol=tcp,FromPort=22,ToPort=22,IpRanges=[{CidrIp='"$(curl -s https://checkip.amazonaws.com)"'/32}]')
#   - The box already holds .env, certs/, and ~/ttf-rds-pw.
set -euo pipefail

HOST="${DEPLOY_HOST:-ubuntu@3.221.236.27}"
REMOTE_DIR="${DEPLOY_DIR:-/home/ubuntu/services/trackertf}"
SSH_OPTS="${SSH_OPTS:--o ConnectTimeout=20}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$REPO_ROOT"

echo "==> [1/4] syncing source to $HOST:$REMOTE_DIR"
# Only the crawler image consumes these; the box's .env/certs/data are never in
# these paths, so they're safe from the sync. No lockfile/package.json sync —
# add deps in a separate, deliberate step so --frozen-lockfile can't break here.
RSYNC=(rsync -az --exclude 'node_modules' --exclude '.output' --exclude 'dist' -e "ssh $SSH_OPTS")
"${RSYNC[@]}" apps/crawler/src/    "$HOST:$REMOTE_DIR/apps/crawler/src/"
"${RSYNC[@]}" packages/db/src/     "$HOST:$REMOTE_DIR/packages/db/src/"
"${RSYNC[@]}" packages/db/drizzle/ "$HOST:$REMOTE_DIR/packages/db/drizzle/"
"${RSYNC[@]}" packages/steam/src/  "$HOST:$REMOTE_DIR/packages/steam/src/"
"${RSYNC[@]}" packages/clickhouse/src/ "$HOST:$REMOTE_DIR/packages/clickhouse/src/"

echo "==> [2/4] building images on the box"
ssh $SSH_OPTS "$HOST" "cd $REMOTE_DIR && docker compose build"

echo "==> [3/4] applying pending migrations to RDS"
ssh $SSH_OPTS "$HOST" "cd $REMOTE_DIR && docker compose run --rm crawler bun run /app/packages/db/src/migrate.ts"

echo "==> [4/4] restarting services on the new images"
# migrate runs BEFORE this so the analyser never boots against a stale schema.
ssh $SSH_OPTS "$HOST" "cd $REMOTE_DIR && docker compose up -d && docker compose ps --format '{{.Service}}\t{{.Status}}'"

echo "==> done. tailing analyser (Ctrl-C to stop):"
ssh $SSH_OPTS "$HOST" "cd $REMOTE_DIR && docker compose logs --tail=5 analyser"
