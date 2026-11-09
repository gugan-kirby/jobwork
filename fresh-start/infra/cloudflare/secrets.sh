#!/usr/bin/env bash
# F-CW.7 (ADR-0009): generate this environment's secrets and give them to the API and the
# cron worker. Asks for the Supabase S3 keys; makes everything else. Run once, in your own
# terminal, from fresh-start/. The values go to Cloudflare and nowhere else; nothing is
# written to disk.
set -euo pipefail
cd "$(dirname "$0")/../.."

read -r -p "Supabase S3 access key ID: " ACCESS_KEY
read -r -s -p "Supabase S3 secret access key: " SECRET_KEY
echo

secret() { openssl rand -hex 32; }
SERVICE_TOKEN_SECRET="$(secret)"

api_json="$(cat <<JSON
{
  "SESSION_SECRET": "$(secret)",
  "SERVICE_TOKEN_SECRET": "${SERVICE_TOKEN_SECRET}",
  "PAYMENT_WEBHOOK_SECRET": "$(secret)",
  "CARRIER_WEBHOOK_SECRET": "$(secret)",
  "OBJECT_STORE_ACCESS_KEY": "${ACCESS_KEY}",
  "OBJECT_STORE_SECRET_KEY": "${SECRET_KEY}"
}
JSON
)"
worker_json="$(cat <<JSON
{
  "SERVICE_TOKEN_SECRET": "${SERVICE_TOKEN_SECRET}",
  "OBJECT_STORE_ACCESS_KEY": "${ACCESS_KEY}",
  "OBJECT_STORE_SECRET_KEY": "${SECRET_KEY}"
}
JSON
)"

# `secret bulk` reads the JSON from standard input, so no file holds it.
(cd apps/api && printf '%s' "$api_json" | pnpm exec wrangler secret bulk)
(cd apps/worker && printf '%s' "$worker_json" | pnpm exec wrangler secret bulk)
echo "Secrets set on jobwork-api and jobwork-worker. The API and worker share SERVICE_TOKEN_SECRET."
