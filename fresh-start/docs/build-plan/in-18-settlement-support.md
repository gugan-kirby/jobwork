# IN-18 — Supplier settlement, returns, warranty, disputes (Phase 2 close)

Scope source: [Implementation plan](../24-implementation-plan.md) §5; `FR-801`, `FR-805`–`FR-806`, `FR-906`; `BR-FIN-03/04/06/07`; doc 10 §§5–6, 15; doc 06 §15 case machine.
Edge cases owned (doc 19 §7/§8): supplier bill exceeds PO/receipt; chargeback after supplier settled; customer paid but supplier fails; return-to-supplier rework leg; refund with tax correction.
Use cases: UC-31, UC-34; pilot scenarios 11–12 completion.

**Refresh (2026-10-07, before build).** Written at inception. IN-08 built finance inside the orders module (invoices, journals with cost objects, credit holds, the approval rail's `allocation` effect). IN-16 and IN-17 built the custody ledger, both legs, return legs on the same stock lots, and delivery exceptions handed to a case by reference. The refresh reads that code. Changes, each with its reason:

| Original | Now | Why |
|---|---|---|
| `0017_settlement_support.sql` | `0027_settlement_support.sql`: `finance.supplier_bill`, `finance.settlement`, `finance.credit_note`; schema `support` (`case`, `case_event`, `resolution_action`); `delivery_exception.case_id` | 0017 is taken; 0026 is the latest |
| A `finance` module | Bills, settlement and credit notes sit in the orders module beside IN-08's finance (`orders/application/settlement.command.ts`, `credit-note.command.ts`) | The IN-16 note "split planned" never happened; splitting now is a refactor with no behaviour, deferred |
| Separate `dispute`, `warranty_claim`, `case_participant` tables | One `case` with a `kind` (`delivery_issue`, `warranty`, `dispute`, `supplier_failure`, `chargeback`) and an append-only `case_event` timeline whose audience is customer or internal | Doc 06 §15 has one machine for all of them; participants are the order's parties |
| Resolution actions "dispatch to owning modules" | Each `resolution_action` (`return_to_jobwork`, `return_to_supplier`, `rework`, `replacement`, `credit_note`, `refund`, `supplier_recovery`, `carrier_claim`, `concession`) is executed by the owning module's command and verified separately. A case closes only when every action is verified or cancelled | Doc 06 §15: closure requires every linked action verified; doc 10 §15: physical, quality, customer and supplier remedies are separate records |
| Returns on a new `authorize-return` command | Customer returns reuse IN-17's return leg (`customer_to_jobwork` on the same stock lots, into quarantine). Supplier returns and rework go out on a `jobwork_to_supplier` leg moving the lots to `OUT-RETURNED` or `OUT-REWORK` | No second lot; the conservation invariant holds |
| Delivery holds "until the case decides" | Closing a case lifts the hold of the delivery exceptions handed to it; the delivery then awaits the customer's acceptance again | IN-17 left handed-to-case holds open for IN-18 |
| Tests per functionality | **Deferred to the test pass** (owner, 2026-10-07): no specs, no audit-inventory snapshot update, no browser walk now | The owner asked to build first and test later |

**Decisions taken on the owner's behalf:**

| Decision | Default | Why it is safe |
|---|---|---|
| Match tolerance (`BR-FIN-07`) | Billed quantity ≤ accepted at JobWork; billed amount ≤ PO value of accepted quantity + 1 % or ₹500, whichever is less | Errs towards holding the bill; a breach goes to a second finance member as an exception, never a silent adjustment |
| Settlement eligibility (doc 10 §5) | PO acknowledged; matched or exception approved; no open NCR on the work package; quality released; supplier active with a verified bank item; no open supplier-recovery action or dispute case on the PO | Every item of doc 10 §5 the system has facts for |
| Who decides | Bill exceptions: another `jobwork_finance` member. Case resolutions with money (credit note, refund, recovery): `jobwork_finance`; others: `jobwork_quality` | Doc 03 §4 maker-checker; quality owns physical remedies |
| Payment rail | Settlement is marked paid with the bank reference (no payout provider; `T-03` open) | No real money moves in the build |
| Order `closed` | When the order is `customer_accepted`, every bill of its POs is paid and no case is open | Doc 06 §7's last state from real facts |
| Journals | Bill: Dr `cost_of_goods`, Dr `gst_input` / Cr `supplier_payable`. Payment: Dr `supplier_payable` / Cr `bank`. Credit note: Dr `revenue`, Dr `gst_output` / Cr `customer_receivable`. Refund: Dr `customer_receivable` / Cr `bank`. Recovery: Dr `supplier_recovery` / Cr `cost_of_goods`. Warranty cost: Dr `warranty_cost` / Cr `supplier_accrual` | Conceptual chart (doc 10 §6); the real chart is `T-04`'s |

## F-18.1 Supplier bills and settlement (UC-31)

| File | Action | Contents |
|---|---|---|
| `database/migrations/0027_settlement_support.sql` | new | The tables above, accounts, approval kinds `bill_exception` and `case_resolution`, queues `supplier_bills_to_match`, `settlements_held`, `cases_open`, templates |
| `apps/api/src/modules/orders/domain/three-way-match.ts` | new | Pure match: PO, accepted receipt, bill; tolerance; reasons |
| `apps/api/src/modules/orders/application/settlement.command.ts` | new | `submitBill` (supplier), `matchBill` (finance), `requestException` / approval effect, `rejectBill`, eligibility, `scheduleSettlement`, `markPaid`; journals |
| `apps/api/src/modules/orders/presentation/settlement.controller.ts` | new | Supplier `/supplier/bills`; JobWork `/supplier-bills`, `/settlements` |

## F-18.2 Support cases, credit notes, returns (UC-34)

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/support/*` | new | `CaseCommand`: open (customer or JobWork, optionally from delivery exceptions), triage, add event, propose resolution (actions), approval effect, execute and verify actions, close (all verified), reject, withdraw; customer view by construction |
| `apps/api/src/modules/orders/application/credit-note.command.ts` | new | Credit note and refund executed for a case action; journals; originals untouched (`BR-FIN-06`) |
| `apps/api/src/modules/logistics/application/return.command.ts` | new | Customer return leg on a delivered shipment; supplier return or rework leg from stock or quarantine |

## F-18.3 Margin realization

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/orders/application/job-margin.ts` | new | Per sales order: quoted price and approved landed cost against posted revenue, credit notes, cost of goods, change, warranty and recovery |

## F-18.4 UX

| File | Action | Contents |
|---|---|---|
| `apps/portal-web/app/supplier/bills/*` | new | Submit a bill against a PO, see its match and settlement |
| `apps/portal-web/app/support/*` | new | The customer's cases: open, follow, add information |
| `apps/operations-web/app/finance/bills/*`, `/finance/margin` | new | Bills to match, exceptions, settlements, margin per order |
| `apps/operations-web/app/support/*` | new | Case center: triage, events, resolution actions, verification, close |

## Increment exit

- [ ] Pilot scenarios 11 (delivery exception → warranty/return/refund) and 12 green: **deferred to the test pass**.
- [ ] Phase 2 exit per doc 15 §5 (enquiry-to-acceptance path incl. change and NCR drill, restore drill, security assessment rerun): **deferred to the test pass**.
