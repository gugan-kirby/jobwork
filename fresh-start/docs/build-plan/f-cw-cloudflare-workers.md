# F-CW — Cloudflare Workers and Supabase demo environment

Scope source: owner instruction 2026-11-09: *"make this project live, all cost free, no domain … deploy on Cloudflare and storage on Supabase"*; the owner then chose the Workers port over a VM, demo use only, ₹0, no outbound mail. Decision record: [ADR-0009](../adr/0009-cloudflare-workers-supabase-demo.md).
Branch: `feat/cloudflare-workers-deploy`, cut from `feat/free-staging-deploy` (not `main`) because it builds on the unmerged bootstrap-admin command (fda464b). Deviation from [delivery workflow](delivery-workflow.md) §1, recorded here.

## Rules

1. Behaviour does not change. Every command, guard, projection, audit write and outbox write stays; only the runtime around them moves. The existing API, worker and walk tests are the oracle.
2. Production on this stack must be a plan upgrade, not a code change (ADR-0009). Free-plan workarounds sit behind a setting or a port: `PASSWORD_HASHER`, `MAIL_TRANSPORT`, the rate-limit store.
3. Local development keeps working throughout: `pnpm dev` and the Docker stack stay until F-CW.7 replaces them.
4. Owner steps (accounts, logins, secrets) are listed per functionality and never block the local work.

## Functionalities

| ID | Functionality | Status |
|---|---|---|
| F-CW.0 | Spike: measure size, CPU and connectivity on the free plans | in progress |
| F-CW.1 | Platform seams: runtime-neutral config, database, password hasher, rate-limit store | **done** 2026-11-09 (1,006 tests green) |
| F-CW.2 | Metadata runtime in place of NestJS core and Fastify (see the deviation below) | **done** 2026-11-09 (1,014 tests green) |
| F-CW.3 | API Worker entry: per-request pool, client address from the edge, bundle and size check | **built** 2026-11-09; runs in `workerd` unverified |
| F-CW.4 | Worker on a Cron Trigger: bounded outbox batch and scans per run | planned |
| F-CW.5 | Mail outbox page instead of SMTP | planned |
| F-CW.6 | Web apps on OpenNext with service bindings | planned |
| F-CW.7 | Deploy: Supabase project, Hyperdrive, secrets, migrations, first admin, walk | planned |

F-CW.1–F-CW.7 get their file manifests from the F-CW.0 measurements and the code inventory; each is detailed here before it starts.

## F-CW.0 Spike

Question: does each deployable fit the free plan (3 MiB gzip, 10 ms CPU per invocation), and can a Worker reach Supabase Postgres and Storage?

| File | Action | Contents |
|---|---|---|
| `infra/cloudflare/spike/package.json` | new | `hono`, `pg`, `wrangler` (dev) |
| `infra/cloudflare/spike/wrangler.jsonc` | new | `nodejs_compat`, Hyperdrive binding `DB`, observability on |
| `infra/cloudflare/spike/src/index.ts` | new | `GET /db` (`select 1`), `POST /hash` (`crypt($1, gen_salt('bf', 10))` and verify), `GET /storage` (presigned PUT with checksum, tampered PUT, HEAD, copy, presigned GET against Supabase Storage via `@jobwork/object-store`) |
| `infra/cloudflare/spike/README.md` | new | Owner steps and how CPU is read (Workers Logs `cpuTimeMs`) |
| `pnpm-workspace.yaml` | edit | `infra/cloudflare/*` |
| `apps/portal-web/{open-next.config.ts,wrangler.jsonc}`, `apps/operations-web/{…}` | new | Minimal OpenNext build config, used for the size measurement; F-CW.6 completes it |
| `apps/portal-web/package.json`, `apps/operations-web/package.json` | edit | `@opennextjs/cloudflare` 1.20.16, `wrangler` 4.159.0 (dev) |
| `.gitignore` | edit | `.open-next/`, `.wrangler/`, `.dev.vars*` |

Local measurements (no accounts):

| Measure | How | Pass |
|---|---|---|
| Web app size | `opennextjs-cloudflare build` per app; gzip of the server bundle | ≤ 3 MiB each |
| API size upper bound | esbuild bundle of the compiled `apps/api/dist/main.js`, minified, all dependencies inlined, gzip | ≤ 3 MiB (NestJS included, so the Hono build is smaller) |

Remote measurements (owner steps first):

| Measure | Pass |
|---|---|
| `/db` through Hyperdrive to the Supavisor session pooler | 200; CPU ≤ 5 ms |
| `/hash` | Hash and verify inside 10 ms CPU (the work runs in Postgres) |
| `/storage` | Upload, checksum, copy and read back an object in Supabase Storage |

Owner steps: [`infra/cloudflare/spike/README.md`](../../infra/cloudflare/spike/README.md) — a Supabase project in Mumbai with two private buckets and S3 keys, a Cloudflare account, a Hyperdrive configuration on the Supavisor session pooler (the free direct connection is IPv6-only), four secrets, deploy, three probes.

Results are recorded below and ADR-0009 is revised if a pass line fails.

### Results

| Measure | Value | Date |
|---|---|---|
| `portal-web` Worker | 7,913 KiB raw, **1,461 KiB gzip** — pass | 2026-11-09 |
| `operations-web` Worker | 7,780 KiB raw, **1,442 KiB gzip** — pass | 2026-11-09 |
| API upper bound (NestJS + Fastify bundled, argon2 and ioredis excluded) | 3,268 KiB raw, **773 KiB gzip** — pass | 2026-11-09 |
| Spike Worker (Hono, pg, object-store) | 272 KiB raw, 59 KiB gzip | 2026-11-09 |
| `/db`, `/hash`, `/storage` on the deployed spike | waiting on owner steps | |

Finding: OpenNext 1.20.16 builds Next 16's `proxy.ts` as Node.js middleware and warns that this is experimental on Cloudflare. F-CW.6 checks the CSP nonce and HSTS headers on the deployed Workers; if they are missing, `proxy.ts` moves to edge `middleware.ts`.

## F-CW.1 Platform seams

Everything the Workers runtime cannot hold moves behind a seam chosen by setting; Node keeps today's behaviour by default. NestJS stays until F-CW.3. On Workers `process.env` carries vars and secrets (`nodejs_compat`, compatibility date after 2025-04-01), so `ConfigService` keeps reading it.

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/iam/domain/password.ts` | edit | Policy only (lengths, `passwordPolicyIssue`); the hash versions `ARGON2ID_PARAMS_VERSION = 1`, `BCRYPT_PARAMS_VERSION = 2`. No `argon2` import, so a Workers bundle can take it |
| `apps/api/src/modules/iam/infrastructure/password-hasher.ts` | new | `PasswordHasher` port (`paramsVersion`, `hash`, `verify`, `burn`) and the `PASSWORD_HASHER` token |
| `apps/api/src/modules/iam/infrastructure/argon2-hasher.ts` | new | Today's argon2id code; the timing-equaliser hash is made on first use, not at import |
| `apps/api/src/modules/iam/infrastructure/pgcrypto-hasher.ts` | new | `crypt($1, gen_salt('bf', 10))` and `crypt($1, $2) = $2` through `DatabaseService`; `burn` verifies against a fixed bcrypt hash. Unqualified names: pgcrypto sits in `public` locally (0001) and in `extensions` on Supabase, which is on its search path |
| `apps/api/src/modules/iam/iam.module.ts` | edit | `PASSWORD_HASHER` by `PASSWORD_HASHER` setting |
| `apps/api/src/modules/iam/application/{auth,invitation,registration}.service.ts` | edit | Hash, verify and burn through the port; store `hasher.paramsVersion` |
| `apps/api/src/platform/config/config.service.ts` | edit | `PASSWORD_HASHER: argon2id \| pgcrypto-bcrypt` (default `argon2id`); `RATE_LIMIT_STORE: redis \| postgres` (default `redis`) |
| `database/src/bootstrap-admin.ts` | edit | `PASSWORD_HASHER=pgcrypto-bcrypt` hashes inside the bootstrap transaction with `crypt`, version 2 |
| `database/migrations/0035_rate_limit_counter.sql` | new | `UNLOGGED` `platform.rate_limit_counter (key, window_index, count, expires_at)`, primary key `(key, window_index)`, index on `expires_at` |
| `apps/api/src/platform/http/rate-limit/postgres-store.ts` | new | `PostgresRateLimitStore`: one upsert that counts the current window and reads the previous one. Its own file, so a Workers bundle need not load `ioredis` from `store.ts` |
| `apps/api/src/platform/http/rate-limit/rate-limit.interceptor.ts` | edit | `RATE_LIMIT_STORE=postgres` uses it, no Redis connection; expired rows are swept by the F-CW.4 cron |
| `apps/api/src/platform/database/database.service.ts` | edit | `pool` becomes a getter over a `PoolSource`: one shared pool on Node; on Workers a pool per request held in `AsyncLocalStorage` (a Worker cannot reuse a socket across requests; Hyperdrive does the pooling) |
| `apps/api/src/platform/database/pool-source.ts` | new | `SharedPoolSource`, `RequestPoolSource.run(fn)` |
| `apps/api/test/**/*.ts` | edit | Fixtures import `hashPassword` from `argon2-hasher` |

The pgcrypto hasher queries through `db.pool` even inside an open transaction (invitation acceptance), so a Workers pool needs `DATABASE_POOL_MAX` ≥ 2; F-CW.3 sets it.

Tests:

| Test | Proves |
|---|---|
| `apps/api/test/password-hasher.db.spec.ts` (new) | pgcrypto hash starts `$2a$10$`, verifies, refuses a wrong password, `burn` resolves; neither hasher accepts the other's hash; argon2 unchanged. Postgres counters: windows, 20 simultaneous hits all counted, expiry stamp |
| `apps/api/test/workers-seams.api.spec.ts` (new) | Boots with `PASSWORD_HASHER=pgcrypto-bcrypt`, `RATE_LIMIT_STORE=postgres` and an unreachable Redis: register, verify, sign in; unknown account and wrong password both 401; the fourth attempt on one account 429. Replaces the planned edits to `iam-auth` and `rate-limit` specs: one boot covers both settings |
| `apps/api/test/pool-source.spec.ts` (new) | Each `run` gets its own pool and ends it; `pool` outside a run throws a named error |
| `database/tests/bootstrap-admin.db.spec.ts` (edit) | The bcrypt path stores version 2 and the hash verifies with `crypt` |
| Full suite | Unchanged behaviour on the defaults |

## F-CW.2 Metadata runtime in place of NestJS

Deviation from the table above and from ADR-0009's first row, recorded 2026-11-09: the 44 controllers are **not** rewritten. Controllers, guards, the interceptor, the filter and every provider already carry their routing and wiring as `@nestjs/common` decorator metadata, and `tsc` emits constructor types (`design:paramtypes`). A small runtime reads that metadata, builds the object graph synchronously without NestJS's bootstrap, and calls the unchanged handlers. Routing uses `find-my-way`, Fastify's own router, so path matching, parameter decoding and static-before-parameter precedence stay identical. Reason: the same goal (no NestJS core, no Fastify, fits a Worker) with ~47,000 lines untouched and the existing suite as the oracle; F-CW.3 then shrinks to two entry points instead of 44 rewrites.

| File | Action | Contents |
|---|---|---|
| `apps/api/src/runtime/container.ts` | new | Walks `@Module` imports from `AppModule`; class, `useClass`, `useExisting`, `useFactory`, `useValue` providers; `@Inject` tokens and `@Optional`; singletons; `APP_GUARD` and `APP_INTERCEPTOR` in declaration order; `onModuleInit`, `onApplicationBootstrap`, `onModuleDestroy`; `get(token)`; values supplied by the entry point (pool source, adapter host) |
| `apps/api/src/runtime/http.ts` | new | `fetch`-style handler: correlation id, body parsing (JSON and text, raw bytes kept for webhook signatures), `find-my-way` routing under `api/v1`, Fastify-shaped request and reply facades, global guards, the interceptor chain, handler arguments from `__routeArguments__`, default status (201 for POST, `@HttpCode` otherwise), JSON results, `ProblemFilter` for every throw including an unmatched route (`Cannot GET /…`), the `onResponse` hook the metrics service registers |
| `apps/api/src/runtime/client-address.ts` | new | `X-Forwarded-For` walked with `proxy-addr` against `TRUST_PROXY`, as Fastify did |
| `apps/api/src/app.ts` | new | `createApplication(values)`: container plus HTTP handler, shared by Node and the Worker |
| `apps/api/src/main.ts` | edit | Serves the handler with `@hono/node-server`; graceful shutdown; NestJS and Fastify imports gone |
| `apps/api/test/helpers/boot.ts` | edit | `createTestApp()` returns `{ app: { close, get }, baseUrl }` from the runtime |
| `apps/api/test/**/*.ts` | edit | `NestFastifyApplication` type → `TestApp` |
| `apps/api/package.json` | edit | `find-my-way`, `fast-querystring`, `proxy-addr`, `cookie`, `@hono/node-server`, `hono`; `@nestjs/core`, `@nestjs/platform-fastify`, `fastify`, `@fastify/cookie` leave when nothing imports them |

Tests: the full API suite (75 files) unchanged in substance is the acceptance test, plus `apps/api/test/runtime.spec.ts` (new): provider kinds and tokens, a missing dependency names its class and path, guard order, route precedence, 404 through the filter, POST default 201, `@HttpCode`, malformed and empty JSON, passthrough cookies.

Built as planned, plus: `src/runtime/reflector.ts` and the runtime's own `APP_GUARD`/`APP_INTERCEPTOR` names replace the three `@nestjs/core` imports, and `MetricsService` registers its request timer through `RuntimeAdapterHost.onResponse`, so nothing loads `@nestjs/core`; `fastify` and `@fastify/cookie` stay as dev dependencies for types only. Route paths given as arrays (`InstrumentController`) register every path. `test/pilot/driver.ts` `expectNothingOf` now ignores uuids and timestamps: pilot 1 failed once in five runs when a random uuid contained a price's digits.

## F-CW.3 API Worker entry

| File | Action | Contents |
|---|---|---|
| `apps/api/src/worker.ts` | new | `start(env)` builds the application once per isolate with a `RequestPoolSource` over Hyperdrive; `fetch` runs each request in its own pool and hands the pool's end to `waitUntil`. The peer is the service binding (loopback), so `TRUST_PROXY=loopback` takes the browser from the caller's `X-Forwarded-For` |
| `apps/api/worker/entry.mjs` | new | wrangler's entry: imports the tsc build (`dist/worker.js`, which carries the constructor types esbuild cannot emit) and calls `start` at startup with `cloudflare:workers` `env`, so the ~50 ms graph build is charged to startup, not to a request |
| `apps/api/worker/stubs/native.mjs` | new | Stands in for `argon2`, `ioredis`, `pg-native`, `class-validator`, `class-transformer`: imported, never called on a Worker; a call throws naming ADR-0009 |
| `apps/api/wrangler.jsonc` | new | `jobwork-api`, `nodejs_compat`, `workers_dev: false` (service bindings only), Hyperdrive binding, the Workers settings (`PASSWORD_HASHER`, `RATE_LIMIT_STORE`, `DATABASE_POOL_MAX=4`, `METRICS_PORT=0`) |
| `apps/api/package.json` | edit | `wrangler` (dev) |
| `apps/api/test/worker-entry.spec.ts` | new | On Node: health through a request pool whose end goes to `waitUntil`; per-browser rate limits from `X-Forwarded-For` behind the binding |

Measured 2026-11-09 (Node 22, M-series Mac): building the graph 52 ms CPU once; a request through guards and the filter 0.15 ms CPU. Bundle: 4,970 KiB raw, **774 KiB gzip**.

Not yet verified: the bundle running inside `workerd` (pino, prom-client and pg under `nodejs_compat`). Needs either `wrangler dev` locally or the deploy in F-CW.7.
