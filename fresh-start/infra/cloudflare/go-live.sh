#!/usr/bin/env bash
# F-CW.7 (ADR-0009): the whole deployment in one run, from a private env file, so that no
# secret is typed or printed. Needs `wrangler login` done on this machine.
#
#   infra/cloudflare/.env.deploy  (git ignores .env.*; chmod 600)
#     DATABASE_URL=<Supabase session pooler URI, with the password>
#     OBJECT_STORE_ENDPOINT=<Supabase Storage → S3 Connection → Endpoint>
#     OBJECT_STORE_REGION=<... → Region>
#     OBJECT_STORE_ACCESS_KEY=<S3 access key ID>
#     OBJECT_STORE_SECRET_KEY=<S3 secret access key>
#
#   bash infra/cloudflare/go-live.sh            # migrate, Hyperdrive, deploy, secrets
#   bash infra/cloudflare/go-live.sh secrets    # only (re)set the secrets
#   bash infra/cloudflare/go-live.sh deploy     # only build and deploy (after a git pull)
set -euo pipefail
cd "$(dirname "$0")/../.."
ENV_FILE=infra/cloudflare/.env.deploy
[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE (see the header of this script)" >&2; exit 1; }
set -a; . "$ENV_FILE"; set +a
for key in DATABASE_URL OBJECT_STORE_ENDPOINT OBJECT_STORE_REGION OBJECT_STORE_ACCESS_KEY OBJECT_STORE_SECRET_KEY; do
  [ -n "${!key:-}" ] || { echo "$ENV_FILE: $key is empty" >&2; exit 1; }
done
step="${1:-all}"

wr() { (cd "$1" && shift && pnpm exec wrangler "$@"); }
# `|| true`: under set -e a failed lookup would end the run without a word.
ACCOUNT_ID="$(wr apps/api whoami 2>/dev/null | grep -oE '[0-9a-f]{32}' | head -1 || true)"
[ -n "$ACCOUNT_ID" ] || { echo "wrangler is not logged in, or its login has expired; run: cd apps/api && pnpm exec wrangler login" >&2; exit 1; }
# Lookups wrangler has no command for go through the API with wrangler's own login.
WRANGLER_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/.wrangler/config/default.toml"
[ -f "$WRANGLER_CONFIG" ] || WRANGLER_CONFIG="$HOME/Library/Preferences/.wrangler/config/default.toml"
cf() { curl -sf -H "Authorization: Bearer $(sed -nE 's/^oauth_token *= *"([^"]+)"/\1/p' "$WRANGLER_CONFIG")" "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID$1"; }
SUBDOMAIN="$(cf /workers/subdomain | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["subdomain"])' 2>/dev/null || true)"
[ -n "$SUBDOMAIN" ] || { echo "the account has no workers.dev subdomain yet; set one at Workers & Pages → Overview" >&2; exit 1; }
PORTAL_URL="https://jobwork-portal.${SUBDOMAIN}.workers.dev"
OPERATIONS_URL="https://jobwork-operations.${SUBDOMAIN}.workers.dev"
BUILD_SHA="$(git rev-parse --short HEAD)"

if [ "$step" = all ]; then
  echo "== install and build"
  pnpm install --frozen-lockfile
  pnpm -r build

  echo "== migrations on Supabase"
  DATABASE_URL="$DATABASE_URL" node database/dist/cli.js up

  echo "== Hyperdrive"
  placeholder='00000000000000000000000000000000'
  if grep -q "\"id\": \"$placeholder\"" apps/api/wrangler.jsonc; then
    existing="$(cf /hyperdrive/configs | python3 -c 'import json,sys; print(next((c["id"] for c in json.load(sys.stdin)["result"] if c["name"]=="jobwork-demo"), ""))' || true)"
    if [ -n "$existing" ]; then
      HYPERDRIVE_ID="$existing"
    else
      HYPERDRIVE_ID="$(wr apps/api hyperdrive create jobwork-demo --caching-disabled --connection-string="$DATABASE_URL" 2>/dev/null | grep -oE '"id": "[0-9a-f]{32}"' | grep -oE '[0-9a-f]{32}' | head -1)"
    fi
    [ -n "$HYPERDRIVE_ID" ] || { echo "could not create the Hyperdrive configuration" >&2; exit 1; }
    sed -i '' "s/$placeholder/$HYPERDRIVE_ID/" apps/api/wrangler.jsonc apps/worker/wrangler.jsonc
    echo "Hyperdrive jobwork-demo: $HYPERDRIVE_ID (written to both wrangler.jsonc files; commit them)"
  fi
fi

if [ "$step" = all ] || [ "$step" = deploy ]; then
  echo "== deploy jobwork-api"
  wr apps/api deploy \
    --var "PORTAL_URL:${PORTAL_URL}" --var "OPERATIONS_URL:${OPERATIONS_URL}" \
    --var "ALLOWED_ORIGINS:${PORTAL_URL},${OPERATIONS_URL}" \
    --var "OBJECT_STORE_ENDPOINT:${OBJECT_STORE_ENDPOINT}" --var "OBJECT_STORE_REGION:${OBJECT_STORE_REGION}" \
    --var "BUILD_SHA:${BUILD_SHA}"
  echo "== deploy jobwork-worker"
  wr apps/worker deploy \
    --var "PORTAL_URL:${PORTAL_URL}" \
    --var "OBJECT_STORE_ENDPOINT:${OBJECT_STORE_ENDPOINT}" --var "OBJECT_STORE_REGION:${OBJECT_STORE_REGION}" \
    --var "BUILD_SHA:${BUILD_SHA}"
  for app in portal-web operations-web; do
    echo "== deploy ${app}"
    (cd "apps/${app}" && pnpm exec opennextjs-cloudflare build >/dev/null && pnpm exec wrangler deploy --var "OBJECT_STORE_ENDPOINT:${OBJECT_STORE_ENDPOINT}")
  done
fi

if [ "$step" = all ] || [ "$step" = secrets ]; then
  echo "== secrets"
  secret() { openssl rand -hex 32; }
  SERVICE_TOKEN_SECRET="$(secret)"
  python3 - "$SERVICE_TOKEN_SECRET" "$OBJECT_STORE_ACCESS_KEY" "$OBJECT_STORE_SECRET_KEY" "$(secret)" "$(secret)" "$(secret)" <<'PY' | (cd apps/api && pnpm exec wrangler secret bulk >/dev/null)
import json, sys
svc, ak, sk, session, pay, carrier = sys.argv[1:]
print(json.dumps({"SESSION_SECRET": session, "SERVICE_TOKEN_SECRET": svc, "PAYMENT_WEBHOOK_SECRET": pay,
                  "CARRIER_WEBHOOK_SECRET": carrier, "OBJECT_STORE_ACCESS_KEY": ak, "OBJECT_STORE_SECRET_KEY": sk}))
PY
  python3 - "$SERVICE_TOKEN_SECRET" "$OBJECT_STORE_ACCESS_KEY" "$OBJECT_STORE_SECRET_KEY" <<'PY' | (cd apps/worker && pnpm exec wrangler secret bulk >/dev/null)
import json, sys
svc, ak, sk = sys.argv[1:]
print(json.dumps({"SERVICE_TOKEN_SECRET": svc, "OBJECT_STORE_ACCESS_KEY": ak, "OBJECT_STORE_SECRET_KEY": sk}))
PY
  echo "secrets set on jobwork-api and jobwork-worker"
fi

echo
echo "Customer and supplier portal: ${PORTAL_URL}"
echo "Operations:                   ${OPERATIONS_URL}"
