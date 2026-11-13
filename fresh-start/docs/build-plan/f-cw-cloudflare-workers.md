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
| F-CW.4 | Worker on a Cron Trigger: bounded outbox batch and scans per run | **built** 2026-11-09 |
| F-CW.5 | Mail outbox page instead of SMTP | **built** 2026-11-09 |
| F-CW.6 | Web apps on OpenNext with service bindings | **built** 2026-11-09 |
| F-CW.7 | Deploy: Supabase project, Hyperdrive, secrets, migrations, first admin, walk | **live** 2026-11-12; owner's walk pending |

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
| `/db`, `/hash`, `/storage` on the deployed spike | not run: the deployment itself (F-CW.7) answered the questions below | |
| Live API, warm: `GET /health` | 76 ms wall; `POST /admin/organizations` 6 ms CPU, 186 ms wall | 2026-11-12 |
| Live API, cold isolate (first request builds the graph) | 60–100 ms CPU; the free plan did not terminate these requests (the 10 ms figure is not enforced per request as a hard cut) | 2026-11-12 |
| Live sign-in (bcrypt in Supabase's pgcrypto, unqualified names) | HTTP 201, 2.7 s wall cold; `/auth/me` 200 | 2026-11-12 |
| Live SLA sweep (`POST /internal/sla/sweep`, 100+ round trips through Hyperdrive) | HTTP 201, 3.7 s wall | 2026-11-12 |
| Live cron tick (outbox, sweeps due, heartbeat) | outcome ok, 20–62 ms CPU, up to 24 s wall | 2026-11-12 |
| Supabase Storage through the SigV4 client | both buckets listed with the S3 keys (HTTP 200) | 2026-11-12 |
| CSP nonce and HSTS from `proxy.ts` under OpenNext | present on the live portal and operations responses | 2026-11-12 |

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

## F-CW.4 Worker on a Cron Trigger

| File | Action | Contents |
|---|---|---|
| `apps/worker/src/config.ts` | new | The settings schema, moved out of `main.ts`; `MAIL_TRANSPORT: smtp \| api`; production refuses `SMTP_URL=log://` only with `smtp` |
| `apps/worker/src/wiring.ts` | new | `createWorker(config, { pool, logger, apiFetch })`: handlers, poller, the six sweeps (`everyMs`, `atStart`), heartbeat. Node and the Worker share it |
| `apps/worker/src/main.ts` | edit | The long-lived Node process on the shared wiring; behaviour unchanged |
| `apps/worker/src/cron.ts` | new | `scheduled`: one pool per run over Hyperdrive; up to `MAX_BATCHES_PER_RUN = 3` outbox batches (30 events); the sweeps `due` this minute; the heartbeat |
| `apps/worker/src/internal-api.ts` | edit | Optional `fetch`, so the Worker calls the API through its service binding |
| `apps/worker/wrangler.jsonc`, `apps/worker/worker-stub.mjs` | new | `jobwork-worker`, `* * * * *`, `workers_dev: false`, `API` service binding, Hyperdrive, `SCAN_MAX_INSPECT_BYTES=8 MiB`, `SLA_SWEEP_MS=15 min` (F-CW.7, 2026-11-13); `nodemailer` stubbed |
| `packages/observability/src/metrics.ts` | edit | `onWorkers()`; Node process metrics are not collected inside a Worker |

New sweep on both runtimes: `rate_limit_counters` deletes expired `platform.rate_limit_counter` rows every 15 minutes (housekeeping, not business state, doc 20 §9).

Tests: `apps/worker/test/cron.db.spec.ts` (new): `due` per interval; a quarter-hour run hands the invitation to the API, strips the token, calls all five API sweeps and clears spent counters; an off-quarter run calls only the SLA sweep and stops at 30 events. `apps/worker/test/wrangler-config.spec.ts` (new, 2026-11-13): the deployed vars ask for the SLA sweep at most 96 times a day. Bundle: 2,538 KiB raw, **383 KiB gzip**.

Decision taken on the owner's behalf: files above 8 MiB are refused by the scan on Workers (fail-closed, as any file above the limit is today). Hashing and scanning more inside 10 ms of CPU is not possible; revisit with the spike's numbers and Supabase's checksum behaviour (`/storage` probe).

## F-CW.5 Mail page instead of SMTP

| File | Action | Contents |
|---|---|---|
| `database/migrations/0036_mail_message.sql` | new | `communication.mail_message`, one row per `delivery_id` |
| `packages/contracts/src/communication.ts` | edit | `recordMailRequestSchema`, `MailMessage`, `Mailbox` |
| `apps/api/src/modules/communication/{infrastructure/mail.repository.ts,application/mailbox.ts,presentation/mail.controller.ts}` | new | `POST internal/mail` (worker principal only, idempotent per delivery); `GET mailbox` (internal, `platform_admin`: the links are credentials), newest 200 |
| `apps/worker/src/api-mailer.ts` | new | `MAIL_TRANSPORT=api`: `Mailer` that hands each message to the API |
| `apps/operations-web/app/mail/page.tsx` | new | The messages, newest first, links clickable |
| `apps/operations-web/app/ops-health/page.tsx` | edit | A "Mail" card linking to it, for platform admins. The home tiles stay as the reference images show them |

Tests: `apps/api/test/mailbox.api.spec.ts` (new): one copy per delivery; only the worker hands over, only well-formed; admin reads newest first; other staff 403, customers and suppliers refused, anonymous 401.

## F-CW.6 Web apps on Workers

| File | Action | Contents |
|---|---|---|
| `packages/web-kit/src/edge.ts` (export `./edge`) | new | `isApiRequest`, `forwardToApi`: `/api/*` to the API Worker's service binding with method, headers, cookies and body intact; `X-Forwarded-For` from the edge's `CF-Connecting-IP`, any browser-sent value dropped |
| `apps/{portal,operations}-web/worker.mjs` | new | The Worker entry: `/api/*` forwarded, everything else to OpenNext's `.open-next/worker.js` |
| `apps/{portal,operations}-web/wrangler.jsonc` | edit | `main: worker.mjs`, `workers_dev: true` (the public `*.workers.dev` address), `API` and `WORKER_SELF_REFERENCE` service bindings, static assets |
| `packages/web-kit/test/edge.spec.ts` | new | API paths only; request and reply pass through unchanged; the browser named from the edge, never from its own header |

The Next.js `/api` rewrite stays for Node; on a Worker the entry answers `/api/*` before Next sees it. Bundles: portal 7,889 KiB raw / **1,455 KiB gzip**, operations 7,785 KiB / **1,437 KiB gzip**.

F-CW.7 sets per account: the API's `ALLOWED_ORIGINS`, `PORTAL_URL` and `OPERATIONS_URL` to the two `workers.dev` addresses, and the web apps' `OBJECT_STORE_ENDPOINT` (the upload CSP). Not yet seen in a browser: the CSP nonce and HSTS from `proxy.ts`, which OpenNext runs as experimental Node middleware (F-CW.0 finding).

## F-CW.7 Deploy

Prepared without the owner's accounts; the run itself is the owner's.

| File | Action | Contents |
|---|---|---|
| `infra/cloudflare/README.md` | new | Owner steps: buckets, S3 keys, pooler URI into `.env.deploy`; `wrangler login`; `go-live.sh`; first admin with `PASSWORD_HASHER=pgcrypto-bcrypt`; try it. The `jobwork` Worker that Workers Builds created on 2026-11-05 failed every build (`npx wrangler deploy` in the repository root, no build step, nothing to deploy); deleting it on 2026-11-11 did not end the builds, which re-created it. The root `wrangler.jsonc` and `site/index.html` now give that build something to deploy: the demo's front door, linking to the portal and operations |
| `infra/cloudflare/go-live.sh` | new | One run from a private `.env.deploy` (never typed or printed): install and build; migrations on Supabase; the Hyperdrive configuration, its id written into both `wrangler.jsonc`; the four deploys with the account's addresses; generated secrets through `wrangler secret bulk` on standard input. `deploy` and `secrets` as single steps. Replaced `deploy.sh` and `secrets.sh` on 2026-11-11, once the owner's run showed the deployment had to be driven without a terminal prompt |
| `infra/README.md` | edit | Points to it |

Deployed 2026-11-12 (`go-live.sh`, account subdomain `gugantennyson`): `https://jobwork-portal.gugantennyson.workers.dev`, `https://jobwork-operations.gugantennyson.workers.dev`, front door `https://jobwork.gugantennyson.workers.dev`; 36 migrations applied on Supabase (ap-south-1, session pooler through Hyperdrive `jobwork-demo`); first admin created with `PASSWORD_HASHER=pgcrypto-bcrypt`; live sign-in verified.

Defects found only on the platform:

| Symptom | Cause | Fix |
|---|---|---|
| From 2026-11-12, daily at about 11:20 UTC: Hyperdrive refuses every query until 00:00 UTC ("daily free tier limit of 100,000 queries"); the demo stops | The SLA sweep ran every minute and costs ~145 statements with nothing to do: 27 queue syncs, each its own five-statement transaction. Measured 8,750–9,000 statements an hour, flat day and night (121,328 on 2026-11-12, 121,167 on 2026-11-13): ~211,000 a day | 2026-11-13: `jobwork-worker` sets `SLA_SWEEP_MS=900000`; an idle day is estimated at ~22,000 statements, and an escalation may fire up to 15 minutes late on the demo. Node keeps the one-minute default. `test/wrangler-config.spec.ts` guards it |
| Every API request: Cloudflare error 1101 | `worker/entry.mjs` read `env.HYPERDRIVE.connectionString` while building the graph at startup; the runtime mints it with random values and forbids that at global scope | The graph is built on a placeholder address; each request's pool reads Hyperdrive's string inside `fetch` |
| Every cron tick: `platform.sla_sweep_failed`, "api unreachable: aborted due to timeout" at ~14 s; the API logged the request as canceled | `scheduled()` handed the run to `ctx.waitUntil` and returned; the runtime keeps such work only for a grace period, then tears the invocation down, cancelling the in-flight service-binding call | `scheduled()` awaits the run. Also: a cron's API call may take 60 s (`apiTimeoutMs`), and both Workers use Smart Placement to run near the database |

Still to do: an enquiry with an uploaded drawing scanned clean (owner's walk). `infra/deploy/` (ADR-0008) removed 2026-11-12 with the owner's agreement, as were the unused `@supabase/*` packages of the portal. Done 2026-11-12: a customer registered and verified through the live portal; the spike Worker (`infra/cloudflare/spike/`) and the Android prototype at the repository root removed (the owner: only `fresh-start/` is wanted).
