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
| F-CW.1 | Platform seams: runtime-neutral config, database, password hasher, rate-limit store | planned |
| F-CW.2 | HTTP layer on Hono: request pipeline, cross-cutting middleware | planned |
| F-CW.3 | Module routes: the 44 controllers as Hono routes, composition root | planned |
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
