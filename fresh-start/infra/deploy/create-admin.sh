#!/usr/bin/env bash
# Creates the first admin and the receiving hub. Works once; later staff are invited.
set -euo pipefail
cd "$(dirname "$0")"

read -rp "Admin email: " ADMIN_EMAIL
read -rp "Admin full name: " ADMIN_NAME
read -rsp "Admin password (12+ characters, hidden as you type): " ADMIN_PASSWORD
echo
read -rp "Receiving hub address line: " HUB_ADDRESS
read -rp "Hub city: " HUB_CITY
read -rp "Hub state: " HUB_STATE
read -rp "Hub PIN code: " HUB_POSTAL_CODE
read -rp "Hub contact name: " HUB_CONTACT_NAME
read -rp "Hub contact phone: " HUB_CONTACT_PHONE

export ADMIN_EMAIL ADMIN_NAME ADMIN_PASSWORD HUB_ADDRESS HUB_CITY HUB_STATE \
  HUB_POSTAL_CODE HUB_CONTACT_NAME HUB_CONTACT_PHONE
docker compose run --rm admin
