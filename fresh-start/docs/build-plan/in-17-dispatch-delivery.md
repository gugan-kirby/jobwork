# IN-17 — Customer dispatch, delivery, acceptance (Phase 2)

Scope source: [Implementation plan](../24-implementation-plan.md) §5; `FR-902` (POD), `FR-904`, `FR-905`; `BR-LOG-01`, `BR-LOG-03`, `BR-LOG-05`; doc 06 §§7, 11, 13; doc 10 §§11–12, 14; doc 03 §4 (dispatch override); `R-08` (label/POD template tests).
Edge cases owned (doc 19 §8): address change after dispatch; e-waybill/invoice/challan mismatch blocks release; customer refuses delivery; carrier says delivered but the site did not receive (customer side); delivered-but-hidden-defect (warranty rights preserved → IN-18).
Use cases: UC-09, UC-33. Pilot scenario 11 start (doc 19 §10); its warranty, return-authorization and refund half is IN-18's.

**Refresh (2026-10-05, before build).** Written at inception. IN-16 has since built the shipment aggregate for every leg, the leg machine trigger, carrier events behind `CarrierPort`, JobWork receiving and the custody ledger (`stock_lot`, append-only `stock_movement`, `guard_movement`, sinks such as `OUT-DISPATCHED`). IN-15 exposes release facts per work package; IN-08 built instalments with a `before_dispatch` balance trigger, credit profiles and holds; IN-13 built interim stops; IN-10 built the leakage registry; the approval rail takes effects through `ApprovalEffectRegistry`. The refresh reads that code and the spec. Changes, each with its reason:

| Original | Now | Why |
|---|---|---|
| `dispatch-to-customer.command.ts` | `CustomerDispatchCommand` (`customer-dispatch.command.ts`) for leg 2, beside IN-16's `DispatchCommand` | Leg 2 is planned and released by JobWork from its own stock; leg 1 is planned by the supplier against quality releases. The guards and the actors differ (doc 06 §11) |
| No migration named | `0026_customer_dispatch.sql` | 0025 is the latest |
| Gate "receiving accepted … quality release valid for shipped lots" | Leg 2 picks **stock lots** in `JW-STOCK`. The gate reads the ledger, the lot's source receipt, and IN-15's release facts for the lot's work package | Stock lots are what JobWork holds (doc 05 §17); release facts are per work package |
| Lot codes on customer artifacts | Every leg-2 item carries JobWork's own lot marking (`JW-` + 8 hex characters of the stock lot id); the supplier's lot code stays internal, mapped by `stock_lot_id` | Neutral by construction, not by detection (`R-08`). A supplier's lot code may carry its name. The marking still traces to the lot, baseline and work package (UC-09 "exact lot") |
| "Neutral packaging check" | A packing check recorded with the plan (neutral cartons, supplier marks removed, JobWork labels applied, the customer's packaging note followed) plus an automated scan of every customer-visible string of the shipment against the IN-10 leakage registry | Doc 10 §12 "no unintended supplier identity" needs a fact the gate can compute, not only a tick box |
| Sell-side payment release | Instalments due before dispatch (advance, change, and a balance on `on_acceptance` or `before_dispatch`) paid, or approved credit covering what is open; no credit hold. A pending `before_dispatch` balance is invoiced when the first leg-2 shipment is planned | Doc 10 §4: an instalment becomes an invoice when its trigger is met; IN-08 left the balance for IN-17 ("in the full flow the balance falls due at the dispatch gate") |
| Statutory documents per `T-04`/`D-01` config | The tax invoice reference must be an issued, non-void JobWork invoice of this order; an e-way bill (12 digits) is required above ₹50,000 of consignment value at the order's average sell price | Doc 10 §8: the gate verifies presence and consistency and does not invent applicability. Mirrors IN-16's leg-1 default |
| Address confirmation "under policy" | Every leg-2 dispatch needs a confirmation of the destination site and receiving contact, by the customer in the portal or recorded by JobWork sales or logistics with a note. A confirmation binds to the site's snapshot hash; an edit afterwards makes it stale | Doc 10 §12; the policy default is recorded below |
| Override "per hold type" | Approval kind `dispatch_override`. Overridable guards and their owners: quality → `jobwork_quality`, payment → `jobwork_finance`, delivery terms (partial delivery) → `jobwork_sales`, change holds → `jobwork_engineering`. An approved override covers exactly the reasons it was approved for; a new reason turns the guard red again | Doc 03 §4: "no global logistics bypass" |
| POD ≠ acceptance | POD (`proof_of_delivery`) moves leg 2 to `receiving_check`, read as "awaiting the customer's acceptance"; only an explicit or deemed acceptance (`delivery_acceptance`) moves it to `accepted` | `BR-LOG-05`; the IN-16 machine is reused, not forked |
| "Acceptance window policy (`FR-905`)" | `acceptance_policy_version` v1: 7 days from POD to the end of that day in IST, then deemed acceptance by a service sweep; reports after acceptance are recorded as warranty claims | `FR-905` asks for explicit windows; a delivery that never closes blocks settlement (IN-18) |
| "Issue report opens case (IN-18)" | A `delivery_exception` record (`DX-YYYY-NNNN`) for address changes, refusals and customer reports; it holds the leg and carries a case reference that IN-18's case aggregate completes | The support case aggregate is IN-18's (doc 06 §15) |
| "Refusal → exception custody path" | A refusal ends the leg in a new terminal status `refused` and creates a linked return leg (`customer_to_jobwork`, `returns_shipment_id`), whose receipt moves the same stock lots back from `OUT-DISPATCHED` | `BR-LOG-01`: the way back is its own movement; the ledger stays one lot per receipt |
| Customer timeline rows 7–10 | `timelineFor` gains real facts: quality released and packed (final checks), dispatched with carrier and tracking (on the way), POD and the acceptance due date (delivery confirmation), accepted or deemed accepted | Doc 06 §13 |
| Customer documents | `/orders/:id/documents`: contract record, invoices, delivery notes, PODs, and a conformity certificate per dispatched shipment (released quantity, final-inspection summary by characteristic, JobWork lot markings; no supplier, instrument or inspector) | The Fictiv pre-ship inspection pattern (README references); doc 03 §3 "quality record: curated/released" |
| Three functionalities | Six: schema; gate and dispatch; delivery, POD and acceptance; customer projection and documents; UX; pilot scenario 11 start | Each is verifiable on its own; the same split as IN-16 |

**Out of scope (named so nothing is silently dropped):**

- Warranty claims' handling, return authorization, replacement, credit and refund, supplier recovery, carrier claims: IN-18. IN-17 records the claim and the case reference.
- Who pays for a redirect, a refused delivery's return freight or storage: IN-18 (case and cost). IN-17 records the carrier's charge note on the exception.
- Supplier bills and settlement eligibility from receipt and acceptance: IN-18.
- Order `closed`: IN-18, when settlement and warranty facts exist.
- Direct ship (`D-13`, exception only), customer pickup at the hub, and multi-hop routes.
- A real carrier aggregator and label printer integration (`T-05`).

## F-17.1 Schema

| File | Action | Contents |
|---|---|---|
| `database/migrations/0026_customer_dispatch.sql` | new | The changes below |
| `database/tests/customer-dispatch.db.spec.ts` | new | Leg-2 transitions including `refused`; packing check and confirmations frozen at release; POD, acceptance and overrides immutable; one POD and one acceptance per shipment; a return leg moving dispatched stock back without a second lot |

What `0026_customer_dispatch.sql` changes:

- **`shipment`**:
  - status `refused` (from `picked_up`, `in_transit`, `delivered_to_destination`; terminal);
  - `discrepancy_hold → receiving_check` (a customer's report withdrawn inside the window) and `delivered_to_destination → discrepancy_hold` (the customer says nothing arrived);
  - `returns_shipment_id` (a return leg's outbound shipment);
  - `packing_check jsonb` (frozen at release like the documents);
  - `acceptance_due_at` (set by the POD).
- **`address_confirmation`**: append-only; shipment, site, snapshot hash, party (customer or JobWork), confirmed by, note.
- **`dispatch_override`**: shipment, guard key, the reasons overridden and their hash, approval request, status (requested, approved, rejected), decided by and at; reasons immutable.
- **`proof_of_delivery`**: one per shipment, immutable: received by (name), received at, delivered-to snapshot, packages received, remarks (`clean` or `with_remarks`) and note, document versions (photos, signed copy), source (carrier, driver, JobWork staff), recorded by.
- **`acceptance_policy_version`**: window in days, deemed acceptance on or off, the warranty statement shown at acceptance, effective from; v1 seeded.
- **`delivery_acceptance`**: one per shipment, immutable: basis (`explicit`, `deemed`), accepted by (null when deemed), at, policy version, the warranty statement as shown.
- **`delivery_exception`** (number `DX-YYYY-NNNN`): shipment; kind (`address_change`, `refused`, `not_received`, `shortage`, `damage`, `wrong_item`, `quality_defect`, `documents`); raised by party; lot marking and quantity; description; evidence document versions; `warranty_claim` (reported after acceptance); requested site snapshot (address change); status open or resolved; resolution and note; case reference; carrier charge note. Resolved once (trigger).
- **Approvals**: kind `dispatch_override` with policy v1 `{"approverRolesByGuard": {"quality": ["jobwork_quality"], "payment": ["jobwork_finance"], "commitment": ["jobwork_sales"], "holds": ["jobwork_engineering"]}}`.
- **Queues** with SLA: `customer_dispatches_to_release` (leg 2 `ready_for_release`), `deliveries_awaiting_pod` (leg 2 picked up or later, no POD), `delivery_exceptions_open`.
- **Templates** (in-app and email): `customer.delivery_address_confirmation`, `customer.delivery_dispatched`, `customer.delivery_confirmation_needed`, `customer.delivery_accepted`, `jobwork.delivery_exception_opened`.

## F-17.2 Dispatch gate and customer dispatch

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/logistics/domain/dispatch-gate.ts` | new | `legTwoGuards(facts)`: the eight guards below, each with its reasons; `OVERRIDABLE` with owners; `applyOverrides`; `customerLotMarking(stockLotId)` |
| `apps/api/src/modules/logistics/application/customer-dispatch.command.ts` | new | Commands below; facts read inside the transaction; the order row locked at release |
| `apps/api/src/modules/logistics/presentation/customer-documents.ts` | new | Shipping label (per package) and delivery note rendered from the customer-safe shipment projection only, with a content hash |
| `apps/api/src/modules/orders/application/dispatch-finance.ts` | new (exported) | `issueDueBeforeDispatch`, `paymentFacts` (instalments due, open amount, credit usable and exposure, holds), `issueDueOnDelivery` — the money side, owned by orders |
| `apps/api/src/modules/communication/application/identity-screen.ts` | new (exported) | `screenForCustomer(customerOrganizationId, texts)`: the leakage registry's findings for a customer audience |
| `apps/api/test/dispatch-gate.spec.ts` | new | Pure guard combinations |
| `apps/api/test/customer-dispatch.api.spec.ts` | new | Tests below |
| `apps/api/test/customer-documents.spec.ts` | new | Label and delivery-note snapshots; the leak suite |

The guards in `legTwoGuards` (doc 10 §12 JobWork-to-customer, `BR-LOG-03`):

| Guard | Red when | Override owner |
|---|---|---|
| `stock` | an item's lot is not this order's made-part stock; more than `JW-STOCK` holds; the lot's source receipt still has an open discrepancy; packages empty or repeated; the order would receive more than it ordered | — |
| `quality` | the lot is not covered by a quality release of its work package; an open NCR holds the lot or the work package; dispatched plus this shipment exceeds what quality released for the lot | `jobwork_quality` |
| `payment` | a credit hold; an instalment due before dispatch is not paid and approved credit does not cover what is open | `jobwork_finance` |
| `commitment` | the customer did not allow partial delivery (enquiry `partial_delivery`) and this shipment does not complete the order | `jobwork_sales` |
| `holds` | an interim stop on one of the order's purchase orders; an open change request on the order | `jobwork_engineering` |
| `identity` | the packing check incomplete; any customer-visible string of the shipment matches a shielded party in the registry | — |
| `address` | the destination is not the customer's active site; no receiving contact name and phone; no confirmation for the current snapshot | — |
| `documents` | no tax invoice reference, or it is not an issued, non-void invoice of this order; above ₹50,000 no e-way bill, or it is not 12 digits | — |

The commands in `customer-dispatch.command.ts` (all `jobwork_logistics` unless named):

- `plan` (sales order, destination site defaulting to the order's delivery site, packages of stock lots, documents, packing check) → `planned`; invoices a pending `before_dispatch` balance; the customer is asked to confirm the address;
- `replan` (before release, `expectedVersion`; a submitted plan drops back to `planned`);
- `confirmAddress` (customer requester, approver or admin) and `recordAddressConfirmation` (`jobwork_sales` or logistics, with a note);
- `submit` (every guard green or overridden) → `ready_for_release`;
- `requestOverride` (guard red and overridable; the reason) → an approval request to the guard's owner; the effect records the decision;
- `release` (guards re-run under the order lock; snapshots, packing check and overrides frozen; `JW-STOCK → OUT-DISPATCHED` per item) → `released`; order `received_jobwork → ready_customer_dispatch`;
- `cancel` before release; pickup and carrier events reuse IN-16's commands (order → `in_customer_transit` at the first leg-2 pickup).

What `customer-dispatch.api.spec.ts` covers:

- each guard red on its own fact, and submit and release refused while any is red (the combinatorial matrix lives in `dispatch-gate.spec.ts`);
- the balance invoiced at planning; paying it, or credit covering it, turns `payment` green; a credit hold keeps it red;
- an invoice of another order, a void invoice and a malformed e-way bill each turn `documents` red; replanning with the right references turns it green (document mismatch blocks release);
- a stale address confirmation after the customer edits the site;
- overrides: only the guard's owner decides; logistics cannot approve its own; `stock`, `identity`, `address` and `documents` refuse an override; an approved override stops covering once a new reason appears;
- release moves stock to `OUT-DISPATCHED` and two releases cannot both take the last pieces;
- the supplier sees nothing of leg 2; the customer sees its own shipment from `planned` with no supplier field.

What `customer-documents.spec.ts` covers (the `R-08` leak suite):

- the label, delivery note and (F-17.3) POD rendered for a shipment whose supplier lot codes, serials and site carry the supplier's name: none of the supplier's names, trade name, contact, city, lot codes, purchase order number or buy price appears in any document or in the customer's shipment JSON;
- snapshots pin each document's content.

## F-17.3 Delivery, POD, acceptance and exceptions

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/logistics/application/delivery.command.ts` | new | Commands below |
| `apps/api/src/modules/logistics/application/receiving.command.ts` | edit | A return leg's receipt moves the original stock lots back from `OUT-DISPATCHED` instead of creating lots |
| `apps/api/src/modules/logistics/presentation/customer-documents.ts` | edit | The POD document |
| `apps/worker/src/main.ts` | edit | `DELIVERY_SWEEP_MS` tick calling the service-only acceptance sweep |
| `apps/api/test/delivery.api.spec.ts` | new | Tests below |

The commands:

- `recordPod` (logistics; from `picked_up`, `in_transit` or `delivered_to_destination`) → `receiving_check`; the acceptance window opens; `on_delivery` and `net_30` balances are invoiced; the order becomes `delivered` once everything ordered has a POD;
- `acceptDelivery` (customer approver or admin; inside or after the window while not yet accepted) → `accepted` with the policy's warranty statement; the order becomes `customer_accepted` once everything ordered is accepted;
- `reportDeliveryIssue` (customer requester or approver): inside the window it opens an exception and holds the leg (`discrepancy_hold`); after acceptance it records a warranty claim and holds nothing; `not_received` is accepted from `delivered_to_destination`;
- `withdrawIssue` (the customer) and `resolveException` (`jobwork_support` or logistics: `found_delivered`, `customer_withdrew`, `handed_to_case` with a reference, `redirected`, `declined`, `returned_to_stock`) — the leg leaves the hold only when no exception is open, and returns to `receiving_check`;
- `requestAddressChange` (customer or `jobwork_sales`; released up to POD) → an `address_change` exception holding the requested snapshot; the shipment's own snapshot never changes; `redirected` records the carrier's reference and charge note and the POD then names the redirected address;
- `recordRefusal` (logistics) → `refused`; a `refused` exception; a return leg in carrier custody, received with the ordinary `receive`;
- `acceptanceSweep` (service-only, `POST /internal/deliveries/acceptance-sweep`) → deemed acceptance of every leg-2 shipment past its window with no open exception.

What `delivery.api.spec.ts` covers:

- POD is not acceptance: the leg waits in `receiving_check`, and only the customer's acceptance or the sweep accepts it;
- carrier "delivered" with no POD: no acceptance, the shipment in `deliveries_awaiting_pod`, the order not `delivered`; the customer's `not_received` holds it for investigation;
- a damage report inside the window holds the leg with evidence (the customer's own clean files); a report after acceptance is a warranty claim and holds nothing;
- refusal: `refused`, the return leg, its receipt moving the lots back (ledger conserved, no second lot), and the stock dispatchable again;
- an address change after dispatch: an exception, the original destination snapshot intact, the redirect named on the POD;
- the sweep deems acceptance only past the window and never over an open exception;
- order status `in_customer_transit → delivered → customer_accepted` from real facts; the supplier sees none of it.

## F-17.4 Customer projection, timeline and documents

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/orders/domain/customer-status.ts` | edit | Timeline rows for final checks, on the way and delivery confirmation from delivery facts; next steps "Confirm delivery address", "Confirm delivery" with the due date |
| `apps/api/src/modules/logistics/application/customer-deliveries.ts` | new | The customer's deliveries for an order, built by construction from allowlisted fields |
| `apps/api/src/modules/quality/application/conformity.ts` | new (exported) | A customer-safe conformity summary for released lots: release number and date, quantity, characteristics with nominal, limits, samples, min, max and result; no supplier, instrument or inspector |
| `apps/api/src/modules/logistics/presentation/customer-documents.ts` | edit | Conformity certificate document |
| `apps/api/test/customer-deliveries.api.spec.ts` | new | Timeline rows per stage, the documents list and each document's audience, the leak suite over the order, deliveries and documents JSON |

## F-17.5 UX

| File | Action | Contents |
|---|---|---|
| `apps/operations-web/app/logistics/*` | edit/new | Board groups for leg 2 (ready to plan, preparing, to release, on the way, awaiting POD, awaiting acceptance, exceptions); `/logistics/dispatch/new?salesOrderId=` planner (stock lots, packages, documents with the order's invoices, packing check, destination and contact); leg-2 shipment page (guard matrix with override requests and their status, address confirmation, release, label and delivery note, pickup, POD form, refusal, exceptions and their resolution) |
| `apps/portal-web/app/orders/[orderId]/*` | edit/new | Deliveries card; `/orders/[orderId]/deliveries/[shipmentId]` (address confirmation, tracking, POD, accept with the warranty statement, report an issue with evidence upload, request an address change, withdraw a report); `/orders/[orderId]/documents`; home action tiles |

Browser walk at desktop width and at 390 px: the planner and the gate on desktop; POD capture and the customer's accept/report flow at 390 px (doc 14 §12).

## F-17.6 Pilot scenario 11 (start)

| File | Action | Contents |
|---|---|---|
| `apps/api/test/pilot/scenario-11-delivery-exception.api.spec.ts` | new | Scenario 11's delivery half, described below |
| `docs/build-plan/uat-checklist.md` | edit | Scenario 11 steps per role (delivery half) |

Scenario 11, delivery half:

1. The order received at JobWork; logistics plans a dispatch: the balance is invoiced, and payment, address and documents are red.
2. The customer confirms the address and pays; logistics corrects the e-way bill; the gate is green; release, label and delivery note free of supplier identity; pickup.
3. Delivery is refused at the door: the return leg brings the stock back.
4. Re-dispatched and delivered; the POD with remarks; the customer reports damage on part of a lot inside the window; the leg is held and the exception carries the case reference IN-18 completes.
5. A second delivery deemed accepted by the sweep; a hidden defect reported later is a warranty claim; quantities reconcile across both legs: received = on hand + dispatched + scrapped.

## Decisions taken on the owner's behalf

Taken as safe defaults so the build can proceed; each is reversible and recorded here for review.

| Decision | Default | Why it is safe |
|---|---|---|
| Who plans and releases leg 2 | `jobwork_logistics` | Doc 03: logistics owns shipment and dispatch, never while computed holds exist |
| Lot marking on customer artifacts | JobWork's own marking per stock lot; supplier lot codes internal | Removes the leak at its source; the mapping is kept |
| Balance trigger `before_dispatch` | Invoiced when the first leg-2 shipment of the order is planned | The schedule's own trigger; the customer sees it before goods move |
| `on_delivery` and `net_30` balances | Invoiced at POD | They fall due on delivery |
| E-way bill | Required above ₹50,000 of consignment value at the order's average sell price; 12 digits | Mirrors leg 1; legal and tax review is an open owner item |
| Address confirmation | Required for every leg-2 dispatch; customer in the portal or JobWork sales/logistics with a note | Errs towards confirming |
| Override owners | quality, finance, sales (partial delivery), engineering (change holds); stock, identity, address and documents not overridable | Doc 03 §4; logistics' own preconditions are fixed, not overridden |
| Acceptance window | 7 calendar days from POD to the end of that day in IST, then deemed acceptance | A common B2B inspection period; `D-20` is open |
| Reports after acceptance | Recorded as warranty claims; the warranty period and remedies are IN-18's | Acceptance never waives warranty (doc 19 §8) |

## Increment exit

- [ ] Full two-leg physical chain demo with all gates computed from real facts (scenario 11 start, browser walk).
- [ ] Supplier identity absent from every customer-facing logistics artifact (labels, delivery notes, POD, conformity certificate, tracking and deliveries JSON) — snapshot and leak suite green.
- [ ] POD and acceptance distinct (`BR-LOG-05`); no carrier event accepts anything; every dispatched quantity traceable lot → movement → `OUT-DISPATCHED`, and back on a return.
