#!/usr/bin/env bash
# Self-signed TLS cert for ClickHouse's HTTPS port (8443). Vercel pins this cert
# via CLICKHOUSE_CA_CERT and verifies the hostname, so the cert needs a
# subjectAltName matching ch.tracker.tf (Node 17+ ignores CN for hostname
# checks). The clickhouse-server container reads these read-only, so they must
# be world-readable (single-tenant box; the key only protects transport — the
# real access control is CLICKHOUSE_PASSWORD).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p certs
openssl req -new -x509 -days 3650 -nodes \
  -out certs/server.crt -keyout certs/server.key \
  -subj "/CN=ch.tracker.tf" \
  -addext "subjectAltName=DNS:ch.tracker.tf"
chmod 644 certs/server.crt certs/server.key
echo "wrote certs/server.crt + certs/server.key"
