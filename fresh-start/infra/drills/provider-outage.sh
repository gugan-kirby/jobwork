#!/usr/bin/env bash
# Provider-outage drill (IN-12 F-12.2; doc 12 §3). Takes one dependency away at a time
# on the local stack — the worker, the object store, Redis — and withholds a payment
# provider's callback, checks the behaviour doc 12 §3 requires while it is gone, brings it
# back, and times the recovery.
#
#   bash infra/drills/provider-outage.sh
#
# Expects the dev stack up (`pnpm stack:up`), the API on $DRILL_BASE and a worker
# running, the `pnpm seed` accounts, and Homebrew services (on a Docker host, replace
# `brew services stop/start X` with `docker compose stop/start X`). Mutates development
# data only: it posts a message, uploads two small files and pays one open invoice.
set -uo pipefail
cd "$(dirname "$0")/../.."

export DRILL_BASE="${DRILL_BASE:-http://localhost:4000}"
DB="${DRILL_DB:-jobwork_dev}"
LOG="${DRILL_WORKER_LOG:-/tmp/jobwork-drill-worker.log}"
status=0

now() { python3 -c 'import time; print(time.time())'; }
elapsed() { python3 -c "print(f'{$2 - $1:.1f}')"; }
q() { psql -X -q -At -d "$DB" -c "$1"; }
step() { printf '\n== %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1"; status=1; }
pass() { printf 'ok   %s\n' "$1"; }
field() { echo "$1" | tr ' ' '\n' | sed -n "s/^$2=//p"; }
act() { node infra/drills/outage.mjs "$@"; }

# The worker and the API share a command line; tell them apart by working directory.
worker_pids() {
  for pid in $(pgrep -f "node dist/main.js"); do
    cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')
    [[ "$cwd" == */apps/worker ]] && echo "$pid"
  done
}
start_worker() {
  # `exec` makes the subshell the worker itself, with every stream on the log: nothing
  # keeps this script's output open after it ends.
  (cd apps/worker && API_URL="$DRILL_BASE" PORTAL_URL="${PORTAL_URL:-http://localhost:3002}" exec nohup node dist/main.js >>"$LOG" 2>&1 </dev/null) &
  disown
}
wait_for() { # wait_for <seconds> <command…>: true once the command succeeds
  local limit=$1; shift
  for _ in $(seq 1 "$limit"); do "$@" >/dev/null 2>&1 && return 0; sleep 1; done
  return 1
}
store_up() { curl -fsS "${OBJECT_STORE_ENDPOINT:-http://localhost:9000}/minio/health/live"; }
redis_up() { redis-cli ping | grep -q PONG; }

export DRILL_BUYER_TOTP=$(q "select mfa_totp_secret from iam.user_account where email = 'buyer@demo.local'")
export DRILL_SESSION_FILE="$(mktemp)"
trap 'rm -f "$DRILL_SESSION_FILE"' EXIT
ENQUIRY=$(q "select e.id from sourcing.enquiry e join iam.membership m on m.organization_id = e.customer_organization_id join iam.user_account u on u.id = m.user_id where u.email = 'buyer@demo.local' and e.status <> 'draft' order by e.created_at limit 1")
[ -n "$(worker_pids)" ] || { echo "start a worker first (apps/worker: node dist/main.js)"; exit 2; }

# -------------------------------------------------------------------------------------
step "A. worker down — doc 12 §3 'queue down': outbox retains work, nothing claimed done"
for pid in $(worker_pids); do kill "$pid"; done
wait_for 10 bash -c '[ -z "$(pgrep -f "node dist/main.js" | while read p; do lsof -a -p $p -d cwd -Fn | grep -q apps/worker && echo $p; done)" ]' || fail "worker did not stop"
t_down=$(now)
line=$(act message "$ENQUIRY"); message=$(field "$line" messageId)
[ "$(field "$line" status)" = 201 ] && pass "customer's message committed while the worker is down" || fail "message refused: $line"
sleep 5
state=$(q "select status from platform.outbox_event where aggregate_id = '$message'")
[ "$state" = pending ] && pass "its event waits in the outbox ($state), nothing claims delivery" || fail "event state $state with no worker running"
start_worker
t_up=$(now)
if wait_for 60 bash -c "[ \"\$(psql -X -At -d $DB -c \"select status from platform.outbox_event where aggregate_id = '$message'\")\" = delivered ]"; then
  pass "worker back: the event delivered $(elapsed "$t_up" "$(now)") s after restart ($(elapsed "$t_down" "$t_up") s outage)"
else
  fail "event not delivered within 60 s of the restart"
fi

# -------------------------------------------------------------------------------------
step "B. object store down — metadata remains; upload and download blocked; no corruption"
brew services stop minio >/dev/null
wait_for 15 bash -c '! curl -fsS http://localhost:9000/minio/health/live' || fail "object store did not stop"
t_down=$(now)
line=$(act read); [ "$(field "$line" enquiries)" = 200 ] && pass "customer signs in and reads enquiries and orders ($line)" || fail "reads failed: $line"
line=$(act upload); session=$(field "$line" session); fin=$(field "$line" status)
if [ -z "$fin" ]; then fail "upload probe did not run: $line"
elif [ "$fin" != 201 ]; then pass "upload refused cleanly ($line)"
else fail "upload claimed success with the store down: $line"; fi
if [ -n "$session" ]; then
  recorded=$(q "select s.status || ' ' || count(v.id) from dms.upload_session s left join dms.document_version v on v.id = s.document_version_id where s.id = '$session' group by s.status")
  [[ "$recorded" != completed* && "$recorded" == *" 0" ]] && pass "no document version recorded for the failed upload (session $recorded)" || fail "the failed upload left: '$recorded'"
fi
brew services start minio >/dev/null
wait_for 30 store_up || fail "object store did not come back"
t_up=$(now)
line=$(act upload)
[ "$(field "$line" status)" = 201 ] && pass "store back after $(elapsed "$t_down" "$t_up") s; the same upload now succeeds ($line)" || fail "upload still failing after recovery: $line"

# -------------------------------------------------------------------------------------
step "C. Redis down — rate limiting degrades to per-process; core truth stays in the database"
brew services stop redis >/dev/null
wait_for 15 bash -c '! redis-cli ping' || fail "Redis did not stop"
line=$(act read); [ "$(field "$line" enquiries)" = 200 ] && pass "sign-in and reads work without Redis ($line)" || fail "reads failed without Redis: $line"
line=$(act message "$ENQUIRY"); [ "$(field "$line" status)" = 201 ] && pass "commands work without Redis" || fail "command failed without Redis: $line"
brew services start redis >/dev/null
wait_for 15 redis_up && pass "Redis back" || fail "Redis did not come back"
line=$(act read); [ "$(field "$line" enquiries)" = 200 ] && pass "reads after Redis returns ($line)" || fail "reads failed after Redis returned: $line"

# -------------------------------------------------------------------------------------
step "D. payment callback withheld — pending, no false capture, reconciled"
invoice=$(q "select i.id from finance.invoice i join iam.membership m on m.organization_id = i.customer_organization_id join iam.user_account u on u.id = m.user_id where u.email = 'buyer@demo.local' and i.status = 'issued' order by i.issued_at limit 1")
if [ -z "$invoice" ]; then
  echo "skip: buyer@demo.local has no open invoice to pay"
else
  line=$(act pay "$invoice"); intent=$(field "$line" intentId); amount=$(field "$line" amountMinor)
  provider_intent=$(q "select provider_intent_id from finance.payment_intent where id = '$intent'")
  [ "$(q "select status from finance.invoice where id = '$invoice'")" = issued ] && pass "intent $intent open, invoice still unpaid while the provider is silent" || fail "invoice moved without a callback"
  # Age the intent past its expiry instead of waiting PAYMENT_INTENT_TTL_MINUTES.
  q "update finance.payment_intent set expires_at = now() - interval '1 minute' where id = '$intent'" >/dev/null
  line=$(act sweep)
  [ "$(q "select status from finance.payment_intent where id = '$intent'")" = expired ] && pass "reconcile sweep expired the silent intent ($line)" || fail "intent not expired: $line"
  [ "$(q "select status from finance.invoice where id = '$invoice'")" = issued ] && pass "no false capture: the invoice is still unpaid" || fail "invoice changed by the sweep"
  line=$(act callback "$provider_intent" "$amount")
  outcome=$(field "$line" outcome)
  echo "     late capture for the expired intent: $line; invoice now $(q "select status || ' (paid ' || paid_minor || ')' from finance.invoice where id = '$invoice'")"
  [ "$outcome" = processed ] || [ "$outcome" = suspense ] && pass "money that arrives late is recorded ($outcome), never dropped" || fail "late capture outcome: $outcome"
fi

step "summary"
[ $status -eq 0 ] && echo "RESULT: provider-outage drill passed" || echo "RESULT: provider-outage drill FAILED"
exit $status
