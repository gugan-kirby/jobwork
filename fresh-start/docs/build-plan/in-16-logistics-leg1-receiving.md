# IN-16 — Logistics leg 1 and JobWork receiving (Phase 2)

Scope source: [Implementation plan](../24-implementation-plan.md) §5; `FR-901`–`FR-903`; `BR-LOG-01/02/04/05`; doc 06 §11; doc 10 §§10–13; doc 05 §17 custody ledger.
Edge cases owned (doc 19 §8): short/damaged at receiving; carrier delivered ≠ received; partial/multi-package allocation; (doc 19 §5) partial completion/yield loss reconciliation.
Use cases: UC-20, UC-32; pilot scenario 10.

## F-16.1 Shipment migrations and domain

| File | Action | Contents |
|---|---|---|
| `database/migrations/0016_logistics.sql` | new | `shipment` (leg typed, origin/destination snapshots, disclosure class), `shipment_package` (dims/weights), `shipment_item` (package↔lot/quantity mapping), `carrier_event` (normalized + raw provider status separate), `receiving_record`, `receiving_discrepancy`, `proof_of_delivery` |
| `apps/api/src/modules/logistics/domain/shipment.ts` | new | Doc 06 §11 leg machine; supplier-dispatch guard set (doc 10 §12 leg-1 list) |

## F-16.2 Supplier dispatch (leg 1)

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/logistics/application/{plan-shipment,release-shipment,record-pickup,record-carrier-event}.command.ts` | new | Release checks quality/evidence/documents/quantity vs released stock (`BR-LOG-02` via ledger); carrier port behind `T-05` adapter (dev: manual reference + simulated events) |
| `apps/portal-web/app/(supplier)/shipments/*` | new | Packing (package→item/lot mapping), documents checklist, release + tracking |

Tests: over-shipment vs released quantity blocked; address/carrier snapshot immutable after release (edge: later profile edits don't rewrite).

## F-16.3 JobWork receiving

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/logistics/application/{receive-shipment,report-discrepancy,resolve-discrepancy}.command.ts` | new | Structured custody event (doc 10 §13): condition/photos/count/identity; accept/partial/quarantine/reject; creates `stock_lot`s + movements (doc 05 §17); discrepancy opens hold + case links (IN-18), never silently adjusts ordered quantity (`BR-LOG-04`) |
| `apps/operations-web/app/(shell)/receiving/*` | new | Receiving workstation: package checklist, photo capture, lot creation, discrepancy flow |

Tests: carrier "delivered" event alone changes nothing business-true (edge); shortage → hold + conservation intact (received ≠ ordered visible as exception); quantity ledger invariant holds across partial receipts (property test).

## Increment exit

- [ ] Pilot scenario 10 (short/damaged supplier shipment → receiving hold) green.
- [ ] Stock ledger live: every received quantity traceable lot→movement→location; conservation property suite green.
