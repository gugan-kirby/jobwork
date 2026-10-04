# IN-12 — Pilot readiness (Phase 1 exit)

Scope source: [Implementation plan](../24-implementation-plan.md) §4 IN-12; doc 15 §§4 (exit gate), 11–12; doc 19 §10 scenarios 1–5, 9, 12; doc 11 §16 subset; doc 12 §9.
This increment produces evidence, not features. Failures loop back into the owning increment before exit.

## F-12.1 UAT scenario harness

| File | Action | Contents |
|---|---|---|
| `packages/test-kit/src/scenarios/*.ts` | new | Scripted seeds + step runners for doc 19 §10 scenarios 1–5, 9, 12 with stable test-env IDs |
| `apps/api/test/e2e/pilot-scenarios.e2e.spec.ts` | new | Automated pass of each scenario asserting versions, authority, audit/outbox, projections, final consistency (doc 19 §10 closing paragraph) |
| `fresh-start/docs/build-plan/uat-checklist.md` | new | Human UAT script per role (doc 13 §2 UAT row) with sign-off boxes |

## F-12.2 Restore and outage drills

Covers: doc 12 §9 validation steps 1–7; `NFR-05/06/12`.

| File | Action | Contents |
|---|---|---|
| `infra/drills/restore-drill.md` + `infra/drills/restore.sh` | new | Snapshot → isolated restore → migration/version check → file-hash sample verify → outbox/provider reconciliation → synthetic journeys |
| `infra/drills/provider-outage.md` | new | Gateway/mail/scanner kill-switch drill scripts against compose stack (doc 12 §3 behaviors) |

Exit artifact: timed drill report with RPO/RTO measurements committed to `fresh-start/docs/build-plan/evidence/`.

## F-12.3 Security review pass

Covers: doc 11 §16 items applicable to Phase 1 scope.

| File | Action | Contents |
|---|---|---|
| `fresh-start/docs/build-plan/security-review-phase1.md` | new | Checklist run: threat-model per workflow, authz matrix results, upload isolation evidence, MFA/privileged access, secrets/backup posture, audit coverage inventory (mutation → audit test), open findings with owners |

External penetration test is scheduled here, executed before material transaction volume (doc 11 §16) — booked, not blocked on.

## F-12.4 Accessibility and performance pass

| File | Action | Contents |
|---|---|---|
| `apps/*/test/a11y/*.spec.ts` | new | Automated axe + keyboard-path tests on launch journeys (doc 21 §9 bars) |
| `infra/perf/phase1-load.js` | new | Doc 13 §10 launch-journey load: RFQ deadline burst, acceptance concurrency, upload finalize; p95 report vs `NFR-02/03` |
| `fresh-start/docs/build-plan/evidence/a11y-perf-report.md` | new | Findings + fixes |

## Increment exit = Phase 1 exit gate (doc 15 §4)

- [ ] All seven automated pilot scenarios green; human UAT signed per role.
- [ ] Restore drill within RPO/RTO; provider-outage behaviors match doc 12 §3.
- [ ] Zero true items on doc 15 §12 "not ready" list for Phase 1 scope; remaining risks documented with owners.
