#!/usr/bin/env bash
# Nightly suites (F-11.5; doc 23 §4 nightly stage). The same script runs locally
# (`pnpm nightly`, against the dev stack) and in .github/workflows/nightly.yml, so a
# nightly failure can be reproduced on a laptop. Expects a built tree, a migrated
# database, and the `pnpm seed` accounts.
#
#   1. the whole suite again in UTC — the CI run is in India time, so a date that only
#      works at +05:30 is caught here;
#   2. the security suites by name: cross-tenant matrix, adversarial file corpus, the
#      negative suites, rate limits;
#   3. a performance smoke against a booted API (doc 12 §1 latency objectives);
#   4. a dependency audit that fails on high or critical advisories (ES-30).
#
# Not here yet, recorded in the IN-11 plan: container rescans (no images until T-01) and
# restore verification (IN-12 F-12.2).
set -uo pipefail
cd "$(dirname "$0")/.."

status=0
failed=()
step() { printf '\n== %s\n' "$1"; }
run() {
  local name="$1"; shift
  if "$@"; then printf -- '-- ok: %s\n' "$name"; else printf -- '-- FAILED: %s\n' "$name"; status=1; failed+=("$name"); fi
}

step "1/4 full suite in UTC"
run "suite (UTC)" env TZ=UTC pnpm test

step "2/4 security suites"
run "security suites" env TZ=Asia/Kolkata pnpm --filter @jobwork/api exec vitest run \
  test/cross-tenant-matrix.api.spec.ts test/dms-scan.api.spec.ts test/dms-negative.api.spec.ts \
  test/sourcing-negative.api.spec.ts test/rate-limit.api.spec.ts \
  test/pilot/scenario-12-suspension-cross-party.api.spec.ts test/audit-coverage.spec.ts \
  test/production-config.spec.ts

step "3/4 performance smoke"
mkdir -p var
PORT="${NIGHTLY_API_PORT:-4100}"
API_PORT="$PORT" RATE_LIMIT_PREFIX=nightly node apps/api/dist/main.js >var/nightly-api.log 2>&1 &
API_PID=$!
for _ in $(seq 1 30); do
  curl -fsS "http://127.0.0.1:$PORT/api/v1/health" >/dev/null 2>&1 && break
  sleep 1
done
run "perf smoke" node infra/perf/smoke.mjs --base "http://127.0.0.1:$PORT" --duration "${NIGHTLY_SMOKE_SECONDS:-60}" --rps 8 --concurrency 4
kill "$API_PID" 2>/dev/null || true

step "4/4 dependency audit (high and critical)"
run "dependency audit" pnpm audit --audit-level=high

if [ "$status" -ne 0 ]; then
  printf '\nnightly FAILED: %s\n' "${failed[*]}"
else
  printf '\nnightly green\n'
fi
exit "$status"
