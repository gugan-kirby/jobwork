# ADR-0009: Cloudflare Workers and Supabase for the free demo environment

- Status: Proposed
- Date: 2026-11-09
- Supersedes: [ADR-0008](0008-free-single-vm-staging.md) as the free environment. Live since 2026-11-12; ADR-0008's stack was removed then.

## Context

The owner wants JobWork reachable by them alone, with made-up data, at no cost and without a domain, on the two platforms they know: Cloudflare and Supabase. They chose to port the backend to Cloudflare Workers over running it on a VM, and asked that production later be an upgrade of plans and settings, not a second rewrite.

Free-plan limits (checked 2026-11-09) shape the design:

| Limit | Value | Effect |
|---|---|---|
| Workers CPU per invocation | 10 ms (Free), 30 s (Paid) | argon2id cannot run in the request; NestJS's per-isolate bootstrap must not run either |
| Workers script size | 3 MiB gzip (Free), 10 MiB (Paid) | Each Next.js app and the API bundle are measured in `F-CW.0` |
| Workers requests | 100,000 a day per account; static assets free | Browsers download the web apps' static files for free; only dynamic routes count |
| Cron Triggers | 5 per account, 1-minute minimum | No continuous worker; the outbox drains once a minute |
| Hyperdrive | 100,000 queries a day, 10 configurations (Free) | Postgres access from Workers |
| Supabase Free | 500 MB Postgres, 1 GB Storage, pause after 7 idle days, no backups | Demo data only; the once-a-minute cron keeps the project active |
| Supabase direct connection | IPv6 only without the paid IPv4 add-on | Hyperdrive uses the Supavisor session pooler (IPv4) |

## Decision

| Need | Choice |
|---|---|
| API | `apps/api` keeps every module unchanged. NestJS's runtime (`@nestjs/core`, its bootstrap, the Fastify adapter) is replaced by a small metadata runtime (`src/runtime/`): it builds the providers the `@Module` declarations list, synchronously, and serves the controllers through `find-my-way`, Fastify's router, behind one `fetch` handler. `@nestjs/common` stays for its decorators and exceptions. Node serves the handler with `@hono/node-server`; the Worker exports it. One Worker, `nodejs_compat`. |
| Background work | `apps/worker` becomes a Worker driven by one Cron Trigger (every minute). Each run claims a bounded outbox batch and runs the due scans, then exits. It calls the API through a service binding, not the public internet. |
| Web apps | `portal-web` and `operations-web` on Workers through the OpenNext Cloudflare adapter, at `*.workers.dev`. `/api/*` reaches the API through a service binding. |
| Database | Supabase Postgres through Hyperdrive, query caching off (reads must see the last write). Migrations run from a developer machine against the session pooler. |
| Files | Supabase Storage through its S3-compatible endpoint; `@jobwork/object-store` keeps SigV4 presigned URLs. |
| Passwords | bcrypt computed by Postgres (`pgcrypto`, cost 10), versioned in the stored hash so rehash-on-login can return to Argon2id (doc 20 §4) on a paid plan. |
| Rate limiting | A Postgres window table in place of Redis. |
| Mail | No outbound mail. Rendered messages are stored and listed on an operations **Mail** page; the SMTP adapter stays for other environments. |
| File scanning | Signature and structure checks over a bounded prefix of each object, inside the 128 MB memory limit. |

The `F-CW.0` spike measures CPU, bundle size and connectivity before the port. If a limit cannot be met, the spike records the measurement and this ADR is revised before `F-CW.1`.

## Consequences

- Synthetic data only. No backups, no PITR, one region, no SLO (`NFR` targets do not apply).
- Production on this stack is a plan upgrade, not a code change: Workers Paid restores argon2id and raises CPU and size limits; Supabase Pro adds backups and stops pausing; a domain allows custom hostnames and authenticated mail. `T-01` stays open.
- Controllers, guards, the interceptor and the filter run unchanged; module boundaries, command guards, audit and outbox writes (doc 04, doc 22) are unchanged. The runtime supports what this codebase uses (global guards and interceptors, class/factory/existing/value providers, `@Inject`, `@Optional`, `@Res({ passthrough: true })`) and refuses anything else at start.
- Outbox latency rises from ~2 s to up to 1 min.
- Deviations from doc 23 for this environment only: `DO-01` (one personal account per platform), `DO-04`/`DO-05` (no IaC beyond `wrangler` configs), `DO-15` (secrets set with `wrangler secret put`, not a secret store).
- Deviation from doc 20 §4: bcrypt instead of Argon2id while on the free plan. bcrypt reads only the first 72 bytes of a password, so two passwords that share those bytes are the same password here.
- Payment, carrier and malware scanning stay on their development adapters (`T-03`, `T-05`, `T-06`).

## Rejected alternatives

- Keep NestJS behind a custom Workers adapter: unsupported, and NestJS's asynchronous bootstrap of ~190 providers would run inside a request's 10 ms.
- Rewrite the 44 controllers as Hono routes: the original plan; replaced by the metadata runtime, which reaches the same runtime with the controllers untouched.
- Move business logic into Supabase (PostgREST, SQL functions, row-level security): rewrites the command, authorization and audit model of docs 04, 20 and 22.
- Oracle VM plus Supabase (ADR-0008 variant): works without a rewrite but adds a third platform the owner declined.
- Workers Paid from the start: declined by the owner; the design keeps it a configuration change.
