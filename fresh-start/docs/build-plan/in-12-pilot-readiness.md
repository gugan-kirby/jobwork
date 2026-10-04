# IN-12 — Pilot readiness (Phase 1 exit)

Scope source: [Implementation plan](../24-implementation-plan.md) §4 IN-12; doc 15 §§4 (exit gate), 11–12; doc 19 §10 scenarios 1–5, 9, 12; doc 11 §16 subset; doc 12 §§2–3, 9; doc 13 §§10, 12; doc 21 §9.
This increment produces evidence, not features — with one exception the refresh found (F-12.5). Failures loop back into the owning increment before exit.

**Refresh (2026-10-04, before build).** Written at inception; the codebase has moved. Changes, each with its reason:

| Original | Now | Why |
|---|---|---|
| Five functionalities assumed only evidence was missing | **F-12.5 Requirement revision after bids** added, built first | Pilot scenario 5 ("engineering revision after supplier bid") has no path today: no command revises a requirement once sourcing starts, and nothing stops an award from resting on bids priced against a superseded revision |
| `packages/test-kit/src/scenarios/*.ts` + one `pilot-scenarios.e2e.spec.ts` | `apps/api/test/pilot/driver.ts` (API steps and assertions) + one spec per scenario | The steps need the booted API and the test client, which live in the API's tests; one file per scenario runs them in parallel and a failure names its scenario |
| Scenarios seeded by scripts | Every step through the HTTP API, from the customer's draft to the supplier's acknowledged PO | The pilot is about the real path; SQL fixtures (as the IN-09 suite uses) would skip the very commands being proven |
| `infra/drills/*` against the compose stack | Against the Homebrew stack this machine runs (no Docker), scripted so a Docker host can follow the same steps | The drill must actually run; `pg_dump`/`pg_restore` stands in for PITR, which needs `T-01` |
| `apps/*/test/a11y/*.spec.ts` (jsdom) | Real-browser accessibility pass: Playwright + axe over launch journeys on a booted stack, in the nightly | jsdom has no layout, focus order or computed styles; the component axe suite already covers what jsdom can (`packages/ui/test/a11y.spec.tsx`) |
| `infra/perf/phase1-load.js` (k6) | `apps/api/test/perf/phase1-load.perf.ts` run by the nightly | The bursts need seeded worlds (RFQ with many invited suppliers, quotes with sibling options); the API test harness already builds them, and correctness under concurrency is asserted alongside latency |
| Order 12.1 → 12.4 | 12.5 → 12.1 → 12.3 → 12.2 → 12.4 | Scenarios need F-12.5; the security review cites the scenario and matrix results; the drills use a scenario as their synthetic journey |

Owner items this increment cannot complete on its own are listed under **Waiting for the owner** at the end; the exit gate stays open on them.

## F-12.5 Requirement revision after bids (built first)

Covers: doc 19 §10 scenario 5; doc 19 §3 "new revision after quote"; `BR-COM-04`; `BR-SYS-02`; doc 06 §4 (bids immutable once submitted).

| File | Action | Contents |
|---|---|---|
| `database/migrations/0018_requirement_revision.sql` | new | RFQ status `superseded` (with the revision that superseded it); requirement revision reason and author |
| `apps/api/src/modules/sourcing/application/revise-requirement.command.ts` | new | Engineering (MFA) revises the reviewed requirement of an enquiry that is in sourcing, with a reason: a new immutable revision; every round still open or in evaluation on the old revision becomes `superseded`; invited suppliers are told the round closed for a revision; submitted bids stay as they were, immutable, and are never awardable |
| `apps/api/src/modules/commercial/application/award.command.ts` | edit | An award on a round whose requirement is not the enquiry's current revision is refused (`AWARD_REQUIREMENT_SUPERSEDED`) |
| ops intake screen | edit | "Revise requirement" with reason; the RFQ list shows superseded rounds and offers a new round on the current revision |

Tests: revising after bids supersedes the open round and leaves every bid byte-identical; an award on the superseded round is refused; a new round is created on the new revision and its bids are awardable; the customer sees "requirements updated", never the supplier side; the command is audited with its reason and emits an outbox event the worker acknowledges.

## F-12.1 Pilot scenario harness

| File | Action | Contents |
|---|---|---|
| `apps/api/test/pilot/driver.ts` | new | API step functions for the whole Phase 1 path, each returning the record and asserting its HTTP outcome; assertion helpers for audit trails, outbox events, notifications, customer and supplier projections, and money/quantity consistency |
| `apps/api/test/pilot/scenario-0{1,2,3,4,5,9}-*.api.spec.ts`, `scenario-12-*.api.spec.ts` | new | Doc 19 §10 scenarios 1–5, 9, 12, each demonstrating versions, authority, audit/outbox, projections, notifications, failure recovery and final consistency |
| `docs/build-plan/uat-checklist.md` | new | Human UAT script per role (customer, supplier, sourcing, engineering, sales, finance, quality, platform admin) with sign-off boxes |

## F-12.3 Security review pass

| File | Action | Contents |
|---|---|---|
| `apps/api/test/audit-coverage.spec.ts` | new | Every command operation in the API declares audit; the inventory is generated from source and checked, so a new command without audit fails the build |
| `docs/build-plan/security-review-phase1.md` | new | Doc 11 §16 item by item: evidence (test files, runs), status, owner; threat model per Phase 1 workflow; open findings |

## F-12.2 Restore and outage drills

| File | Action | Contents |
|---|---|---|
| `infra/drills/restore.sh` + `restore-drill.md` | new | Snapshot → isolated restore → migration version → file-hash sample against the store → outbox and provider reconciliation listing → a pilot scenario against the restored database; timed |
| `infra/drills/provider-outage.sh` + `provider-outage.md` | new | Worker down, object store down, Redis down, payment callbacks withheld: each against doc 12 §3's required behaviour, then recovery |
| `docs/build-plan/evidence/drills-<date>.md` | new | Timed report: RPO/RTO as measured, behaviours observed |

## F-12.4 Accessibility and performance pass

| File | Action | Contents |
|---|---|---|
| `e2e/` package (Playwright + axe) | new | Launch journeys in both apps on a booted stack: sign-in, enquiry wizard, quotation decision and acceptance, order tracking; supplier RFQ and PO; operations intake, queues, approvals. Axe with no serious or critical violation; keyboard-only path through each journey |
| `apps/api/test/perf/phase1-load.perf.ts` | new | RFQ deadline burst (many suppliers submitting at once), sibling-option acceptance race (exactly one wins), upload finalize burst; p50/p95/p99 against `NFR-02/03` |
| `.github/workflows/nightly.yml`, `infra/nightly.sh` | edit | Run both |
| `docs/build-plan/evidence/a11y-perf-<date>.md` | new | Findings and fixes |

## Increment exit = Phase 1 exit gate (doc 15 §4)

- [ ] All seven automated pilot scenarios green; human UAT signed per role.
- [ ] Restore drill within RPO/RTO; provider-outage behaviours match doc 12 §3.
- [ ] Zero true items on the doc 15 §12 "not ready" list for Phase 1 scope; remaining risks documented with owners.

## Waiting for the owner

Recorded here as they are found; each keeps the exit gate open until the owner acts.

| Item | Why it cannot be done by the build | Owner |
|---|---|---|
| Human UAT sign-off per role | Needs real users from a pilot customer and supplier | Product owner |
| External penetration test | Booked with an outside firm "before material transaction volume" (doc 11 §16) | Product owner |
| Legal, tax, invoice and payment responsibilities | Doc 15 §12 last item; professional sign-off (`D-*` decisions) | Product owner with advisers |
