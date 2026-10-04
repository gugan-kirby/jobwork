# IN-00 — Inception and walking skeleton

Scope source: [Implementation plan](../24-implementation-plan.md) §3 IN-00; [DevOps](../23-devops-cicd-environments.md); [Engineering standards](../22-engineering-standards.md) §1.
Inception selections recorded here (per doc 22 §1 "pick once"): **pnpm** workspaces, **plain pnpm -r scripts** now (task-graph runner added only when build times demand — recorded as interim in dependency policy), **Zod** for edge validation (`ES-10`), **vitest** for all tests, **Node 22 LTS**, **NestJS 11 + Fastify** API, **Next.js** web apps, **raw SQL migrations** with a small in-repo runner (`ES-16`), **pg** driver with hand-written repositories (ORM deferred to a later ADR if wanted).

All paths are relative to `fresh-start/`.

## F-00.1 Workspace bootstrap

Covers: doc 04 §8 repository shape; `ES-01`, `ES-02`.

| File | Action | Contents |
|---|---|---|
| `package.json` | new | Root: private, engines (node 22), workspace scripts (`dev`, `build`, `typecheck`, `lint`, `test`, `test:db`, `migrate`, `stack:up/down`) via `pnpm -r` |
| `pnpm-workspace.yaml` | new | `apps/*`, `packages/*`, `database` |
| `.nvmrc` | new | Node 22 LTS version |
| `.gitignore` | new | node_modules, dist, .next, .env*, coverage |
| `.editorconfig` | new | 2-space, LF, UTF-8 |
| `.env.example` | new | Local defaults: DATABASE_URL, OBJECT_STORE_*, REDIS_URL, SMTP_URL, API_PORT, SESSION_* (no secrets — DO-15) |

Tests: none (verified by F-00.7 pipeline running).
Done when: `pnpm install` succeeds from clean clone; workspace listing shows all packages.

## F-00.2 Shared config package

Covers: `ES-*` lint/type rules as executable config.

| File | Action | Contents |
|---|---|---|
| `packages/config/package.json` | new | `@jobwork/config`, exports tsconfig + eslint + prettier presets |
| `packages/config/tsconfig.base.json` | new | strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes, NodeNext modules |
| `packages/config/eslint.config.mjs` | new | typed lint, no-console (ES-33), no-floating-promises (ES-14), boundaries plugin placeholder for module rules (ES-03) |
| `packages/config/prettier.config.mjs` | new | House format |

Done when: `pnpm -r typecheck` and `pnpm -r lint` run clean across empty packages.

## F-00.3 Local development stack

Covers: doc 23 §1 `local` row; doc 24 §6 step 3.

| File | Action | Contents |
|---|---|---|
| `infra/docker-compose.yml` | new | postgres:17 (healthcheck), minio + bucket-init job (quarantine/clean buckets), redis:7, mailpit (SMTP 1025/UI 8025) |
| `infra/README.md` | new | Ports, credentials (dev-only), reset instructions |

Done when: `pnpm stack:up` brings all services healthy; documented ports reachable.

## F-00.4 Migration runner and first migration

Covers: `ES-16`–`ES-18`, doc 23 §5 (runner is deploy-step-shaped from day one).

| File | Action | Contents |
|---|---|---|
| `database/package.json` | new | `@jobwork/database`, scripts `migrate`, `migrate:status`, `new` |
| `database/src/migrate.ts` | new | Runner: advisory lock, `schema_migrations(name, checksum, applied_at)`, each file in one transaction, checksum drift = hard error, `--dry-run` |
| `database/migrations/0001_extensions.sql` | new | `pgcrypto` (uuid), `citext` for emails |
| `database/tests/migrate.db.spec.ts` | new | Applies to empty DB; re-run is no-op; edited applied file fails checksum |

Done when: `pnpm migrate` idempotent against the compose database; drift test red/green verified.

## F-00.5 API skeleton (NestJS + Fastify)

Covers: doc 04 §4 stack row; `DO-16` config validation; doc 08 §3 error envelope.

| File | Action | Contents |
|---|---|---|
| `apps/api/package.json` | new | Nest 11, platform-fastify, @fastify/cookie, zod, pg, pino via `@jobwork/observability` |
| `apps/api/tsconfig.json` | new | extends base |
| `apps/api/src/main.ts` | new | Fastify adapter, cookie plugin, global problem-details filter, correlation-id hook (accept/generate `X-Correlation-Id`), listen on env port |
| `apps/api/src/app.module.ts` | new | Imports ConfigModule, DatabaseModule, HealthModule |
| `apps/api/src/platform/config/config.service.ts` | new | Zod-validated env (fail fast, DO-16) |
| `apps/api/src/platform/database/database.service.ts` | new | pg Pool, `withTransaction(fn)` helper, health ping |
| `apps/api/src/platform/http/problem.filter.ts` | new | Maps domain errors → RFC problem details with stable `code`, correlation id; allowlist mapper (ES-13) |
| `apps/api/src/health/health.controller.ts` | new | `GET /api/v1/health` → build SHA, DB ping, time |
| `apps/api/test/health.api.spec.ts` | new | Boots app against compose DB, asserts 200 + shape |

Done when: `curl :4000/api/v1/health` returns build metadata + `db: ok`.

## F-00.6 Worker skeleton

| File | Action | Contents |
|---|---|---|
| `apps/worker/package.json` | new | Same platform deps; nodemailer (Mailpit delivery) |
| `apps/worker/src/main.ts` | new | Config-validated bootstrap, graceful shutdown, poll-loop scaffold (interval, no-op until IN-02), heartbeat log/metric |
| `apps/worker/src/mailer.ts` | new | SMTP port adapter → Mailpit in dev |

Done when: worker boots, logs heartbeat with correlation fields, exits cleanly on SIGTERM.

## F-00.7 Web app skeletons

Covers: ADR-0005 two apps; doc 21 tokens seeded.

| File | Action | Contents |
|---|---|---|
| `apps/portal-web/package.json` + `tsconfig.json` + `next.config.ts` | new | Next.js app-router minimal |
| `apps/portal-web/app/layout.tsx` | new | HTML shell, design tokens CSS import |
| `apps/portal-web/app/page.tsx` | new | Calls API health, renders status + environment banner slot |
| `apps/operations-web/*` | new | Same shape, port 3001, `compact`-density body class |
| `packages/ui/package.json` | new | `@jobwork/ui` stub |
| `packages/ui/src/tokens.css` | new | Doc 21 §§2–5 primitives + semantic tokens (blue/neutral ramps, status triples, spacing, type scale) |

Done when: both apps render health status from the API in a browser.

## F-00.8 Observability + contracts + test-kit stubs, CI

Covers: `ES-33`, `ES-21`/`ES-22`, doc 23 §4 PR stage.

| File | Action | Contents |
|---|---|---|
| `packages/observability/src/logger.ts` | new | pino wrapper: required fields, redaction list from doc 11 §14, child-with-correlation |
| `packages/contracts/src/health.ts` | new | First shared schema (health response) — pattern for all later DTOs |
| `packages/test-kit/src/clock.ts` | new | FixedClock/SystemClock ports (ES-22) |
| `packages/test-kit/src/db.ts` | new | Test database helper: create schema-isolated DB per suite, run migrations, teardown |
| `.github/workflows/ci.yml` | new | PR: install → typecheck → lint → unit; service postgres for db suites; merge: full suites (doc 23 §4) |

Done when: local `pnpm typecheck && pnpm lint && pnpm test` green; CI file lints (activates when repo is pushed to a forge).

## Increment exit (doc 24 IN-00)

- [x] Clean clone → `pnpm install && pnpm stack:up && pnpm migrate` then apps run; portal and operations render healthy API (verified 2026-09-02: health `db:ok`, problem+json 404 with correlation id).
- [x] Typecheck, lint, and tests green across the workspace (6 suites: migration idempotency/drift/rollback, logger redaction/correlation, API health contract).
- [x] No secrets in repo; env validated at boot; logs structured with correlation IDs.

### Deviations recorded during build (protocol rule 3)

1. No Docker on this machine — `stack.sh` uses Homebrew services (postgresql@16, redis) with Docker fallback for CI/other machines; compose file unchanged.
2. `tsx` (esbuild) cannot emit decorator metadata, which breaks Nest DI: API dev uses `tsc-watch`, API tests use SWC via `unplugin-swc` (es6 module type + forks pool). Worker/database keep tsx (no decorators).
3. `fastify` added as a direct API dependency (pnpm strict node_modules; types imported in the problem filter).
4. Mail capture: `SMTP_URL=log://` FileMailer writing `var/mail/*.json` instead of Mailpit (not installed); SMTP transport slot remains for IN-02+.
5. Worker test script uses `--passWithNoTests` until IN-02 adds its suites.
6. Port 3000 is occupied by an unrelated local process; portal verified on 3002 (infra/README note).
