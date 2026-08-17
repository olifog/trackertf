#!/usr/bin/env bash
# Self-signed TLS cert for Postgres (clients use sslmode=require, no CA verify).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p certs
openssl req -new -x509 -days 3650 -nodes \
  -out certs/server.crt -keyout certs/server.key \
  -subj "/CN=db.tracker.tf"
# postgres in the official image runs as uid 999 and requires 0600 on the key
sudo chown 999:999 certs/server.key certs/server.crt
sudo chmod 600 certs/server.key
echo "wrote certs/server.crt + certs/server.key"
