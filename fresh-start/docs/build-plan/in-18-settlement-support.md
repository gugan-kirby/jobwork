# IN-18 — Supplier settlement, returns, warranty, disputes (Phase 2 close)

Scope source: [Implementation plan](../24-implementation-plan.md) §5; `FR-805`–`FR-806`, `FR-906`; `BR-FIN-03/04/07`; doc 10 §§5, 15; doc 06 §15 case machine.
Edge cases owned (doc 19 §7/§8): supplier bill exceeds PO/receipt; chargeback after supplier settled; customer paid but supplier fails; return-to-supplier rework leg; refund with tax correction.
Use cases: UC-31, UC-34; pilot scenarios 11–12 completion.

## F-18.1 Supplier bills and settlement

| File | Action | Contents |
|---|---|---|
| `database/migrations/0017_settlement_support.sql` | new | `supplier_bill`, `settlement` (eligibility snapshot, holds), `credit_note`, `case`/`case_participant`/`case_event`/`dispute`/`warranty_claim`/`resolution_action`, `return_authorization` |
| `apps/api/src/modules/finance/application/{record-supplier-bill,match-bill,approve-match-exception,release-settlement}.command.ts` | new | Three-way match PO/receipt(stock lots)/bill with tolerance policy (`BR-FIN-07`); eligibility per doc 10 §5 (quality release, no dispute/recovery hold); settlement journals separate from customer money (`BR-FIN-03/04`) |
| `apps/portal-web/app/(supplier)/bills-settlements/*` + ops match screens | new | Bill submission, match status, settlement eligibility explanation (doc 14 §5) |

Tests: bill > PO/receipt → exception approval not silent adjustment (edge); customer chargeback never auto-reverses supplier settlement — separate recovery record (edge); maker-checker on match exceptions.

## F-18.2 Support cases, warranty, returns

Covers: doc 06 §15 machine; `FR-906`.

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/support/application/{open-case,triage-case,propose-resolution,approve-resolution,execute-resolution,close-case}.command.ts` | new | Case links delivered lot/baseline/inspections/shipments/work package; resolution actions dispatch to owning modules (return authorization → logistics leg, rework → IN-15 flow, credit/refund → finance with approvals, supplier recovery → settlement hold) |
| `apps/api/src/modules/logistics/application/authorize-return.command.ts` | new | Return/rework custody legs on the stock ledger |
| `apps/portal-web/app/(customer)/support/*` + ops case center | new | Case timeline, evidence, decision cards |

Tests: case close blocked while any resolution unverified (doc 06 §15); refund journal + credit-note linkage preserves originals (edge); customer-paid-supplier-failed path → re-source/refund decision recorded (edge); physical/financial/quality closures independent but linked (doc 10 §15).

## F-18.3 Margin realization report

Covers: doc 05 §8 cost-object dimension pay-off; doc 01 §7 success measure.

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/finance/presentation/job-margin.query.ts` | new | Approved cost sheet vs actual job-attributed postings (freight, rework, scrap, warranty) per sales order |
| `apps/operations-web/app/(shell)/finance/margin/*` | new | Variance table, internal-only |

## Increment exit

- [ ] Pilot scenarios 11 (delivery exception → warranty/return/refund) and 12 (suspension + cross-party attempts) green — full doc 19 §10 set now passing.
- [ ] Phase 2 exit per doc 15 §5: complete enquiry-to-acceptance path incl. change + NCR drill, restore drill, security assessment rerun.
