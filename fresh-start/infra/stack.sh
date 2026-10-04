#!/usr/bin/env bash
# Local development stack.
# On this machine services run via Homebrew (no Docker present); docker-compose.yml
# provides the same stack for CI and Docker-equipped machines.
set -euo pipefail

DB_NAME="${JOBWORK_DB:-jobwork_dev}"

have() { command -v "$1" >/dev/null 2>&1; }

up() {
  if have docker && docker info >/dev/null 2>&1; then
    docker compose -f "$(dirname "$0")/docker-compose.yml" up -d
  else
    brew services start postgresql@16 >/dev/null
    brew services start redis >/dev/null
    brew services start minio >/dev/null
    for i in $(seq 1 30); do
      if pg_isready -q 2>/dev/null; then break; fi
      sleep 1
    done
    pg_isready -q || { echo "PostgreSQL did not become ready" >&2; exit 1; }
  fi
  if ! psql -lqt 2>/dev/null | cut -d '|' -f 1 | grep -qw "$DB_NAME"; then
    createdb "$DB_NAME"
    echo "created database $DB_NAME"
  fi
  buckets
  echo "stack up: postgres=ok redis=ok objects=ok db=$DB_NAME"
}

# Quarantine and clean prefixes are separate buckets: bytes only move between them
# after a scan verdict (doc 09 §4).
buckets() {
  have mc || { echo "mc not installed; create buckets manually" >&2; return 0; }
  local endpoint="${OBJECT_STORE_ENDPOINT:-http://localhost:9000}"
  local key="${OBJECT_STORE_ACCESS_KEY:-minioadmin}"
  local secret="${OBJECT_STORE_SECRET_KEY:-minioadmin}"
  for i in $(seq 1 30); do
    if curl -fsS "$endpoint/minio/health/live" >/dev/null 2>&1; then break; fi
    sleep 1
  done
  mc alias set jobwork-local "$endpoint" "$key" "$secret" >/dev/null 2>&1 || {
    echo "could not reach object store at $endpoint" >&2; return 0; }
  mc mb -p \
    "jobwork-local/${OBJECT_STORE_BUCKET_QUARANTINE:-jobwork-quarantine}" \
    "jobwork-local/${OBJECT_STORE_BUCKET_CLEAN:-jobwork-clean}" >/dev/null 2>&1 || true
}

down() {
  if have docker && docker info >/dev/null 2>&1; then
    docker compose -f "$(dirname "$0")/docker-compose.yml" down
  else
    brew services stop postgresql@16 >/dev/null || true
    brew services stop redis >/dev/null || true
    brew services stop minio >/dev/null || true
  fi
  echo "stack down"
}

status() {
  pg_isready 2>/dev/null || true
  if have redis-cli; then redis-cli ping 2>/dev/null || true; fi
  curl -fsS "${OBJECT_STORE_ENDPOINT:-http://localhost:9000}/minio/health/live" >/dev/null 2>&1 \
    && echo "object store: live" || echo "object store: unreachable"
  if have brew; then brew services list | grep -E 'postgresql|redis|minio' || true; fi
}

# Prometheus + Grafana with the repository's alert rules and dashboards (F-11.3).
# Grafana listens on 3030 because 3000 is taken on this machine (see README).
OBS_DIR="$(cd "$(dirname "$0")" && pwd)/observability"
VAR_DIR="$(cd "$(dirname "$0")/.." && pwd)/var/observability"

observability() {
  have prometheus || { echo "prometheus not installed (brew install prometheus)" >&2; exit 1; }
  have grafana || { echo "grafana not installed (brew install grafana)" >&2; exit 1; }
  mkdir -p "$VAR_DIR/prometheus" "$VAR_DIR/grafana"
  observability_down >/dev/null 2>&1 || true
  nohup prometheus --config.file="$OBS_DIR/prometheus.yml" --storage.tsdb.path="$VAR_DIR/prometheus" \
    --web.listen-address=127.0.0.1:9090 >"$VAR_DIR/prometheus.log" 2>&1 &
  echo $! >"$VAR_DIR/prometheus.pid"
  JOBWORK_PROMETHEUS_URL=http://127.0.0.1:9090 \
  JOBWORK_DASHBOARDS="$(cd "$OBS_DIR/../dashboards" && pwd)" \
  GF_PATHS_PROVISIONING="$OBS_DIR/grafana/provisioning" \
  GF_PATHS_DATA="$VAR_DIR/grafana" \
  GF_PATHS_LOGS="$VAR_DIR/grafana" \
  GF_SERVER_HTTP_ADDR=127.0.0.1 \
  GF_SERVER_HTTP_PORT=3030 \
  GF_AUTH_ANONYMOUS_ENABLED=true \
  GF_AUTH_ANONYMOUS_ORG_ROLE=Viewer \
  GF_ANALYTICS_REPORTING_ENABLED=false \
  GF_ANALYTICS_CHECK_FOR_UPDATES=false \
  nohup grafana server --homepath "$(brew --prefix grafana)/share/grafana" >"$VAR_DIR/grafana.log" 2>&1 &
  echo $! >"$VAR_DIR/grafana.pid"
  echo "prometheus http://127.0.0.1:9090  grafana http://127.0.0.1:3030 (dashboards in folder JobWork)"
}

observability_down() {
  for name in prometheus grafana; do
    if [ -f "$VAR_DIR/$name.pid" ]; then kill "$(cat "$VAR_DIR/$name.pid")" 2>/dev/null || true; rm -f "$VAR_DIR/$name.pid"; fi
  done
  echo "observability down"
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  status) status ;;
  observability) observability ;;
  observability-down) observability_down ;;
  *) echo "usage: stack.sh {up|down|status|observability|observability-down}" >&2; exit 2 ;;
esac
