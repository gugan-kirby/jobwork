# DevOps, CI/CD, and environments

This document consolidates the delivery-infrastructure fragments in [System architecture](04-system-architecture.md) §11, [Reliability and observability](12-reliability-observability.md) §10, and [Testing strategy](13-testing-strategy.md) §14 into one operational reference: environments, pipeline, release, secrets, and infrastructure-as-code. Cloud/platform product selection stays open under `T-01`; everything here is provider-agnostic and becomes concrete at inception.

Rules carry `DO-nn` identifiers.

## 1. Environment model

| Environment | Purpose | Data | Providers | Access |
|---|---|---|---|---|
| `local` | Developer machines; full stack via containers (PostgreSQL, object-store emulator, queue, fake providers) | Synthetic only | Fakes from test-kit | Developer |
| `dev` | Shared integration; auto-deployed from `main` | Synthetic/seeded | Sandbox where useful | Team |
| `staging` | Production-like rehearsal: UAT, E2E, performance, DR drills | Anonymized/synthetic UAT scenarios (doc 13 §13) | Sandbox accounts of real providers (`T-03`–`T-05`) | Team + UAT users |
| `production` | Live | Real | Live | Locked down (§7) |
| `pilot` (optional) | Production tenant/feature-gated cohort (doc 15 §10) | Real, scoped | Live | As production |

- `DO-01`: Environments live in isolated cloud accounts/projects with separate networks, keys, and IAM — no shared databases, buckets, queues, or secrets between environments (doc 04 §11).
- `DO-02`: Production data never flows down. Staging/dev use synthetic or approved-masked data only (doc 11 §13); a request to "copy prod to debug" is an incident-process exception, not a favor.
- `DO-03`: Every environment carries a visible environment banner in internal apps and distinct resource naming (`jw-<env>-…`) so an operator can never mistake where they are.

## 2. Infrastructure as code

- `DO-04`: All infrastructure — network, DB, object storage, queue, Redis, CDN/WAF, DNS, IAM, alert policies — is declared in version-controlled IaC (Terraform/OpenTofu recommended). Console changes are break-glass only, alerted, and reconciled back into code within one working day.
- `DO-05`: IaC changes ride the same PR review flow as code (`ES-25`–`ES-28`), with plan output attached to the PR and applied through CI, not laptops.
- State backends are remote, locked, encrypted, and per-environment; modules are shared, environment values are explicit `tfvars`, and drift detection runs scheduled.
- Baseline stacks (mirrors doc 04 §11): VPC/private networking, managed PostgreSQL with PITR, versioned encrypted object storage with lifecycle rules, managed Redis, durable queue, CDN/WAF/TLS, secrets manager, workload identity, observability sinks.

## 3. Build

- `DO-06`: One build produces immutable, digest-addressed container images per deployable (`api`, `worker`, `portal-web`, `operations-web`); the same image is promoted `dev → staging → production` — environments differ only by configuration (doc 12 §10).
- Images: minimal distroless/slim bases, non-root user, pinned base digests, SBOM generated, image and artifact scanning as merge/promotion gates (doc 11 §10 supply-chain controls).
- Build metadata (git SHA, build time, contracts version) is baked in and exposed on a health endpoint and in logs, so doc 12 §7 "deploy version" dashboards work.

## 4. CI pipeline

Implements doc 13 §14 as required checks:

```text
on pull request:
  install (frozen lockfile) -> typecheck -> lint/format
  unit + property tests
  migration static checks (expand/contract lint, destructive-change flag)
  dependency / secret / SAST scan
  targeted DB + API tests (affected modules)
  build affected apps (turbo/nx graph)

on merge to main:
  full DB/API/module integration suites
  contract tests (API, events, provider adapters)
  E2E + accessibility suite against ephemeral or dev stack
  container build + image scan + SBOM
  deploy dev -> smoke
  deploy staging -> smoke + synthetic journeys

nightly/scheduled:
  cross-tenant authorization matrix (full)
  adversarial file corpus
  performance trend run (staging)
  backup restore verification jobs
  dependency/container rescans
```

- `DO-07`: Required checks cannot be bypassed by administrators outside the incident process (`ES-28`). Flaky tests are quarantined through a tracked issue with expiry, never deleted silently.
- `DO-08`: CI runners are ephemeral with least-privilege, short-lived cloud credentials via OIDC/workload identity — no long-lived cloud keys in CI secrets (doc 11 §10).

## 5. Database migrations in deployment

- `DO-09`: Migrations run as a separate, ordered deploy step with its own higher-privilege role (doc 05 §14) — never at application boot of horizontally scaled instances.
- `DO-10`: Only backward-compatible (expand) migrations may deploy with a release; contract steps ship at least one release after the code stopped depending on the old shape (doc 05 §16). CI's migration lint enforces the classification.
- Pre-production rehearsal: every production migration has run against a staging database of representative size; destructive/long-running changes state lock impact and use online strategies (batched backfills per `ES-19`, concurrent index builds).
- `DO-11`: The deploy pipeline verifies backup/PITR health immediately before running production migrations flagged risky (doc 12 §9).

## 6. Release and rollback

- Deployment style: rolling or blue/green per doc 04 §11, with health/readiness gates (readiness ≠ liveness, doc 12 §10) and automatic halt on error-rate regression during rollout.
- Progressive delivery: risky changes go behind feature flags (owner, purpose, expiry, safe default — doc 12 §10) and/or canary a small traffic slice before full rollout.
- `DO-12`: Application rollback is one command back to the previous image and is exercised routinely. Schema rollback is not assumed: because migrations are expand-first, the previous app version must always run against the current schema — that property is what CI's compatibility check protects.
- Workers and API may briefly run mixed versions during rollout; event/contract compatibility rules (doc 08 §13, doc 12 §10) make that safe, and a release that cannot tolerate mixed versions must say so and use a maintenance strategy instead.
- Release notes are generated from conventional commits plus a human-written operational note (flags introduced, migrations run, dashboards to watch).

## 7. Production access and operations

- `DO-13`: No standing human access to production databases, object storage, or shells. Access is just-in-time, time-boxed, reason-required, approved, and session-audited (doc 03 §6 break-glass model applied to infrastructure).
- `DO-14`: Production mutations by operators go through admin application commands (audited, doc 11 §12) — direct SQL fixes are incident-process actions with maker-checker and an after-action record.
- Scheduled jobs, queue depth, outbox age, and cron health are first-class monitored resources (doc 12 §7) owned by the platform module.
- On-call: one rotation owns platform alerts at launch; every page maps to a runbook (doc 12 §§8, 12); alert changes ride PRs like code.

## 8. Secrets and configuration

- `DO-15`: Secrets exist only in the managed secret store, injected at runtime; never in git, images, CI logs, or `.env` files beyond local fakes (doc 11 §10). Secret scanning guards the repo; a leaked secret triggers the rotation runbook, not just deletion.
- `DO-16`: Configuration is typed and validated at process start (fail fast on missing/invalid), sourced from environment + versioned config records (`FR-1006`); business-policy configuration changes are audited application commands, not redeploys.
- Provider credentials are per-environment, least-scope, rotated with overlap windows (doc 08 §10), and inventoried with owners.

## 9. Cost and capacity guardrails

- Budgets and anomaly alerts per environment from day one; an unexpected cost spike is treated as a possible incident signal (crypto-mining, runaway job, abuse — doc 11 §4 availability threats).
- Right-size by measurement (doc 12 §11): stateless API/worker autoscaling first; database and file-worker pools are watched capacity items with explicit scaling runbooks.
- Load-shedding and backpressure behavior in production follows doc 12 §5; deploys never disable those protections "temporarily".

## 10. Launch infrastructure checklist (feeds doc 15 §11)

- [ ] IaC applies cleanly from scratch in a fresh account (DR credibility, `NFR-06`).
- [ ] PITR verified by actual restore in staging within RPO/RTO targets (doc 12 §9).
- [ ] TLS, WAF, rate limits, and security headers verified against doc 11 §10.
- [ ] Workload identity everywhere; zero long-lived human/CI cloud keys (`DO-08`).
- [ ] Observability pipeline (logs/metrics/traces/alerts) end-to-end with correlation IDs (`NFR-11`).
- [ ] Runbooks linked from every paging alert; on-call rota staffed and drilled.
- [ ] Feature-flag inventory has owners and expiries; no orphan flags.
- [ ] Migration rehearsal + rollback drill evidence for the launch release.
- [ ] Access reviews complete: production IAM, database roles, secret store, CI permissions.
