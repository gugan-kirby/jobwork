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

**Deviations (2026-10-05, F-16.1):**

- **Where the JobWork hub lives.** Migrations do not create JobWork's internal organization (the seed and the test fixtures do), so the hub's address cannot be seeded with it. The ledger's JobWork locations are seeded as codes (`JW-RECEIVING`, `JW-QUARANTINE`, `JW-STOCK`). The hub address for a shipment's destination snapshot is the internal organization's active works site; the dev seed and the pilot driver create one (F-16.2).
- **The ledger has no exit.** Only a receipt enters from outside, and nothing leaves: dispatched, scrapped, returned, out-for-rework and issued quantities move to sink locations instead. So "received = on hand + dispatched + scrapped + returned + in rework" holds by construction, and the property suite checks it against a model.
- **Receiving lines name refusals.** A line splits every counted piece into accepted, quarantined and refused. Refused pieces never enter custody, and their return is IN-18's.

**Verification (2026-10-05, F-16.1).** `logistics.db.spec.ts` (5) covers:

- the leg machine, with addresses, documents, contents and carrier frozen at release and pickup;
- carrier events once each and immutable;
- receiving records immutable and lines splitting every counted piece;
- discrepancies resolved once with a note;
- over-receipt and over-draw refused at the constraint;
- a fast-check property, over 25 random movement sequences, that the database accepts exactly the draws a model allows and conserves every received quantity.

Database suite 96 green; the template pin moved to 31.

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

**Deviations (2026-10-05, F-16.2):**

- **`replan` added.** A planned or submitted shipment's packages, pickup site and documents are replaced whole (`expectedVersion`); a submitted one drops back to `planned`. Once released, the contents are frozen.
- **Guard grouping.** The doc 10 §12 list is six guards, each with its reasons: eligibility, quantity, holds (NCR lots, interim stop, supplier status), packing, documents, addresses. The carrier is not a release guard: a named carrier with its tracking or LR number is required at `recordPickup` for `carrier` and `courier` modes, because the carrier is often booked after release.
- **Consignment value for the e-way bill.** It is the shipped quantity at the purchase order's average unit price (PO total ÷ ordered quantity), which is what the supplier invoices JobWork.
- **Release facts are read inside the transaction.** `QualityReleaseCommand.factsFor(workPackageId, tx)` gives logistics the same facts as the quality release screen, and release locks the work package row so two releases cannot both take the last released pieces. An NCR stops holding its lots when it is `accepted_under_deviation` with an active deviation, as in IN-15.
- **Carrier feed.** `POST /webhooks/carriers/:provider` is public, rate-limited, HMAC-signed over `timestamp.body` and idempotent by the provider's event id. It runs as the service principal `carrier-feed`. Unmapped codes are acknowledged and ignored. Logistics can also record an event by hand. A carrier `picked_up` on a released shipment counts as the pickup.
- **Order status.** The first pickup moves the sales order from `ready_supplier_dispatch` to `in_supplier_to_jobwork_transit`. Earlier statuses are left alone, since another work package may still be in production.
- **Readers.** Supplier shipments are visible to the shipper's production, quality, estimator and admin roles. Internally, logistics, quality, sourcing, engineering, sales and platform admin can read them. Only `jobwork_logistics` releases shipments and records carrier events.

**Verification (2026-10-05, F-16.2).** `dispatch.api.spec.ts` (7) covers:

- over-shipment, an unreleased lot and missing documents each turn their guard red, and submit is refused;
- release by logistics only, with the snapshots unchanged after the supplier's site is edited, and the supplier notified;
- pickup requiring a named carrier and reference, and the order moving into transit;
- the carrier webhook: a bad signature gets 401, a repeat is a duplicate and an unmapped code is ignored, while "delivered" moves the leg to `delivered_to_destination` with no receiving record and no stock;
- the earlier shipment counted against the release, and a lot held by an NCR;
- the same lot shipping once a customer-approved deviation accepts the NCR;
- isolation for the other supplier and the customer.

The dev seed creates the hub site and the pilot driver gains the hub, the supplier works sites and a `logistics` actor. The audit inventory gains eight operations. Production now refuses the default `CARRIER_WEBHOOK_SECRET`. Full verify green: api 435, database 96, ui 170, worker 39, web-kit 22, portal-web 21.

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

**Deviations (2026-10-05, F-16.3):**

- **One receipt per shipment.** `receiving_record` is unique per shipment, so a shipment is counted once. "Partial" means part of the order: further pieces arrive on another shipment.
- **The count is complete and split.**
  - Every shipped item gets one line, and every package one condition.
  - Each line splits the counted pieces into accepted, quarantined and refused.
  - Nothing beyond the shipped quantity goes to stock; extra pieces are quarantined or refused until the overage is resolved.
  - A damaged line must set its damaged pieces aside, and may accept the sound ones.
  - A line whose identity is in doubt accepts nothing.
  - Photos must be JobWork's own clean files.
- **Discrepancies are derived, not typed in.**

  | Discrepancy | Raised when | Quantity |
  |---|---|---|
  | Shortage | counted < shipped | shipped − counted |
  | Overage | counted > shipped | counted − shipped |
  | Damage | a line is damaged | quarantined + refused |
  | Identity | the marking or lot does not match | counted |
  | Wrong item | not the ordered part | counted |
  | Document mismatch | the box's challan or invoice differs | — |

  Package condition and seal state are recorded as evidence and raise nothing by themselves.
- **Ledger entry.** Each lot that entered custody becomes one `stock_lot` (keyed by shipment and lot code, carrying the order's released production baseline). It is entered by `receive` movements straight into `JW-STOCK` and `JW-QUARANTINE`; the receiving dock location is not used for leg 1. Refused pieces never enter the ledger.
- **Resolution matrix.**

  | Discrepancy | Allowed resolutions |
  |---|---|
  | Shortage | accept, replacement expected |
  | Overage | overage accepted, return to supplier |
  | Damage | scrapped, released to stock, return to supplier |
  | Wrong item | return to supplier, scrapped |
  | Identity | released to stock, return to supplier, scrapped |
  | Document mismatch | document corrected |

  - Quality decides scrap, release to stock and overage acceptance. Logistics decides the rest.
  - A movement out of quarantine moves the lesser of the discrepancy quantity and what quarantine holds of the lot.
  - Scrap, release to stock and overage acceptance need something in quarantine.
  - A return with nothing in quarantine covers refused pieces and moves nothing; the return leg is IN-18's.
- **Order received at JobWork.** The order becomes `received_jobwork` when every work package's accepted quantity (everything that ever entered `JW-STOCK`) reaches its ordered quantity and no other inbound shipment of the order is in `receiving_check` or `discrepancy_hold`. A released-but-short order stays in transit, and its shortfall shows as `outstanding`.
- **Hand-off to IN-18: replacement capacity.** Quality release is capped at ordered less released (IN-15). Replacement pieces for an accepted shortage or a scrap therefore cannot be released until the cap counts what never arrived. Returns, replacements and that cap change are IN-18's.
- **Pilot driver helpers.** `inspection`, `calibratedGauge`, `releasedLots` and `shippedToJobWork` replace the setup the dispatch spec carried; scenario 10 reuses them.

**Verification (2026-10-05, F-16.3).** `receiving.api.spec.ts` (6) covers:

- receipt by logistics only, with each refusal: an incomplete count, a split that does not add up, acceptance beyond shipped, an unsound acceptance, an unsplit damage, and a photo JobWork does not own;
- a clean two-package receipt into stock, and a second receipt refused;
- shortage and damage holding the shipment, while the PO and shipment quantities stay unchanged and `outstanding` shows 6;
- the supplier notified of each discrepancy, seeing counts but no split and no stock; the other supplier and the customer refused;
- the resolution roles and matrix, each resolution made once, and the scrap reaching `OUT-SCRAPPED`;
- conservation per lot, with the refused piece absent and receiving lines immutable;
- a second order reaching `received_jobwork` after a document correction and a quality release from quarantine.

The audit inventory gains two operations and the worker acknowledges four events. Full verify green: api 441, database 96, ui 170, worker 39.

## F-16.4 UX

| File | Action | Contents |
|---|---|---|
| `apps/portal-web/app/supplier/shipments/*` + PO page panel | new | Plan a shipment (packages, the item and lot mapping from released lots), a documents checklist, guards shown before submit, pickup and tracking, and discrepancies against the supplier's shipments |
| `apps/operations-web/app/logistics/*` | new | Shipments to release (guards from `GateMatrix`); the receiving workstation (package checklist, counts per item, photo upload, decision, discrepancy flow); discrepancy board; per-work-package quantity reconciliation |
| `apps/operations-web/app/sales-orders/[id]` | edit | Both legs on the order |

Browser walk at desktop width and at 390 px; receiving is the mobile-first screen (doc 14 §12).

**Deviations (2026-10-05, F-16.4):**

- **`GET /supplier/shipments/shippable?purchaseOrderId=`.** The supplier cannot read quality releases. The planner shows the quantity guard ahead of time instead: per released lot, released, shipped on live shipments, available, and the open NCRs holding it.
- **Portal.**
  - `/supplier/shipments` lists the supplier's shipments.
  - `/supplier/shipments/new?purchaseOrderId=` plans one. The editor offers released lots and the supplier's works or pickup sites, plus documents and packages with dimensions and weight.
  - `/supplier/shipments/[id]` shows the guards (`GateMatrix`) and offers submit, edit (replan), cancel and pickup (carrier, tracking or LR). It also shows contents with JobWork's count, carrier updates and discrepancies.
  - The PO page has a shipments panel, and the supplier navigation gains "Shipments".
- **Operations.**
  - `/logistics` groups shipments: to release, coming in, discrepancy hold, being prepared, received.
  - `/logistics/shipments/[id]` covers:
    - release with the guard matrix;
    - pickup on the supplier's behalf;
    - manual carrier updates in IST;
    - the receiving workstation;
    - discrepancy resolution, offering only the matrix's choices and marking quality's.
  - The receiving workstation:
    - takes a seal check, a documents check and each package's condition (a missing package zeroes its counts);
    - splits each item's count, defaulting to all accepted until split by hand;
    - records identity and damage;
    - uploads photos through the normal scan pipeline;
    - previews the discrepancies the receipt will open.
  - `/logistics/work-packages/[id]` reconciles quantities and stock.
  - The order page gains a shipments card grouped by leg, and the navigation gains "Logistics" with the three queues as its badge.
- **Found and fixed in the walk (UI kit).**
  - **Navigation highlight.** Navigation and the tab bar lit every item whose href prefixed the path, so the supplier's "Home" (`/supplier`) stayed lit on every supplier page. `activeHref` now lights only the most specific match.
  - **`FileUpload` at phone width.** The control was wider than a 390 px card, because the native file input and the header row could not shrink. They now wrap and shrink.
- **Dev data.** The dev seed has the hub. The walk's logistics user (`logistics@jobwork.local`, the demo-chain password and TOTP) and LOT-7's release were scripted; they are not in the seed.

**Verification (2026-10-05, F-16.4).** Browser walk on the dev stack (PO-2026-0001, LOT-7 released 30 of 60):

- **Supplier, desktop.** Planned SH-2026-0001 as two packages of 15 with the documents guard red, edited in the challan, all guards green, submitted.
- **Logistics, desktop.** The board showed it to release. Released it, freezing the addresses. Recorded the pickup (VRL Logistics, LR-88213) and a carrier "delivered", which shows a not-a-receipt callout.
- **Receiving at 390 px:**
  - package 2 damaged, one count short;
  - 12 accepted, 2 quarantined and 1 refused on the damaged line;
  - one photo uploaded and scanned;
  - preview, then RD-2026-0001 (shortage 1) and RD-2026-0002 (damage 3) opened, on hold.
- **Resolution.** Logistics accepted the shortage. Logistics was refused the scrap ("Requires jobwork_quality"). Quality scrapped it, and the shipment was received.
- **Reconciliation.** Ordered 60, released 30, shipped 30, counted 29, accepted 26, scrapped 2, outstanding 34. Lot LOT-7: 28 received, 26 in stock and 2 scrapped.
- **The supplier at 390 px.** Counts per package and both discrepancies with their resolutions; no split and no stock.

`dispatch.api.spec.ts` gains the shippable read (released, shipped, available, the NCR hold, and isolation), and the UI kit gains an `activeHref` test. Full verify green: api 441, ui 171, portal-web 21, worker 39, database 96.

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
