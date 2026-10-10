#!/usr/bin/env bash
# Restore drill (IN-12 F-12.2; doc 12 §9). Takes a snapshot of the source database,
# restores it into an isolated database, validates it the seven ways doc 12 §9 lists, and
# proves the critical journey on an API booted against the restored copy. Every step is
# timed; the summary gives the measured recovery time.
#
#   bash infra/drills/restore.sh            # source jobwork_dev → jobwork_restore_drill
#
# Local stand-in for production: `pg_dump`/`pg_restore` here, provider snapshots plus
# point-in-time recovery in production (T-01). The steps and checks are the same.
# Never point SOURCE_DB at production from a laptop.
set -uo pipefail
cd "$(dirname "$0")/../.."

SOURCE_DB="${SOURCE_DB:-jobwork_dev}"
TARGET_DB="${TARGET_DB:-jobwork_restore_drill}"
PORT="${DRILL_PORT:-4100}"
MC_ALIAS="${MC_ALIAS:-jobwork-local}"
CLEAN_BUCKET="${OBJECT_STORE_BUCKET_CLEAN:-jobwork-clean}"
SAMPLE="${DRILL_HASH_SAMPLE:-10}"
WORK="$(mktemp -d)"
API_PID=""
status=0

now() { python3 -c 'import time; print(time.time())'; }
elapsed() { python3 -c "print(f'{$2 - $1:.1f}')"; }
q() { psql -X -q -At -d "$1" -c "$2"; }
step() { printf '\n== %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1"; status=1; }
pass() { printf 'ok   %s\n' "$1"; }
cleanup() {
  [ -n "$API_PID" ] && kill "$API_PID" 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT

T0=$(now)
step "1/7 snapshot of $SOURCE_DB"
t=$(now)
SNAPSHOT_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
pg_dump -Fc -d "$SOURCE_DB" -f "$WORK/snapshot.dump" || { fail "pg_dump"; exit 1; }
pass "snapshot taken at $SNAPSHOT_AT, $(du -h "$WORK/snapshot.dump" | cut -f1), $(elapsed "$t" "$(now)") s"

step "2/7 isolated restore into $TARGET_DB"
t=$(now)
dropdb --if-exists "$TARGET_DB" && createdb "$TARGET_DB" || { fail "create $TARGET_DB"; exit 1; }
pg_restore --no-owner -d "$TARGET_DB" "$WORK/snapshot.dump" || fail "pg_restore reported errors"
pass "restored in $(elapsed "$t" "$(now)") s"

step "3/7 consistency and migration version"
src_mig=$(q "$SOURCE_DB" "select count(*) || ' ' || max(name) from schema_migrations")
dst_mig=$(q "$TARGET_DB" "select count(*) || ' ' || max(name) from schema_migrations")
[ "$src_mig" = "$dst_mig" ] && pass "migrations match: $dst_mig" || fail "migrations differ: $src_mig vs $dst_mig"
# Phase 1 records, then Phase 2's (TP.6): change, quality, both logistics legs, settlement, support.
for table in sourcing.enquiry sourcing.rfq sourcing.supplier_bid_version commercial.customer_quote orders.sales_order orders.purchase_order finance.invoice dms.file_object platform.audit_event platform.outbox_event \
             change.change_request quality.inspection quality.ncr quality.deviation logistics.shipment logistics.stock_movement \
             finance.journal_line finance.supplier_bill finance.settlement finance.credit_note support.case support.resolution_action; do
  a=$(q "$SOURCE_DB" "select count(*) from $table"); b=$(q "$TARGET_DB" "select count(*) from $table")
  [ "$a" = "$b" ] && pass "$table: $b rows" || fail "$table: $a in source, $b restored"
done
# Immutability triggers came back with the data: a submitted bid still refuses an edit.
bid=$(q "$TARGET_DB" "select id from sourcing.supplier_bid_version limit 1")
if [ -n "$bid" ]; then
  if psql -X -q -d "$TARGET_DB" -c "update sourcing.supplier_bid_version set total_amount_minor = 1 where id = '$bid'" >/dev/null 2>&1; then
    fail "immutability trigger missing on restored bids"
  else
    pass "restored bids are still immutable"
  fi
fi
# And the stock ledger: a restored movement still refuses an edit.
movement=$(q "$TARGET_DB" "select id from logistics.stock_movement limit 1")
if [ -n "$movement" ]; then
  if psql -X -q -d "$TARGET_DB" -c "update logistics.stock_movement set quantity = quantity + 1 where id = '$movement'" >/dev/null 2>&1; then
    fail "immutability trigger missing on restored stock movements"
  else
    pass "restored stock movements are still immutable"
  fi
fi

step "4/7 file references and sampled hashes"
missing=0; matched=0; seeded=0
while IFS='|' read -r key digest; do
  [ -z "$key" ] && continue
  actual=$(mc cat "$MC_ALIAS/$CLEAN_BUCKET/$key" 2>/dev/null | shasum -a 256 | cut -d' ' -f1)
  if [ "$actual" = "$digest" ]; then matched=$((matched + 1));
  elif [[ "$key" == clean/demo-* ]]; then seeded=$((seeded + 1));
  else missing=$((missing + 1)); printf 'FAIL object %s: digest %s, store %s\n' "$key" "$digest" "$actual"; fi
done < <(q "$TARGET_DB" "select storage_key, sha256 from dms.file_object where scan_state = 'clean' order by random() $([ "$SAMPLE" = all ] && echo "" || echo "limit $SAMPLE")")
echo "     sampled: $matched match, $missing missing or altered, $seeded demo-seed rows without bytes (by design)"
[ "$missing" -eq 0 ] && pass "every sampled object matches its recorded digest" || fail "$missing sampled objects missing or altered"

step "5/7 audit, outbox and unpublished work"
q "$TARGET_DB" "select 'audit events: ' || count(*) || ', newest ' || coalesce(max(occurred_at)::text, 'none') from platform.audit_event"
q "$TARGET_DB" "select 'outbox ' || status || ': ' || count(*) from platform.outbox_event group by status order by status"
q "$TARGET_DB" "select 'still to deliver: ' || event_type || ' × ' || count(*) from platform.outbox_event where status not in ('delivered', 'dismissed') group by event_type order by event_type"
pass "unpublished work listed; the worker resumes it from the outbox"

step "6/7 providers, sessions and callbacks"
q "$TARGET_DB" "select 'payment intents still open: ' || count(*) from finance.payment_intent where status in ('created', 'pending', 'requires_action')" 2>/dev/null || true
q "$TARGET_DB" "select 'money in suspense: ' || count(*) from finance.payment_transaction where status = 'suspense'" 2>/dev/null || true
revoked=$(q "$TARGET_DB" "with r as (update iam.session set revoked_at = now(), revoked_reason = 'restore' where revoked_at is null returning 1) select count(*) from r")
pass "sessions restored from the snapshot revoked ($revoked): everyone signs in again"
echo "     re-enable provider callbacks only after reconciling the intents above against the provider for the recovery window"

step "7/7 critical journey on an API booted against $TARGET_DB"
t=$(now)
(cd apps/api && DATABASE_URL="postgres://localhost:5432/$TARGET_DB" API_PORT="$PORT" SESSION_SECRET="${SESSION_SECRET:-dev-only-change-me}" RATE_LIMIT_MODE=off \
  node dist/main.js >"$WORK/api.log" 2>&1) &
API_PID=$!
for _ in $(seq 1 30); do curl -fsS "http://localhost:$PORT/api/v1/health" >/dev/null 2>&1 && break; sleep 1; done
export DRILL_BASE="http://localhost:$PORT"
export DRILL_BUYER_TOTP=$(q "$TARGET_DB" "select mfa_totp_secret from iam.user_account where email = 'buyer@demo.local'")
export DRILL_SOURCING_TOTP=$(q "$TARGET_DB" "select mfa_totp_secret from iam.user_account where email = 'sourcing@jobwork.local'")
journey=$(node infra/drills/journey.mjs); journey_status=$?
echo "$journey"
[ $journey_status -eq 0 ] || fail "critical journey"
doc_line=$(echo "$journey" | grep '^document ' || true)
if [ -n "$doc_line" ]; then
  version=$(echo "$doc_line" | cut -d' ' -f2); got=$(echo "$doc_line" | cut -d' ' -f3)
  want=$(q "$TARGET_DB" "select f.sha256 from dms.document_version v join dms.file_object f on f.id = v.file_object_id where v.id = '$version'")
  [ "$got" = "$want" ] && pass "downloaded document matches the restored row's digest" || fail "document digest $got, row says $want"
fi
pass "journey in $(elapsed "$t" "$(now)") s"

step "summary"
echo "snapshot taken:        $SNAPSHOT_AT"
echo "measured restore time: $(elapsed "$T0" "$(now)") s (snapshot → journey green; objective ≤ 2 h)"
echo "data loss window:      0 min in this drill (snapshot taken at the start); production RPO rests on PITR (objective ≤ 15 min, T-01)"
[ $status -eq 0 ] && echo "RESULT: restore drill passed" || echo "RESULT: restore drill FAILED"
exit $status
