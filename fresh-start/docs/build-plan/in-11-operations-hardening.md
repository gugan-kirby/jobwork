# IN-11 — Operations hardening and SLOs

Scope source: [Implementation plan](../24-implementation-plan.md) §4 IN-11; doc 07 §11; doc 08 §14; doc 12 §§1, 7–8, 12; doc 23 §4 nightly stage.
Edge cases owned (doc 19 §9): search/cache stale after revocation (invalidation verified); same person conflicting roles (SoD config surfaced).
Use cases: UC-35 (config surfaces), UC-38 (escalation), UC-36 (security ops tooling).

## F-11.1 Work queues, SLA policies, business calendar

| File | Action | Contents |
|---|---|---|
| `database/migrations/0012_queues_sla.sql` | new | `work_queue`, `queue_assignment`, `sla_policy_version`, `business_calendar_version` (doc 05 §4 platform row) |
| `apps/api/src/modules/platform/application/{assign-queue-item,escalate}.command.ts` | new | Audited assignment; escalation idempotent by (subject, policy_step, due_version) per doc 07 §11 |
| `apps/worker/src/sla/escalator.ts` | new | Due-row scan, calendar/timezone-aware recompute (`BR-SYS-07`) |
| `apps/operations-web/app/(shell)/queues/*` | new | Doc 21 QueueTable: saved filters, ownership, due/overdue states across intake/RFQ/approvals/reviews |

Tests: DST/timezone deadline cases (doc 13 §9); reassignment audited; escalation fires once per step.

## F-11.2 Rate limits and abuse controls

Covers: doc 08 §14; doc 11 §10.

| File | Action | Contents |
|---|---|---|
| `apps/api/src/platform/http/rate-limit.ts` | new | Redis-backed budgets by IP/session/org/operation class; distinct login/upload/search/message/export policies; safe retry guidance in problem body |
| `apps/api/test/rate-limit.api.spec.ts` | new | Budget exhaustion per class; webhook capacity isolated from public limits |

## F-11.3 Dashboards, metrics, alert definitions

Covers: doc 12 §7 three dashboards; `ES-35`.

| File | Action | Contents |
|---|---|---|
| `packages/observability/src/metrics.ts` | edit | Domain metrics: queue age, outbox age, gate-blocked counts, leakage backlog, payment mismatch, scan backlog |
| `infra/dashboards/*.json` + `infra/alerts/*.yaml` | new | Platform/operations/security dashboard definitions + paging/ticket alert rules with runbook links (provider-agnostic format, wired at `T-01`) |
| `apps/operations-web/app/(shell)/ops-health/page.tsx` | new | In-app business-control panel (untriaged age, blocked releases, exceptions) |

## F-11.4 Runbooks

Covers: doc 12 §12 list.

| File | Action | Contents |
|---|---|---|
| `fresh-start/runbooks/*.md` (12 files) | new | One per doc 12 §12 entry: diagnostics (safe queries), mitigation, authority, comms owner, verification, post-incident |

## F-11.5 Nightly suites wiring

Covers: doc 23 §4 nightly stage.

| File | Action | Contents |
|---|---|---|
| `.github/workflows/nightly.yml` | new | Full cross-tenant matrix, adversarial file corpus, perf smoke (k6 or autocannon script in `infra/perf/`), dependency/container rescan |
| `apps/api/test/cross-tenant-matrix.api.spec.ts` | edit | Generated role × relationship × resource × action grid (doc 13 §5) consolidated from per-increment suites |

## F-11.6 Installable portal and offline shell

Covers: doc 21 §8, `DS-14`, `BR-AUTH-05`, ADR-0005. F-DS assigned this work to IN-11; this section carries it (added 2026-10-04 by F-FE.7).

| File | Action | Contents |
|---|---|---|
| `apps/portal-web/app/manifest.ts` | new | Web app manifest (name, icons, `display: standalone`, theme colour from tokens); installability on Android Chrome and iOS Safari |
| `apps/portal-web/public/sw.js` + registration in `app/shell.tsx` | new | Offline shell for navigation only; read cache limited to non-sensitive projections with short TTL; no supplier identity, pricing or document bytes (`DS-14`). Must load under the F-FE.6 nonce CSP (`worker-src 'self'`). |
| `apps/portal-web/app/shell.tsx` | edit | Purge caches on logout and on a 401 after suspension (`BR-AUTH-05`); state "connection needed" for money/approval/release commands instead of queueing them |

Tests: cache contents after a customer and a supplier session contain no cost or identity fields; logout empties every cache; a command attempted offline is refused with the connectivity message, never queued.

## Increment exit

- [ ] Doc 12 §1 signals measured with dashboards live locally; gaps listed with owners.
- [ ] Every paging alert has a runbook file; alert payloads contain no sensitive data (doc 12 §8).
- [ ] Nightly pipeline green end to end at least once.
