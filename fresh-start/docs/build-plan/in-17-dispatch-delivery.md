# IN-17 — Customer dispatch, delivery, acceptance (Phase 2)

Scope source: [Implementation plan](../24-implementation-plan.md) §5; `FR-904`–`FR-905`; `BR-LOG-03/05`; doc 10 §12 leg-2 gates; doc 06 §11.
Edge cases owned (doc 19 §8): address change after dispatch; e-waybill/document mismatch blocks; customer refuses delivery; delivered-but-hidden-defect (warranty rights preserved → IN-18).
Use cases: UC-09, UC-33; pilot scenario 11 start.

## F-17.1 Dispatch gate and identity neutralization

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/logistics/domain/dispatch-gate.ts` | new | Computed leg-2 gate (doc 10 §12): receiving accepted + discrepancies resolved, quality release valid for shipped lots (IN-15 facts), sell-side payment/credit release (IN-08 facts), neutral packaging check, address confirmation, statutory documents present, no dispute/compliance hold |
| `apps/api/src/modules/logistics/application/dispatch-to-customer.command.ts` | new | Transactional gate + lot movements; label/POD templates render from customer-safe projection (no supplier identity — `R-08` control) |
| `apps/operations-web/app/(shell)/dispatch/*` | new | GateMatrix per shipment, document checklist (invoice/challan/e-waybill refs per `T-04`/`D-01` config), override only via doc 03 §4 dispatch-override approvals per hold type |

Tests: each gate red blocks (combinatorial); label/POD snapshot leak suite; document mismatch blocks release (edge); override requires the hold-owning role's approval, no global bypass.

## F-17.2 Delivery, POD, customer acceptance

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/logistics/application/{record-delivery,record-pod,accept-delivery,report-delivery-issue}.command.ts` | new | POD ≠ acceptance (`BR-LOG-05`); acceptance window policy (`FR-905`); issue report opens case (IN-18) with evidence upload |
| `apps/portal-web/app/(customer)/orders/[id]/delivery/*` | new | Accept or report-issue flow with evidence capture; acceptance preserves warranty rights wording (edge) |

Tests: carrier delivered + no POD → investigation state; refusal → exception custody path (edge); address change after dispatch → carrier exception, original snapshot intact (edge).

## F-17.3 Customer timeline and documents completion

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/orders/presentation/customer-timeline.projection.ts` | edit | Rows 7–10 of doc 06 §13 (final checks, on the way, delivery confirmation) |
| `apps/portal-web/app/(customer)/orders/[id]/documents/*` | edit | Released inspection reports/certs pre-dispatch (Fictiv-validated pattern), invoices, POD |

## Increment exit

- [ ] Full two-leg physical chain demo with all gates computed from real facts.
- [ ] Supplier identity absent from every customer-facing logistics artifact (labels, POD, tracking text) — snapshot suite green.
