#!/usr/bin/env bash
# Writes infra/deploy/.env: asks for the values only you know, generates every secret.
set -euo pipefail
cd "$(dirname "$0")"

if [ -e .env ]; then
  echo ".env already exists. Changing its secrets locks you out of existing data, so it is left alone." >&2
  exit 1
fi

read -rp "DuckDNS name for the portal (e.g. jobwork-app): " portal
read -rp "DuckDNS name for operations (e.g. jobwork-ops): " operations
read -rp "DuckDNS name for files (e.g. jobwork-files): " files
read -rp "Gmail address that sends the mail: " gmail
read -rsp "Gmail app password (16 letters, hidden as you type): " app_password
echo

for value in "$portal" "$operations" "$files" "$gmail" "$app_password"; do
  [ -n "$value" ] || { echo "Every value is required." >&2; exit 1; }
done

strip() { printf '%s' "${1%.duckdns.org}"; }
secret() { openssl rand -hex 32; }
smtp_user=$(printf '%s' "$gmail" | sed 's/@/%40/')
smtp_pass=$(printf '%s' "$app_password" | tr -d ' ')

umask 077
cat > .env <<ENV
PORTAL_HOST=$(strip "$portal").duckdns.org
OPERATIONS_HOST=$(strip "$operations").duckdns.org
FILES_HOST=$(strip "$files").duckdns.org
ACME_EMAIL=$gmail

SMTP_URL=smtp://$smtp_user:$smtp_pass@smtp.gmail.com:587
SMTP_FROM="JobWork Staging <$gmail>"

POSTGRES_PASSWORD=$(secret)
FILES_ACCESS_KEY=jw$(openssl rand -hex 10)
FILES_SECRET_KEY=$(secret)
SESSION_SECRET=$(secret)
SERVICE_TOKEN_SECRET=$(secret)
PAYMENT_WEBHOOK_SECRET=$(secret)
CARRIER_WEBHOOK_SECRET=$(secret)
ENV

echo "Wrote infra/deploy/.env (readable only by you). Keep a copy somewhere safe."
