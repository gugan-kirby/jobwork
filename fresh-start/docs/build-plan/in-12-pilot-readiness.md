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

**Deviations (2026-10-04, F-12.5):**

- `award.command.ts` is unchanged. An award already requires its round to be in `evaluation`, so a superseded round is refused by the existing guard (`AWARD_RFQ_NOT_IN_EVALUATION`, "The round is superseded."). A round on an older revision cannot be live alongside a newer one, because the revision supersedes every live round in its own transaction. `AWARD_REQUIREMENT_SUPERSEDED` would have guarded a state that cannot exist.
- The revision itself is refused in two more cases: after an award is approved (`REVISION_AFTER_AWARD`, which is engineering change control's job in IN-13), and while an award waits for approval (`REVISION_AWARD_PENDING`, because approving it would land on a round that no longer stands). A revision that changes nothing is refused (`REVISION_UNCHANGED`).
- The route is `POST /intake/:enquiryId/revise`. The revision edits the enquiry's live items, so the next round copies the revised lines, and it can replace the governing document with another of the enquiry's own attachments.
- Two events instead of one. `sourcing.requirement_revised.v1` (per enquiry) is acknowledged by the worker. `sourcing.rfq_superseded.v1` (per round) notifies every invited supplier through the new `supplier.rfq_superseded` template (in-app and email). A superseded round's conversation thread closes like an awarded one.
- The customer's projection is unchanged: the enquiry stays "approved for sourcing" and nothing about rounds or suppliers reaches it (asserted). "Requirements updated" is what the supplier sees, on the list, the detail page and the notice.

**Browser verification (2026-10-04, F-12.5).** Run against the dev stack with the worker running. Engineering revised a dev enquiry whose round had two bids in evaluation. The round showed `superseded` in the operations list. Both suppliers got the in-app notice. The supplier list and detail page said "Closed: requirements updated" and explained that the bid stands but will not be awarded. The revisions table showed each reason. One defect showed only in the browser, now fixed: the receipt naming the superseded rounds vanished when the page reloaded, because the panel was keyed by the enquiry version. Found alongside, outside this functionality: the supplier list shows a countdown on an already-awarded round. That is fixed separately.

## F-12.1 Pilot scenario harness

| File | Action | Contents |
|---|---|---|
| `apps/api/test/pilot/driver.ts` | new | API step functions for the whole Phase 1 path, each returning the record and asserting its HTTP outcome; assertion helpers for audit trails, outbox events, notifications, customer and supplier projections, and money/quantity consistency |
| `apps/api/test/pilot/scenario-0{1,2,3,4,5,9}-*.api.spec.ts`, `scenario-12-*.api.spec.ts` | new | Doc 19 §10 scenarios 1–5, 9, 12, each demonstrating versions, authority, audit/outbox, projections, notifications, failure recovery and final consistency |
| `docs/build-plan/uat-checklist.md` | new | Human UAT script per role (customer, supplier, sourcing, engineering, sales, finance, quality, platform admin) with sign-off boxes |

**Deviations (2026-10-05, F-12.1):**

- The driver seeds only the cast and the props as rows: organizations, people and roles (internal accounts have no self-service path), MFA secrets, supplier eligibility (IN-04's suite proves onboarding), and the customer's scanned-clean drawing (the DMS suites prove upload and scan). Everything after that goes over HTTP. Two facts are still touched in SQL. A quote's validity is aged with its immutability trigger lifted, as the IN-07 suite does. The provider's intent id is read from its row, because it is the gateway's reference and no JobWork screen shows it.
- The driver dispatches notifications the way the worker does: right after release, so recipients are resolved before anyone declines, and again before notices are asserted.
- `TestClient` gained an optional `headers` option, so idempotency keys travel with ordinary requests.
- No quality role in the checklist: Phase 1 scenarios 1–5, 9 and 12 involve no quality step. Quality joins the UAT in IN-14.

**Defects the scenarios found.** Each was fixed in its own PR, with a regression test in the owning suite, before its scenario was committed:

| Found by | Defect | Fix |
|---|---|---|
| Scenario 4 | Once a quote expired or was rejected, JobWork could not re-quote: the closed option still held its label in the reused offer set | PR #6: a fresh offer set once every option in the last one has closed without an acceptance; doc 05 states it |
| Scenario 1 | A bid's freight to JobWork and its tooling/NRE never reached the award, the cost sheet or the PO, so margin was overstated by those charges. On a split, the second supplier's setup was dropped | PR #7: migration 0019, charges carried on the first award line citing each bid and shown on the PO; doc 10 §2 states it |
| Scenario 2 | The approved revision, the one every round is built on, lost the clarification answers that the previous revision carried | PR #8: every snapshot includes the answered clarifications |
| Scenario 12 | A user or membership could be suspended with no recorded reason, and the audit row was written after the transaction | PR #9: reason required and audited in the same transaction; the People card asks for it |

**Observations left for UAT and the owner (not changed):**

- An unselected supplier gets no notice. Only its bid's status (`rejected`) tells it the outcome, because `commercial.approval_decided.v1` is acknowledged, not notified. Doc 19 does not require a notice; decide at UAT.
- Approval cannot edit the requirement. Structured answers (a grade, a tolerance) reach RFQ lines when engineering transcribes them with "Revise requirement" right after approval (scenario 2). Watch for friction at UAT step 2.4.
- A bid on a superseded round keeps the status `submitted`; the round's `superseded` status carries the closure (scenario 5).
- ~~Refused cross-party requests leave no trace.~~ Corrected in F-12.3: IN-11 already counts them. `http_server_request_duration_seconds` carries route, status and caller; the security dashboard plots "External refusals (403/404)"; `ExternalDenialSpike` pages, and its runbook is `cross-tenant-or-contact-exposure.md`. UAT step 12.6 checks the panel.

**Verification (2026-10-05, F-12.1).** 45 scenario tests across seven files, each booting its own database. They run inside the API suite in CI and under `TZ=Asia/Kolkata`.

## F-12.3 Security review pass

| File | Action | Contents |
|---|---|---|
| `apps/api/test/audit-coverage.spec.ts` | new | Every command operation in the API declares audit; the inventory is generated from source and checked, so a new command without audit fails the build |
| `docs/build-plan/security-review-phase1.md` | new | Doc 11 §16 item by item: evidence (test files, runs), status, owner; threat model per Phase 1 workflow; open findings |

**Deviations (2026-10-05, F-12.3):**

- The coverage check is structural, not a runtime guard. Several commands legitimately return `audit: []` on a no-op path (a duplicate callback, an unchanged state), so the rule is that every command's working path returns a non-empty audit. Direct audit writes are held to their transaction by type: `AuditWriter.write` no longer accepts `null` or the pool. The inventory is a committed snapshot, so a new command shows up in review.
- Two high findings were fixed inside this functionality rather than in separate PRs, because the review is where they surfaced: production start on repository-published secrets (new `productionConfigProblems` in `@jobwork/service-auth`, used by the API and worker), and nine audit rows written after their transaction committed.
- The nightly security step now also runs pilot scenario 12, the audit-coverage check and the production-configuration check by name.
- Findings are numbered within the review document rather than given a new stable ID family. Those that need the owner are carried to **Waiting for the owner** below.

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
| Secret scanning and push protection on the GitHub repository | Repository settings; the build token cannot read them (security review finding 6) | Product owner |
| Just-in-time staff access, or a recorded risk acceptance for the pilot | Doc 11 §4 insider-export control not built; mass-download alert is the compensating control (finding 7) | Product owner |
| Named incident contacts and an on-call roster | Runbooks exist and are tested; nobody is named to run them (finding 12) | Product owner |
