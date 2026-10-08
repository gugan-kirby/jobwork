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

## TP.3 Margin (F-18.3)

| File | Action | Contents |
|---|---|---|
| `apps/api/test/margin.api.spec.ts` | new | Planned margin comes from the approved cost sheet. Realized margin is net of a credit note and a recovery. Variance stays null until every live PO has a matched bill. Finance and sales only; customer and supplier get 403. |

## TP.4 Pilot scenarios 11 and 12, UAT

| File | Action | Contents |
|---|---|---|
| `apps/api/test/pilot/scenario-11-delivery-exception.api.spec.ts` | new | F-17.6 delivery half (IN-17 plan steps 1–5) and the IN-18 half: the held exception becomes a case, ending in a return, credit note or refund, and supplier recovery, with every action verified and the case closed. The supplier bill is then matched and paid, and the order is `closed`. |
| `apps/api/test/pilot/scenario-12-suspension-cross-party.api.spec.ts` | edit | Phase 2 surfaces: a suspended user cannot bill or open a case; a supplier cannot reach cases, margin or another supplier's bills; a customer cannot reach bills or another customer's cases |
| `docs/build-plan/uat-checklist.md` | edit | UAT 11.x (delivery and case, per role), 12.x additions |

## TP.5 Browser walk (F-17.5 remainder, F-18.4)

Every IN-18 screen is driven at desktop (1280) and phone (390) widths against the dev stack. A defect in the walk gets its own `fix/` branch. The e2e suite gains the IN-18 smoke paths with an axe check:

| File | Action | Contents |
|---|---|---|
| `e2e/tests/settlement-support.spec.ts` | new | Ops `/finance/bills`, `/finance/margin`, `/support`, `/support/[caseId]`; portal `/supplier/bills`, `/support`, `/support/[caseId]`; each page loads with no axe violations at both widths |

## TP.6 Phase 2 exit

| Item | Evidence |
|---|---|
| Full enquiry-to-customer-acceptance path with one change and one NCR drill | `apps/api/test/pilot/phase2-exit.api.spec.ts`: one deal from enquiry through change, NCR, rework, release, both legs, acceptance, bill and settlement to `closed` |
| Restore drill rerun | `pnpm drill:restore` → `docs/build-plan/evidence/drills-2026-10-08.md` |
| Security assessment rerun | `docs/build-plan/security-review-phase2.md`: the doc 11 §16 gates over the IN-13–IN-18 surfaces, findings fixed or recorded. The external penetration test stays an owner item. |
| Full local gate + nightly | `pnpm -r build && pnpm typecheck && pnpm lint && TZ=Asia/Kolkata pnpm test`, `pnpm --filter @jobwork/e2e e2e`, `pnpm nightly`; counts recorded here |

## Exit

- [ ] TP.1–TP.4 specs green; D1–D3 fixed.
- [ ] TP.5 walk done; e2e green.
- [ ] TP.6 evidence recorded; IN-17 and IN-18 exit checklists ticked; README status board updated.
