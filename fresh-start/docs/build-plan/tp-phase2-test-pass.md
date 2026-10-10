# TP — Phase 2 test pass (IN-17 and IN-18 deferred testing)

Scope source: the deferred items recorded in [IN-17](in-17-dispatch-delivery.md) (F-17.6) and [IN-18](in-18-settlement-support.md) (F-18.1–F-18.4, increment exit); Phase 2 exit per [roadmap](../15-roadmap.md) §5; doc 13 test strategy; doc 19 §10 scenarios 11 and 12.

**Why now (2026-10-08).** The owner deferred all testing on 2026-10-07 to finish the build. With IN-00–IN-18 built and nothing left on the roadmap, the owner chose to run the test pass. The deferral is lifted and the execution protocol in [README](README.md) applies again: each item's tests go green before the next item starts, and defects are fixed on their own `fix/` branches.

**Baseline before the pass.** `pnpm -r build && pnpm typecheck && pnpm lint && TZ=Asia/Kolkata pnpm test` was green on `main` at 39d50b9. 872 tests ran: api 507, ui 171, database 103, worker 39, web-kit 22, portal 21, observability 6, service-auth 3. IN-17 F-17.5 and all of IN-18 are covered by no specs of their own, and their screens were never driven in a browser.

**Defects found while reading the code for this plan.** Each one becomes a failing test first and is then fixed.

| # | Where | Defect |
|---|---|---|
| D1 | `CaseCommand.cancelAction` | Cancelling the last planned action of a case still `resolution_approved` leaves the case there. `close` needs `verifying` and the trigger allows `resolution_approved → executing` only, so the case can never close. |
| D2 | `CaseCommand.cancelAction` | Cancelling ignores the case's state: an action can be cancelled while its proposal is still waiting for approval, or after the case is closed. |
| D3 | `CaseCommand.propose` and `SettlementRepository.holdingCases` | A `supplier_recovery` action on a case with no purchase order (every customer-opened case) books a recovery that holds no settlement. The rule says a recovery holds the supplier's settlement. The case must name the purchase order before a recovery is proposed. |
| D4 | `support.resolution_action` (found by TP.1) | Nothing stopped a done or verified action from being reopened, edited or deleted, so a verified credit note could be set back to planned and carried out twice. Migration 0028 adds a forward-only trigger: planned → done → verified, or planned → cancelled. Only planned actions may be deleted, which a replacing proposal does. |
| D5 | `@jobwork/contracts` settlement and support `quantity` (found by TP.1) | `'0'` passed validation, then failed the database's `quantity > 0` check with a 500. The schema now refuses it with a 400. |
| D6 | `FinanceBillsController` (found by TP.4) | The JobWork finance routes `GET /supplier-bills` and `/supplier-bills/:id` answered a supplier with its own bills, because they shared the supplier route's scoping. Nothing leaked, since the view was the supplier projection, but an internal route must refuse anyone outside JobWork (deny by default). They now require JobWork finance. |
| D7 | Ops case page (found by TP.5) | A planned action showed "Reason to cancel" while its proposal still waited for approval, and after the case closed. The API refuses a cancel in both states (D2), so the screen offered something that could only fail. The cancel controls now appear only while the agreed resolution is being carried out. |
| D8 | Ops case page (found by TP.5) | "Close the case" was enabled while an action was still unverified, and the API then refused with `ACTIONS_UNVERIFIED`. It is now disabled until every action is verified or cancelled, and it says why. |
| D9 | `AppShell` header, `@jobwork/ui` (found by TP.5) | From 768px up, the operations navigation (19 items) ran in one row with no wrap and no menu. At 1280 it ran off-screen from Approvals on: Held messages, Suppliers, Organizations, Health, Audit and Account could not be reached. The row now wraps. The e2e smoke checks that every primary link sits inside the viewport. |
| D10 | Three-way match (found by TP.6) | The match read the PO's issued total only. A change that raises the supplier's cost appends an acknowledged amendment, never a rewrite, so a supplier billing the amended amount failed the match. A delta inside the 1 % tolerance passed by accident. The match now commits the PO total plus acknowledged amendments. |
| D11 | `POST /cases` (found by TP.6's matrix) | A customer posting to the case center's route got 403, yet the case was already written and audited. The shared command let the customer through, and only the internal read-back refused. A retry opened duplicates. |
| D12 | JobWork-only routes (found by TP.6) | The same class as D6: `/ncrs`, `/shipments` (read, pickup, cancel), `/inspections` and `/ncrs/:id/containment` answered a supplier with its own records. D6, D11 and D12 are now closed by one mechanism, `@InternalOnly()`. The session guard enforces it before the handler runs, on every JobWork-only controller. The per-method audience parameters from D6 were removed. |
| D13 | Customer deviation view (found by TP.6) | It returned the workshop's own lot codes (`LOT-A`), against IN-17's rule that customers see only JobWork's `JW-` markings. It now shows the markings of the stock lots JobWork holds, and none before receiving. |

## TP.1 Settlement (F-18.1)

| File | Action | Contents |
|---|---|---|
| `database/tests/settlement-support.db.spec.ts` | new | 0027: a bill keeps what was billed; a paid settlement is final; credit notes and case events are immutable; the case machine and its close guard; `chk_action_verifier`; `chk_action_money` |
| `apps/api/test/settlement.api.spec.ts` | new | Bill submit (role, own acknowledged PO, duplicate reference); match pass posts the payable and opens a settlement; match fail → exception; self-approval refused, a second finance member approves; reject; eligibility holds (open NCR, inactive supplier, unverified bank, dispute case) and recheck; schedule and pay journals balance and leave the customer's receivable untouched; a paid settlement cannot be paid twice; the supplier sees only its own bills, with no internal fields |

**Done (2026-10-08).** `settlement-support.db.spec.ts` has 7 tests and `settlement.api.spec.ts` has 9; D4 and D5 are fixed. The bill exception's payable is audited as the rail's `commercial.approval_decided` on the bill, whose data carries the journal. That matches every other approval effect, so it was not changed. A JobWork-suspended supplier may still bill for work done; its settlement is held while suspended (doc 10 §5), and the spec asserts this.

## TP.2 Cases, credit notes, returns (F-18.2)

| File | Action | Contents |
|---|---|---|
| `apps/api/test/cases.api.spec.ts` | new | Case machine from open to closed. A customer opens a case but cannot link exceptions or purchase orders, and withdraws only before work starts. Resolution goes through the approval rail: money to finance, physical remedies to quality. Every action is carried out by its owning role and verified by another person. Close is refused while any action is unverified. A credit note leaves the invoice unchanged and is refused beyond the invoice's total. The customer-paid, supplier-failed path ends in a refund plus a supplier recovery that holds settlement. Returns conserve the ledger. Closing lifts the hold. The customer view never shows the supplier, its purchase order, the recovery or internal notes. Regression tests for D1–D3. |

**Done (2026-10-08).** `cases.api.spec.ts` has 8 tests, and D1–D3 are fixed in `CaseCommand`:
- A cancel now runs only while the agreed resolution is being carried out. The last cancellation moves the case on to verification.
- A proposal with a recovery must name the purchase order, which links it to a customer-opened case. The ops proposal form asks for it.
- Opening a case with a purchase order now checks that the PO belongs to the case's order. Before, any PO id was accepted.

The pilot driver gains `dispatchToCustomer`, `proofOfDelivery`, `stockLots`, `markingOf` and `ledger`.

## TP.3 Margin (F-18.3)

| File | Action | Contents |
|---|---|---|
| `apps/api/test/margin.api.spec.ts` | new | Planned margin comes from the approved cost sheet. Realized margin is net of a credit note and a recovery. Variance stays null until every live PO has a matched bill. Finance and sales only; customer and supplier get 403. |

**Done (2026-10-10).** `margin.api.spec.ts` has 3 tests and found no defect. The planned figures match the cost sheet version behind the accepted quote. Actual revenue and cost are checked against the journal lines on the order and its purchase orders. A case with a credit note (taxable 20,000) and a supplier recovery (24,700) moves the realized margin and the variance by exactly those amounts. Quality, support, logistics, customer and supplier members all get 403.

## TP.4 Pilot scenarios 11 and 12, UAT

| File | Action | Contents |
|---|---|---|
| `apps/api/test/pilot/scenario-11-delivery-exception.api.spec.ts` | new | F-17.6 delivery half (IN-17 plan steps 1–5) and the IN-18 half: the held exception becomes a case, ending in a return, credit note or refund, and supplier recovery, with every action verified and the case closed. The supplier bill is then matched and paid, and the order is `closed`. |
| `apps/api/test/pilot/scenario-12-suspension-cross-party.api.spec.ts` | edit | Phase 2 surfaces: a suspended user cannot bill or open a case; a supplier cannot reach cases, margin or another supplier's bills; a customer cannot reach bills or another customer's cases |
| `docs/build-plan/uat-checklist.md` | edit | UAT 11.x (delivery and case, per role), 12.x additions |

**Done (2026-10-10).** `scenario-11-delivery-exception.api.spec.ts` has 7 tests, and scenario 12 gains 2 (9 in all). D6 is fixed. The UAT checklist gains 11.1–11.21 and 12.7–12.9.
- Scenario 11 covers IN-17 plan steps 1–5 as written, then the IN-18 half: a case with a credit note, a supplier recovery that holds the settlement, and a concession. The order then reaches `customer_accepted`, and `closed` once the settlement is paid.
- The return in this scenario is the refused delivery's own leg. The case does not add a second return, which would have sent the accepted pieces back. `cases.api.spec.ts` already covers a case-driven return and rework.
- Scenario 12 covers the Phase 2 surfaces. A supplier cannot see another supplier's bill (the same 404 as an invented id). Suppliers and customers cannot reach cases, margin or the finance bill routes. Another customer's case gets the same 404. A suspended supplier cannot bill, and a suspended customer cannot open a case.

## TP.5 Browser walk (F-17.5 remainder, F-18.4)

Every IN-18 screen is driven at desktop (1280) and phone (390) widths against the dev stack. A defect in the walk gets its own `fix/` branch. The e2e suite gains the IN-18 smoke paths with an axe check:

| File | Action | Contents |
|---|---|---|
| `e2e/tests/settlement-support.spec.ts` | new | Ops `/finance/bills`, `/finance/margin`, `/support`, `/support/[caseId]`; portal `/supplier/bills`, `/support`, `/support/[caseId]`; each page loads with no axe violations at both widths |

**Done (2026-10-10).**
- `settlement-support.spec.ts` has 8 tests: four journeys at 1280 and 390. Each page shows its heading, does not scroll sideways, keeps the primary navigation inside the viewport, and has no serious or critical axe violation. The world gains deal D: supplier A acknowledged and billed its PO, and the customer opened a case on the order. `support@jobwork.test` joins the seeded people. The e2e suite now runs 18 tests, all green.
- The walk was driven on the booted e2e stack, on a fresh database at each width:
  - the supplier submits a bill;
  - the customer adds a note to its case and raises another;
  - support triages, investigates and proposes a credit note;
  - finance approves it, issues the credit note against the advance invoice, runs the match (an exception: nothing was accepted yet) and opens margin.
- The walk found D7–D9, now fixed, and a "1 pieces" caption on the supplier's bill list. `/finance/margin` was empty on the walk because neither order was commercially released yet, which is the view's rule. Margin with data is covered by `margin.api.spec.ts`.

## TP.6 Phase 2 exit

| Item | Evidence |
|---|---|
| Full enquiry-to-customer-acceptance path with one change and one NCR drill | `apps/api/test/pilot/phase2-exit.api.spec.ts`: one deal from enquiry through change, NCR, rework, release, both legs, acceptance, bill and settlement to `closed` |
| Restore drill rerun | `pnpm drill:restore` → `docs/build-plan/evidence/drills-2026-10-08.md` |
| Security assessment rerun | `docs/build-plan/security-review-phase2.md`: the doc 11 §16 gates over the IN-13–IN-18 surfaces, findings fixed or recorded. The external penetration test stays an owner item. |
| Full local gate + nightly | `pnpm -r build && pnpm typecheck && pnpm lint && TZ=Asia/Kolkata pnpm test`, `pnpm --filter @jobwork/e2e e2e`, `pnpm nightly`; counts recorded here |

**Done (2026-10-10).**
- **Phase 2 exit pilot.** `phase2-exit.api.spec.ts` has 6 tests. One deal runs through sourcing, a quote the customer accepts, a PO and production. A customer-requested change is priced, approved by sales and the customer, released as a new baseline and acknowledged. The quality plan is revised against the new baseline (`PLAN_BASELINE_STALE` until then). A failed first article becomes an NCR: contained, reworked, passed on reinspection, and closed on a verified corrective action. Both lots are released, shipped and received in full. The change invoice and the balance are paid, the delivery is accepted, and the bill for the amended PO matches (D10) and is paid. The order is `closed` and the margin is complete.
- **Restore drill.** It failed correctly, on the one known development row and nothing else: [drills-2026-10-10.md](evidence/drills-2026-10-10.md). The drill now counts the Phase 2 records and checks that the stock ledger stays immutable. It also no longer leaves its API running.
- **Security assessment.** [security-review-phase2.md](security-review-phase2.md). A source audit and 35 new matrix probes found D11–D13 and three low findings, all fixed. No high or critical finding is open. Finding 9, whether customers see changes they did not propose, is the owner's decision. The external penetration test stays an owner item.
- **Full local gate.** Build, typecheck and lint are green, and `TZ=Asia/Kolkata pnpm test` ran 915 tests: api 543, ui 171, database 110, worker 39, web-kit 22, portal 21, observability 6, service-auth 3. e2e ran 18 tests, all green, at TP.5.
- **Nightly.** On GitHub, the scheduled nightly had failed every night since 2026-10-06, but only on its dependency audit: two criticals in tinypool via vitest 3, and highs in source-map-js and sharp. A separate PR, `fix/dependency-audit`, overrides all three. `pnpm audit --audit-level=high` now passes, and the full suite is green with the overrides. Locally, `pnpm nightly` passed the UTC suite, the security suites and the load bursts. Two steps failed only for local reasons. The perf smoke needs `SMOKE_SOURCING_TOTP_SECRET` for the dev sourcing account, and the journeys need Playwright's bundled Chromium, which the CI job installs. Both steps pass on CI.

## Exit

- [x] TP.1–TP.4 specs green; D1–D3 fixed (and D4–D6).
- [x] TP.5 walk done; e2e green (D7–D9).
- [x] TP.6 evidence recorded (D10–D13); IN-17 and IN-18 exit checklists ticked; README status board updated.

**Test pass closed 2026-10-10** (PRs #57–#63, the dependency fix and TP.6). Owner items carried: UAT on staging with the checklist's scenarios 11–12; finding 9 of the Phase 2 security review; the development file with no bytes; the external penetration test; and the Phase 1 owner items.
