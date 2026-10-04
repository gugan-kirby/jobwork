# IN-13 — Engineering change control (Phase 2)

Scope source: [Implementation plan](../24-implementation-plan.md) §5; doc 06 §9 state machine; doc 09 §§6–8; doc 05 §8 (cost-object journals); doc 14 §4; `FR-604`–`FR-605`; `BR-ENG-03`–`BR-ENG-05`, `BR-ENG-07`.
Edge cases owned (doc 19 §5): new revision after production start; customer urgent change (interim stop/continue). Pilot scenario 6 (doc 19 §10). Scenario 5 (revision after bid, before any baseline) was delivered by IN-12 F-12.5.
Use cases: UC-06, UC-27.

**Refresh (2026-10-05, before build).** Written at inception. IN-09 has since built baselines, transmittals, work packages and containment, and the refresh reads that code (map in the PR). Phase 2's order is taken as planned, without pilot learnings: the pilot has not run, and the owner's UAT items are open (recorded in **Decisions taken on the owner's behalf**). Changes, each with its reason:

| Original | Now | Why |
|---|---|---|
| `0013_change.sql`; module `dms` | `0020_change_control.sql`; a `change` module beside `orders` (it reads production, commercial and DMS records) | 0013 is taken. A change spans baseline, purchase order, sales order and money, which is more than document management |
| Change built beside baselines | **F-13.1 starts by closing three IN-09 gaps.** (a) A second production baseline can be released today with no change request, superseding silently, even after work has started (`FR-604`, `BR-ENG-05`). (b) Milestone evidence is stamped with the order's *current* baseline, not the one the supplier acknowledged (`BR-ENG-04`). (c) A superseded drawing stays downloadable by the supplier | Change control is meaningless while the uncontrolled path exists, and evidence must name the baseline actually used |
| `issue-containment` as a change sub-step | Containment becomes a **scoped interim decision** (stop or continue, scope, expiry, formalization) that the release gate and milestone start read. IN-09's `containment_event` stays as the record of what happened | Today containment blocks nothing and never expires (doc 19 §5: "interim stop/continue authority") |
| "Approval uses policy engine (customer approval flag per contract)" | Internal approval is a new approval kind, `change`, using the effect registry (`approval-effects.ts`). The **customer's decision is a separate customer command** with approver role and limit type `change_acceptance`, modelled on quote acceptance | The approval engine is internal-only (`DecideApprovalCommand` requires `isInternal`). Customer authority already has its pattern: role, limit and authority snapshot |
| "Price/date deltas route through commercial approval (re-quote path to IN-07)" | **Amendments:** an approved, customer-accepted change records an immutable `order_amendment` (customer price and date deltas) and `purchase_order_amendment` (supplier cost and lead-time deltas). A positive customer delta becomes a `change` installment that finance invoices; a negative one is recorded as credit due, settled in IN-18 | An accepted quote is terminal (doc 06 §6: "amendments create formal later records"); re-quoting after acceptance would create a second contract |
| "WIP/scrap captured into cost-object journals" | WIP disposition rows per affected quantity (reuse, rework, scrap), and a balanced journal for scrap and rework cost tagged with the sales order as cost object. New accounts `change_cost` (expense) and `supplier_accrual` (liability) | Doc 05 §8; no WIP or scrap ledger exists yet |
| Three functionalities | Four: **F-13.4 pilot scenario 6** added | Doc 19 §10 scenario 6 is this increment's exit evidence |

## F-13.1 Close the uncontrolled-baseline gaps

| File | Action | Contents |
|---|---|---|
| `database/migrations/0020_change_control.sql` (part 1) | new | `dms.baseline.change_request_id` (required when superseding); `orders.work_package_baseline` history (work package, baseline, transmittal, effective from), so each work package shows every baseline it worked to |
| `orders/application/production.command.ts` | edit | `releaseBaseline` refuses when a released baseline exists (`BASELINE_CHANGE_REQUIRED`); only the change's release command supersedes. Milestone evidence takes its baseline from the PO's acknowledged live transmittal |
| `orders/infrastructure/production.repository.ts` | edit | On superseding: revoke supplier grants to document versions absent from the new baseline; record the work-package baseline history |

Tests: a second release outside a change is refused; evidence after a new baseline is issued but not acknowledged names the old baseline; the supplier can no longer download a version the new baseline dropped, while the old evidence rows still reference it.

## F-13.2 Change domain and commands

| File | Action | Contents |
|---|---|---|
| `0020_change_control.sql` (part 2) | — | `change.change_request` (number `CR-`, sales order, origin `customer`/`supplier`/`internal`/`document_revision`, classification `clarification`/`correction`/`scope`, urgency, status per doc 06 §9, candidate documents, reason); `change.change_impact` (one row per doc 09 §8 area: answered with structured deltas, or not applicable with a reason; versioned); `change.interim_decision` (stop or continue, scope = purchase orders and work packages, expires at, formalized by); `change.wip_disposition`; `change.customer_decision` (immutable, authority snapshot); `orders.order_amendment`, `orders.purchase_order_amendment` (immutable); approval kind `change`; installment kind `change`; ledger accounts `change_cost`, `supplier_accrual`; templates for customer decision needed, supplier change issued, change decided |
| `change/domain/change.ts` | new | The doc 06 §9 machine; `customerApprovalRequired` (scope change, or any price or date delta); the impact-completeness rule (all eight areas answered or n/a with a reason) |
| `change/application/*.command.ts` | new | `propose` (internal, or customer requester/approver from the order page); `start-triage`, `request-info`/`provide-info`, `classify` (a clarification closes without a baseline); `issue-interim-decision` (engineering or sourcing; expiry required; formalization required before release); `record-impact` (per area, versioned; supplier impact input for its own POs); `complete-impact` → approval request; approval effect → `approved` or `rejected`; `customer-decide` (approver, limit `change_acceptance`); `release-new-baseline` (approved, plus customer-approved when required: assembles the superseding baseline from the candidates, issues transmittals, records amendments, posts the WIP/scrap journal, revokes stale grants); `acknowledge` (supplier transmittal plus PO amendment → `implemented`); `verify`, `close` |
| `dms/application/finalize-upload.command.ts` | edit | A new version of a document in a released baseline of an open order opens a `proposed` change with origin `document_revision`, in the same transaction (`BR-ENG-05`) |

Tests:
- every illegal transition is refused;
- impact cannot complete with an area unanswered;
- a stop decision blocks milestone start and work-package release, and once expired it no longer blocks;
- release is refused until internal approval, and customer approval where required, are both in;
- the old baseline and its evidence are untouched;
- amendments carry exact deltas;
- the scrap journal balances and names the sales order;
- a supplier sees only its own POs' changes;
- the customer never sees supplier cost.

## F-13.3 Change UX

| File | Action | Contents |
|---|---|---|
| `apps/operations-web/app/changes/*` | new | Change list and detail: impact matrix editor (eight areas), interim decision panel, approval status, baseline diff (old against candidate manifest), release |
| `apps/portal-web/app/orders/[orderId]` | edit | Customer: "Request a change"; the decision card shows the impact summary with price and date effect only (no supplier cost), and approve or reject with authority (doc 14 §4) |
| `apps/portal-web/app/supplier/orders/[purchaseOrderId]` | edit | Supplier: the change impact input for its PO, acknowledgment of the new transmittal and PO amendment |

## F-13.4 Pilot scenario 6

| File | Action | Contents |
|---|---|---|
| `apps/api/test/pilot/scenario-06-change-after-production-start.api.spec.ts` | new | A deal in production with evidence submitted. The customer requests a change and engineering stops the affected work. Impact records scrap of 20 pieces and a supplier and customer price delta. Internal approval, then customer approval. A new baseline is released and acknowledged, and the change is verified and closed. Old evidence keeps naming the old baseline. Money adds up: amendment = installment; the scrap journal balances |
| `docs/build-plan/uat-checklist.md` | edit | Scenario 6 steps per role |

## Decisions taken on the owner's behalf

Taken as safe defaults so the build can proceed; each is reversible and recorded here for review.

| Decision | Default | Why it is safe |
|---|---|---|
| Phase 2 order | IN-13 → IN-18 as in doc 24, without pilot learnings | The pilot has not run; the order follows doc 15 §5's dependencies |
| When the customer must approve | Scope changes, and any change with a price or date effect | Errs towards asking; a clarification or a no-impact correction needs no customer decision |
| Customer approval limit | New limit type `change_acceptance`; no row means no limit (as for quotes) | Same rule the customer already uses for quotes |
| Negative price delta | Recorded as credit due; settled by IN-18 (credit notes) | No money moves before the settlement design exists |
| Internal approver | Engineering always; sales as well when there is a price delta; finance when margin falls below the quote floor | Mirrors the existing award, cost-sheet and quote policies |
| Stale drawings | Supplier grants to versions dropped by the new baseline are revoked at release | A supplier cannot manufacture from a drawing that no longer governs; JobWork keeps every version |

## Increment exit

- [ ] Pilot scenario 6 green end to end; scenario 5 still green.
- [ ] No path releases a superseding baseline outside an approved change.
- [ ] Old baseline evidence untouched; every work package shows which baselines it actually used.
