# IN-16 — Logistics leg 1 and JobWork receiving (Phase 2)

Scope source: [Implementation plan](../24-implementation-plan.md) §5; `FR-901`–`FR-903` (and the leg-1 parts of `FR-904`, `FR-906`); `BR-LOG-01`, `BR-LOG-02`, `BR-LOG-04` (the receiving half of `BR-LOG-05`; POD is IN-17); doc 06 §11; doc 10 §§10–15; doc 05 §17 custody ledger; `D-15` (customer-supplied material).
Edge cases owned (doc 19 §8): short or damaged at receiving; the carrier says delivered but the site did not receive; partial or multi-package delivery; e-waybill/challan mismatch. From doc 19 §5: partial completion and yield loss, reconciled.
Use cases: UC-20, UC-32. Pilot scenario 10 (doc 19 §10).

**Refresh (2026-10-05, before build).** Written at inception. IN-15 has since built quality release with a reproducible snapshot and `releaseFacts`, which this increment's dispatch guard consumes. The refresh reads that code, the order and site models, and the spec. Changes, each with its reason:

| Original | Now | Why |
|---|---|---|
| `0016_logistics.sql` | `0025_logistics.sql`, schema `logistics` | 0016 is taken; 0024 is the latest |
| Shipment tables only | Plus `custody_location`, `stock_lot`, an append-only `stock_movement`, and a database check that no movement draws more than a location holds | Doc 05 §17 puts the ledger in `logistics`; "fails at the constraint, not at an operator's attention" (`BR-LOG-02`) |
| Release checks "quality … vs released stock" | Leg-1 release reads IN-15's release facts: released lots and quantities, open NCRs on those lots, active deviations. Shipped lots and quantity must lie within what quality released, less what earlier shipments took | Stock lots are created at JobWork receiving (doc 05 §17). Before that, the release is the authority on what may move |
| Carrier behind a `T-05` adapter | A `CarrierPort` with two adapters: manual (logistics records events) and a signed dev webhook (`POST /webhooks/carriers/dev`, the payment-webhook pattern). The aggregator is chosen at `T-05` | `T-05` is open; the port keeps the choice out of the domain |
| Supplier portal "shipments" under `(supplier)` | `apps/portal-web/app/supplier/shipments/*`, plus the PO page | Matches the routes as built |
| Three functionalities | Six: schema and ledger; leg-1 dispatch; receiving; UX; customer-supplied material (`D-15`); pilot scenario 10 | `D-15` (resolved) says customer material custody and challans arrive with IN-16 |
| Order status untouched | The first leg-1 pickup on an order sets `in_supplier_to_jobwork_transit`. Every work package's released quantity received and accepted sets `received_jobwork`. Order-level `quality_hold` / `quality_released` stay unused: the dispatch guard reads release facts, not an order flag | Doc 06 §7's order machine; IN-15's decision that the hold belongs to dispatch |
| Release facts readable by quality's readers | `jobwork_logistics` joins the internal readers of release facts | Logistics releases leg 1 against them |

**Out of scope (named so nothing is silently dropped):**

- Leg 2 to the customer, POD and the delivery confirmation (IN-17).
- Return-to-supplier legs and carrier claims (IN-18). A receiving discrepancy records the claim reference and opens the case link IN-18 completes.
- Direct ship (`D-13`, exception only).

## F-16.1 Schema and custody ledger

| File | Action | Contents |
|---|---|---|
| `database/migrations/0025_logistics.sql` | new | The tables, ledger, seeds and platform rows described below |
| `database/tests/logistics.db.spec.ts` | new | The leg machine, immutable snapshots and events, the ledger refusing over-draws, and the conservation invariant over random movement sequences (fast-check) |

What `0025_logistics.sql` creates:

- **`shipment`** (number `SH-YYYY-NNNN`):
  - leg (`supplier_to_jobwork`, `jobwork_to_customer`, `customer_to_jobwork`, `jobwork_to_supplier`);
  - work package, purchase order, sales order;
  - origin and destination snapshots (immutable once released, doc 10 §11) and disclosure class;
  - carrier mode (carrier, supplier vehicle, courier) and tracking reference;
  - documents (challan, invoice, e-waybill references);
  - status, with transitions enforced by trigger (doc 06 §11 plus `cancelled` before release);
  - release snapshot (guards and evidence), released by and at.
- **`shipment_package`**: dimensions in mm and weight in g.
- **`shipment_item`**: package, lot, serials, quantity, unit.
- **`carrier_event`**: append-only; provider, unique provider event id, raw status kept separate from normalized status, occurred at.
- **Receiving and discrepancies.**
  - `receiving_record`: immutable; receiver, time, site; seal and package conditions; photos as document versions; decision accept, partial, quarantine or reject.
  - `receiving_line`: per item, shipped, counted, accepted, quarantined and rejected quantities, with identity and damage.
  - `receiving_discrepancy`: kind (shortage, overage, damage, wrong item, document mismatch, identity), lot, quantity; status open or resolved; resolution and case reference.
- **Custody ledger.**
  - `custody_location`: kind, organization site, shipment for carrier custody.
  - `stock_lot`: lot code, serials, work package, order, baseline, source shipment, received quantity, unit, ownership (JobWork, or customer material).
  - `stock_movement`: append-only; lot, from, to, quantity, type (receive, quarantine, release, pick, dispatch, return, scrap, rework_out, rework_in, adjust), authorizing command, evidence. A trigger refuses any draw beyond the from-location's balance.
  - `stock_balance` view.
- **Seeds.** JobWork's receiving hub as an `iam.organization_site` of the internal organization, with its receiving, quarantine and stock locations.
- **Platform.**
  - Queues `shipments_to_release` and `shipments_awaiting_receiving` (released or carrier-delivered, not yet received), and `receiving_discrepancies_open`.
  - Templates `supplier.shipment_released` and `supplier.receiving_discrepancy`.

## F-16.2 Supplier dispatch (leg 1)

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/logistics/domain/shipment.ts` | new | The leg machine; `legOneGuards(facts)` per doc 10 §12 (below) |
| `apps/api/src/modules/logistics/application/dispatch.command.ts` | new | Commands below; quantities checked inside the transaction |
| `apps/api/src/modules/logistics/infrastructure/carrier.port.ts` | new | `CarrierPort`; manual and dev-webhook adapters; normalized status mapping |
| `apps/api/src/modules/orders` | edit | Order status on first pickup |
| `apps/api/test/dispatch.api.spec.ts` | new | Tests below |

The guards in `legOneGuards` (doc 10 §12), each with reasons:

- the purchase order is acknowledged and the work package released;
- shipped lots and quantities lie within quality releases, less earlier shipments;
- no open NCR on a shipped lot;
- no interim stop or open change on the purchase order;
- the supplier is active;
- every package carries items;
- a challan or invoice reference, and an e-waybill reference when the consignment value exceeds ₹50,000;
- the pickup site is the supplier's active works or pickup site, and the carrier is named with its reference.

The commands in `dispatch.command.ts`:

- `plan` (supplier: packages and items) → `planned`;
- `submit` (guards green) → `ready_for_release`;
- `release` (jobwork_logistics: guards re-run, address snapshots frozen) → `released`;
- `recordPickup` (supplier or logistics) → `picked_up`;
- `recordCarrierEvent` (normalized; `delivered` moves to `delivered_to_destination` and nothing else);
- `cancel` (before release).

What `dispatch.api.spec.ts` covers:

- over-shipment beyond released quantity refused;
- a lot under an open NCR refused, while a lot under an active deviation ships;
- address snapshots unchanged after the supplier edits its site;
- a duplicate carrier event ignored;
- a carrier "delivered" event leaves receiving and stock untouched;
- the other supplier and the customer see nothing.

## F-16.3 JobWork receiving

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/logistics/application/receiving.command.ts` | new | `receive` and `resolveDiscrepancy`, described below |
| `apps/api/src/modules/logistics/application/logistics-view.ts` | new | Per work package: ordered, released, shipped, received, accepted, quarantined, scrapped and outstanding quantities (doc 19 §8 "remaining commitment visible"); stock lots with balances by location |
| `apps/api/test/receiving.api.spec.ts` | new | Tests below |

What the receiving commands do:

- **`receive`** (jobwork_logistics; doc 10 §13; `BR-LOG-04`):
  - records, per package, condition and seal, and per item, count, identity and damage, with photos;
  - creates stock lots for what arrived, with movements receive → stock for accepted and receive → quarantine for damaged or suspect;
  - any shortage, overage, damage, wrong item or identity issue opens a discrepancy and puts the shipment on `discrepancy_hold`;
  - ordered and shipped quantities never change.
- **`resolveDiscrepancy`** (logistics; jobwork_quality for quarantined goods):
  - accept the shortage, with the remaining commitment staying open;
  - expect a replacement shipment;
  - scrap from quarantine;
  - release quarantine to stock after inspection;
  - return to supplier (the record only; the leg is IN-18).
- **Acceptance.** The shipment is `accepted` once no discrepancy is open; the order becomes `received_jobwork` when every work package's released quantity is received and accepted.

What `receiving.api.spec.ts` covers:

- a partial, multi-package shipment received as counted;
- a shortage holds the shipment, keeps ordered and shipped untouched, and shows the outstanding quantity;
- a damaged package goes to quarantine, then to scrap;
- the conservation invariant holds across partial receipts;
- a receipt cannot exceed what is in custody;
- the supplier sees its discrepancy, but not JobWork's stock.

## F-16.4 UX

| File | Action | Contents |
|---|---|---|
| `apps/portal-web/app/supplier/shipments/*` + PO page panel | new | Plan a shipment (packages, the item and lot mapping from released lots), a documents checklist, guards shown before submit, pickup and tracking, and discrepancies against the supplier's shipments |
| `apps/operations-web/app/logistics/*` | new | Shipments to release (guards from `GateMatrix`); the receiving workstation (package checklist, counts per item, photo upload, decision, discrepancy flow); discrepancy board; per-work-package quantity reconciliation |
| `apps/operations-web/app/sales-orders/[id]` | edit | Both legs on the order |

Browser walk at desktop width and at 390 px; receiving is the mobile-first screen (doc 14 §12).

## F-16.5 Customer-supplied material (`D-15`)

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/logistics/application/material.command.ts` | new | Material in and out, described below |
| `apps/api/test/customer-material.api.spec.ts` | new | Material received, issued to the supplier, and conserved; no customer identity on the supplier's challan view |

The material flow:

- JobWork receives material the customer supplies (`customer_to_jobwork`) onto lots owned by the customer, with the customer's challan reference.
- It issues the material to the supplier on a `jobwork_to_supplier` leg with JobWork's own challan.
- The same receiving and ledger rules apply, and conservation holds per lot.

## F-16.6 Pilot scenario 10

| File | Action | Contents |
|---|---|---|
| `apps/api/test/pilot/scenario-10-partial-damaged-receipt.api.spec.ts` | new | Scenario 10, described below |
| `docs/build-plan/uat-checklist.md` | edit | Scenario 10 steps per role |

Scenario 10:

1. Two released lots ship in three packages. The carrier event says delivered.
2. Receiving finds one package short by five and one damaged: hold, quarantine, discrepancies, and the supplier is told.
3. The damage is scrapped, and the shortage resolved by a replacement shipment received in full.
4. The order reaches `received_jobwork`, and quantities reconcile: received = on hand + scrapped.

## Decisions taken on the owner's behalf

Taken as safe defaults so the build can proceed; each is reversible and recorded here for review.

| Decision | Default | Why it is safe |
|---|---|---|
| Who dispatches for the supplier | `supplier_production` and `org_admin` | Doc 03 has no supplier logistics role; production already owns the work package |
| Who releases leg 1 and receives | `jobwork_logistics`; quarantine release or scrap needs `jobwork_quality` | Doc 03: logistics owns shipment and receiving; quality owns what is fit to use |
| Carrier (`T-05`) | Manual events plus a signed dev webhook behind `CarrierPort`; no aggregator | `T-05` is open; no real provider in the build (overnight guardrail) |
| Statutory documents | A challan or invoice reference always; an e-waybill reference when the consignment value exceeds ₹50,000 (CGST Rule 138), valued at the PO unit price | Errs towards requiring the document. Legal/tax review is an open owner item from IN-12 |
| JobWork receiving hub | One seeded site (Chennai) with receiving, quarantine and stock locations | Chennai first (doc 00); more sites are reference data (`D-21`) |
| Lots before receiving | A shipment item's lot is the lot text quality released; JobWork creates the `stock_lot` at receiving | Doc 05 §17: lots are created at JobWork receiving |
| Order status | `in_supplier_to_jobwork_transit` at the first leg-1 pickup; `received_jobwork` when everything released is received and accepted | Doc 06 §7; projections already map both to "final checks" |

## Increment exit

- [ ] Pilot scenario 10 (short and damaged supplier shipment → receiving hold → resolution) green.
- [ ] Stock ledger live: every received quantity traceable lot → movement → location; the conservation property suite is green and the database refuses an over-draw.
- [ ] No carrier event, on its own, makes anything received or accepted.
