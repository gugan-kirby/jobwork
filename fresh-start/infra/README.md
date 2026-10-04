# Local infrastructure

`pnpm stack:up` starts PostgreSQL and Redis and ensures the `jobwork_dev` database exists.
On machines with Docker it uses `docker-compose.yml`; otherwise it falls back to Homebrew
services (`postgresql@16`, `redis`). MinIO and mail capture join the stack in IN-03/IN-02.

| Service | Port | Dev credentials |
|---|---|---|
| PostgreSQL | 5432 | OS user (Homebrew) or `jobwork`/`jobwork` (compose) |
| Redis | 6379 | none |
| MinIO | 9000 (API), 9001 (console) | `jobwork-dev` / `jobwork-dev-secret` |
| Mailpit (compose only) | 1025 (SMTP), 8025 (UI) | none — dev fallback is `SMTP_URL=log://` writing to `var/mail/` |

**Object store.** MinIO's community edition is archived and its public images are gone
(Docker Hub deleted them on 2026-09-11; Quay no longer serves them). Homebrew's `minio` still
runs locally; CI and `docker-compose.yml` use `pgsty/silo`, the maintained Apache-2.0 fork with
the same S3 API and `MINIO_*` variables, pinned by digest. The production object store is a
`T-01` decision either way.

Reset: `pnpm stack:down`, drop the database with `dropdb jobwork_dev`, then `pnpm stack:up && pnpm migrate`.
All credentials above are development-only values (DO-15).

Note: this machine has an unrelated process listening on port 3000. If the portal fails with
`EADDRINUSE`, run it on another port: `pnpm --filter @jobwork/portal-web exec next dev -p 3002`.

## Observability (F-11.3)

`pnpm stack:observability` starts Prometheus (127.0.0.1:9090) and Grafana (127.0.0.1:3030,
anonymous viewer) from Homebrew (`brew install prometheus grafana`), loading the alert rules in
`alerts/` and the dashboards in `dashboards/` (Grafana folder "JobWork"). Data lives in
`var/observability/`. The API and worker serve metrics on their own ports only when asked:

```
METRICS_PORT=9464 node apps/api/dist/main.js
METRICS_PORT=9465 node apps/worker/dist/main.js
```

The rules and dashboards are provider-neutral (Prometheus rule format, Grafana JSON) until `T-01`
names the managed service; `apps/api/test/alerts-dashboards.spec.ts` holds every expression to
the metric names the code registers.
