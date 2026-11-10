#!/usr/bin/env bash
# F-CW.7 (ADR-0009): build and deploy the four Workers in dependency order.
#   API (no public address) → cron worker → portal → operations.
# Run from fresh-start/ after the steps in infra/cloudflare/README.md:
#   WORKERS_SUBDOMAIN=<your-subdomain> OBJECT_STORE_ENDPOINT=<supabase s3 endpoint> \
#   OBJECT_STORE_REGION=<supabase s3 region> bash infra/cloudflare/deploy.sh
set -euo pipefail

: "${WORKERS_SUBDOMAIN:?set WORKERS_SUBDOMAIN, the part before .workers.dev in your Cloudflare account}"
: "${OBJECT_STORE_ENDPOINT:?set OBJECT_STORE_ENDPOINT, Supabase Storage → S3 Connection → Endpoint}"
: "${OBJECT_STORE_REGION:?set OBJECT_STORE_REGION, Supabase Storage → S3 Connection → Region}"

cd "$(dirname "$0")/../.."

for config in apps/api/wrangler.jsonc apps/worker/wrangler.jsonc; do
  if grep -q '"id": "00000000000000000000000000000000"' "$config"; then
    echo "$config still has the placeholder Hyperdrive id; README step 4" >&2
    exit 1
  fi
done

PORTAL_URL="https://jobwork-portal.${WORKERS_SUBDOMAIN}.workers.dev"
OPERATIONS_URL="https://jobwork-operations.${WORKERS_SUBDOMAIN}.workers.dev"
BUILD_SHA="$(git rev-parse --short HEAD)"

echo "== build"
pnpm install --frozen-lockfile
pnpm -r build

echo "== api"
(cd apps/api && pnpm exec wrangler deploy \
  --var "PORTAL_URL:${PORTAL_URL}" \
  --var "OPERATIONS_URL:${OPERATIONS_URL}" \
  --var "ALLOWED_ORIGINS:${PORTAL_URL},${OPERATIONS_URL}" \
  --var "OBJECT_STORE_ENDPOINT:${OBJECT_STORE_ENDPOINT}" \
  --var "OBJECT_STORE_REGION:${OBJECT_STORE_REGION}" \
  --var "BUILD_SHA:${BUILD_SHA}")

echo "== worker"
(cd apps/worker && pnpm exec wrangler deploy \
  --var "PORTAL_URL:${PORTAL_URL}" \
  --var "OBJECT_STORE_ENDPOINT:${OBJECT_STORE_ENDPOINT}" \
  --var "OBJECT_STORE_REGION:${OBJECT_STORE_REGION}" \
  --var "BUILD_SHA:${BUILD_SHA}")

for app in portal-web operations-web; do
  echo "== ${app}"
  (cd "apps/${app}" && pnpm exec opennextjs-cloudflare build && pnpm exec wrangler deploy \
    --var "OBJECT_STORE_ENDPOINT:${OBJECT_STORE_ENDPOINT}")
done

echo
echo "Customer and supplier portal: ${PORTAL_URL}"
echo "Operations:                   ${OPERATIONS_URL}"
