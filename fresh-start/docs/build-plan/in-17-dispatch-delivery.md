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

**Deviations (2026-10-05, F-17.1):**

- **Evidence at the constraint.** The transition trigger refuses a leg-2 move to `receiving_check` without a `proof_of_delivery` row, and to `accepted` without a `delivery_acceptance` row. `BR-LOG-05` holds even against a command that forgets it.
- **Template keys.** A key's prefix is its audience (IN-10), so the internal one is `internal.delivery_exception_opened`. The customer is told when a delivery is deemed accepted (`customer.delivery_deemed_accepted`); an explicit acceptance is the customer's own act and needs no notice.
- **Override decisions.** `returned` from the approval rail is kept as its own status; like `rejected`, it covers nothing.
- **Queues.** The three queues join the queue registry with their membership: leg-2 `ready_for_release`; leg 2 picked up, in transit or carrier-delivered; open delivery exceptions (support and logistics).

**Verification (2026-10-05, F-17.1).** `customer-dispatch.db.spec.ts` (7) covers:

- the seeds: policy v1 (7 days, deemed acceptance), the override approver roles per guard, three queues, ten template rows;
- POD before awaiting acceptance and an acceptance record before accepted, each once and immutable, with the acceptance's actor matching its basis;
- refusal, "not received" and a withdrawn report on leg 2 only, with leg 1's machine unchanged;
- the packing check frozen at release;
- address confirmations immutable; one pending override per guard, decided once, with its reasons fixed;
- exceptions resolved once with a note, an address change carrying its own snapshot while the shipment's stays frozen;
- a return leg, one per outbound shipment, moving dispatched stock back onto the same lot within what was dispatched.

The approval-policy seed assertion gains `dispatch_override`, and the template pin moves to 36. Database suite 103 green.

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

**Deviations (2026-10-05, F-17.2):**

- **Routes.**
  - JobWork: `POST /customer-dispatches` (plan), and on `/customer-dispatches/:id`: `replan`, `address-confirmations`, `submit`, `overrides`, `release`, `GET label`, `GET delivery-note`. The planner reads `GET /logistics/sales-orders/:id/dispatch-context`: the customer's addresses, the order's invoices, the delivery terms, and each stock lot with its marking, stock, what other prepared dispatches picked, the release and any NCR.
  - Pickup, carrier events and cancel reuse `/shipments/:id/…`. `POST /shipments/:id/release` refuses a leg-2 shipment (`SHIPMENT_LEG`).
  - Customer: `GET /orders/:id/deliveries`, `GET /deliveries/:id`, `POST /deliveries/:id/confirm-address`, `GET /deliveries/:id/delivery-note`.
- **The customer projection is built here.** `customer-deliveries.ts` (planned for F-17.4) is needed now: the address confirmation and both documents read it. F-17.4 extends it with POD, acceptance and exceptions.
- **The identity scan matches whole names.** The IN-10 registry flags a party's full name, domain, email or phone, never a lone word. A serial reading "ANAND-0001" is not a finding: a lone word would match half of Chennai. That is why JobWork's lot marking, neutral by construction, is the main control and the scan is the backstop. The test plants the supplier's full name in an item description.
- **Order status.**
  - Release moves the order from `received_jobwork` to `ready_customer_dispatch`.
  - Pickup moves it to `in_customer_transit`, also when a partial delivery leaves while a leg-1 shipment is still inbound.
  - **Fixed on the way:** IN-16 applied leg 1's transit rule to every leg's pickup, so picking up a customer-material issue could have moved an order into supplier transit. The rule is now leg-specific.
- **A carrier's pickup notifies the customer.** A carrier "picked up" on a released shipment now emits `logistics.shipment_picked_up.v1` too, so the customer hears of a carrier pickup as of a recorded one. That event is now notified (leg 2 only) rather than acknowledged.
- **Override notices.** The guard's owner gets `internal.approval_requested` linking to the shipment page; quality and engineering do not read `/approvals`. The approvals list gains the kind, and its target opens the shipment.
- **Refusals at planning.** Planning refuses an order still pending commercial release, cancelled or closed (`ORDER_NOT_DISPATCHABLE`), a lot outside the order's made parts (`LOT_NOT_ORDER_STOCK`), a serial not in the lot when the lot records serials, and an address not the customer's.

**Verification (2026-10-05, F-17.2).**

- `dispatch-gate.spec.ts` (30): each of 24 facts turns exactly its own guard red, with its reason; the e-way bill threshold; credit covering what is open; an override covering only an approved request for the exact reasons; no override of logistics' own guards.
- `customer-dispatch.api.spec.ts` (9), on a deal received at JobWork (`Pilot.atJobWork`):
  - the dispatch context;
  - planning by logistics only, under JobWork markings, with the balance invoiced at planning, and four guards red;
  - the customer's address confirmation, made stale by an edit to the site and recorded again by sales;
  - another order's invoice and a malformed e-way bill blocking until replanned;
  - a partial delivery the customer did not allow, and the supplier's name in an item description;
  - overrides: refused for logistics' own guards and green ones, asked by logistics only, decided by finance only (logistics `APPROVAL_SEPARATION`, quality not an approver), covering until a credit hold adds a reason;
  - payment, submit and release, with the stock moved to `OUT-DISPATCHED` and a second release of the same pieces refused;
  - label, delivery note and the customer's JSON free of the supplier's names, lot codes, purchase order, city, contact and buy price;
  - pickup into `in_customer_transit` with the customer notified, while the supplier sees nothing of leg 2.
- `customer-documents.spec.ts` (3): label and delivery-note snapshots, escaping, and a deterministic hash.

The audit inventory gains seven operations.

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

**Deviations (2026-10-05, F-17.3):**

- **Routes.**
  - JobWork: `POST /shipments/:id/pod`, `POST /shipments/:id/refusal`, `POST /delivery-exceptions/:id/resolve`, `POST /customer-dispatches/:id/address-change` (sales or logistics, for a request by phone or mail), and `GET /customer-dispatches/:id/pod`.
  - Customer: `POST /deliveries/:id/accept`, `/issues` and `/address-change`; `POST /delivery-exceptions/:id/withdraw`; `GET /deliveries/:id/pod`.
  - Worker: `POST /internal/deliveries/acceptance-sweep` (service-only), ticked every `DELIVERY_SWEEP_MS` (15 minutes).
- **A POD while held.** "Not received" holds a carrier-delivered leg with no POD. The investigation records the POD while the leg is held, and `found_delivered` needs that POD.
- **Holds.**
  - Once nothing holds the leg, it returns to awaiting acceptance.
  - A report the customer withdraws, one found delivered, or one JobWork declines with a note lifts the hold.
  - A report handed to a case keeps it: IN-18's case decides. An order with such a delivery stays `delivered`, not `customer_accepted`.
- **The window, exactly.**
  - Inside it, any report holds the delivery.
  - After it closes, and before the sweep runs, only a defect may be reported, as a warranty claim.
  - After acceptance, a shortage, damage or wrong item is refused (`WINDOW_CLOSED`). A defect is a warranty claim and holds nothing.
- **What the customer sees of an exception:** JobWork's resolution and case reference, but not its notes, the carrier's charges, or the wording of an exception JobWork raised.
- **Readers.** `jobwork_support` joins the logistics readers: it triages what customers report and reads the shipment it resolves.
- **POD remarks.** "With remarks" without a note is refused at the contract (400), not at the database.
- **The return leg.**
  - It is created already picked up, with the outbound's carrier and tracking reference, so the carrier's events land on it.
  - Its receipt moves the same lots `OUT-DISPATCHED → JW-STOCK` or `JW-QUARANTINE` (type `return`) and closes the refusal as `returned_to_stock`.
  - A discrepancy on a return leg finds its lot through the item's stock lot.
- **Address changes.** Only logistics resolves one: it arranges the carrier. A redirect is refused once the POD is recorded.
- **The sweep in tests.** The endpoint runs on the real clock, and the test also calls the command with a clock nine days ahead. Moving `acceptance_due_at` is refused by the trigger, so no row is rewritten to stage it.

**Verification (2026-10-05, F-17.3).**

`delivery.api.spec.ts` (8) runs four deliveries of one order (partial delivery allowed at enquiry) and covers:

- the POD by logistics only, refused in the future, refused "with remarks" without a note, opening a window to the end of the seventh day in IST and accepting nothing; acceptance by the approver only, with the warranty statement;
- a defect after acceptance recorded as a warranty claim while a shortage is refused;
- "not received" holding a carrier-delivered leg (seen in `deliveries_awaiting_pod`, support and logistics notified), a POD recorded while held, and `found_delivered` returning it to awaiting acceptance;
- damage reported with the customer's own photo (another party's file, a quantity beyond the delivery and an unknown marking refused), withdrawn; a shortage handed to case `CASE-2026-0001` keeping the hold;
- refusal, the return leg in carrier custody with the same markings, its receipt bringing 40 back to `JW-STOCK` with no new lot, the refusal closed, and the stock dispatchable again;
- an address change after dispatch: the shipment's snapshot unchanged (the trigger refuses a rewrite), redirected by logistics only, with the POD naming the Hosur unit;
- the sweep: nothing on the real clock; nine days on, the past-window delivery is deemed accepted with no actor, the held one untouched, and the customer told; the order `delivered` but not `customer_accepted`;
- the ledger at 100 dispatched, the POD document free of the supplier, and leg 2 refused to the supplier.

`customer-documents.spec.ts` gains the POD snapshot. The audit inventory gains eight operations.

## F-17.4 Customer projection, timeline and documents

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/orders/domain/customer-status.ts` | edit | Timeline rows for final checks, on the way and delivery confirmation from delivery facts; next steps "Confirm delivery address", "Confirm delivery" with the due date |
| `apps/api/src/modules/logistics/application/customer-deliveries.ts` | new | The customer's deliveries for an order, built by construction from allowlisted fields |
| `apps/api/src/modules/quality/application/conformity.ts` | new (exported) | A customer-safe conformity summary for released lots: release number and date, quantity, characteristics with nominal, limits, samples, min, max and result; no supplier, instrument or inspector |
| `apps/api/src/modules/logistics/presentation/customer-documents.ts` | edit | Conformity certificate document |
| `apps/api/test/customer-deliveries.api.spec.ts` | new | Timeline rows per stage, the documents list and each document's audience, the leak suite over the order, deliveries and documents JSON |

**Deviations (2026-10-05, F-17.4):**

- **Where the timeline's facts come from.** `OrdersRepository.customerDeliveryFacts` reads the order's leg-2 shipments, their POD and acceptance. It is a query, not an import: logistics already imports orders, so orders cannot import logistics. It writes nothing.
- **Timeline rows.**
  - Final checks: "confirm the delivery address" while a packed delivery waits on it, dated at the first dispatch once done.
  - On the way: dispatch date, carrier and tracking, how many are on the way and how many delivered.
  - Delivery confirmation: the handover date and the date to accept or report by; "JobWork is handling the issue you reported" while a report holds it; once done, "accepted on" or "taken as accepted on".
  - Next steps: "Confirm the delivery address", "Confirm delivery" with the due date and the warranty wording, and "Issue being handled".
- **The order list's action** gains `confirm_address` and `confirm_delivery`, carrying the shipment. An open invoice still comes first. The action's invoice id is now nullable.
- **Portal home.** The summary gains `deliveries_awaiting_you`: deliveries to accept, and packed ones with no confirmation for their address. An edit made after a confirmation shows on the delivery page and in the gate, not in this count.
- **Documents live in logistics.** `GET /orders/:id/documents` and the certificate are served by logistics, which reads orders, finance's invoices and quality's `ConformityView`. The list:
  - the accepted quotation;
  - the order's invoices;
  - for each delivery that left: its delivery note, its certificate and, once handed over, its POD.
- **The conformity certificate** (`GET /deliveries/:id/conformity`, and `/customer-dispatches/:id/conformity` for JobWork) draws on quality's new `ConformityView`:
  - the releases covering the delivery's lots;
  - the passed first-article, final and JobWork-incoming inspections;
  - each characteristic from its latest results (corrections supersede), against the drawing's limits;
  - approved deviations.

  It speaks only in JobWork's markings, never the inspecting organization, instrument or inspector. It is issued once the delivery has left (409 before).

**Verification (2026-10-05, F-17.4).** `customer-deliveries.api.spec.ts` (6) walks one order and covers:

- the address request appearing on the timeline, next step, order list (after the balance is paid) and portal count, and clearing on confirmation;
- dispatch with carrier and tracking;
- the confirmation due date after the POD, then "taken as accepted" and `completed` after the sweep;
- six documents listed and each rendered for the customer, while another customer, the supplier and JobWork get 404;
- the certificate's release, first-article and final inspections, the bore against "12 mm, ≥ 11.98, ≤ 12.02 mm", and the same hash JobWork sees;
- the leak suite over the order, deliveries and documents JSON, and the delivery note, POD and certificate HTML: no supplier name, lot code, purchase order, city, contact, instrument kind or asset tag.

API suite 507 green.

## F-17.5 UX

| File | Action | Contents |
|---|---|---|
| `apps/operations-web/app/logistics/*` | edit/new | Board groups for leg 2 (ready to plan, preparing, to release, on the way, awaiting POD, awaiting acceptance, exceptions); `/logistics/dispatch/new?salesOrderId=` planner (stock lots, packages, documents with the order's invoices, packing check, destination and contact); leg-2 shipment page (guard matrix with override requests and their status, address confirmation, release, label and delivery note, pickup, POD form, refusal, exceptions and their resolution) |
| `apps/portal-web/app/orders/[orderId]/*` | edit/new | Deliveries card; `/orders/[orderId]/deliveries/[shipmentId]` (address confirmation, tracking, POD, accept with the warranty statement, report an issue with evidence upload, request an address change, withdraw a report); `/orders/[orderId]/documents`; home action tiles |

Browser walk at desktop width and at 390 px: the planner and the gate on desktop; POD capture and the customer's accept/report flow at 390 px (doc 14 §12).

**Deviations (2026-10-05, F-17.5):**

- **Operations.**
  - The logistics board gains five leg-2 groups: to release, customer issues, on the way, awaiting acceptance, being prepared. Orders received at JobWork are listed with "Plan a delivery".
  - `/logistics/dispatch/new` plans from the order (`salesOrderId`) or edits a delivery not yet released (`shipmentId`).
  - The shipment page shows leg 2's own panels (`delivery-panels.tsx`):
    - the gate, with overrides asked of each red guard's owner and their state;
    - recording a phone confirmation;
    - submit and release;
    - the customer's four documents;
    - the POD form with photos;
    - refusal;
    - handover and acceptance facts;
    - the exceptions with their resolutions.

    The receiving form stays leg 1's.
  - Statuses read by leg (`statusOf`). The order's shipments card links to the planner.
  - The approvals page shows an override's reasons and logistics' justification before the owner decides.
- **Portal.**
  - The order page gains a deliveries panel, each delivery saying what it needs from the customer.
  - `/orders/[id]/deliveries/[shipmentId]`: confirm the address, accept with the warranty statement, report with photos (only the kinds the delivery's state allows, a defect after acceptance being a warranty claim), ask for another address, withdraw a report, and open the documents.
  - `/orders/[id]/documents` lists the order's documents with their hashes.
  - Home shows "Deliveries waiting on you" through the existing "Waiting on you" list.
- **Found and fixed in the walk.**
  - **A change's instalment never invoiced** (PR #49, its own fix). The gate could only say "not invoiced yet" about a change order's price delta, which IN-13 left pending. Planning and replanning now invoice every instalment due before dispatch.
  - **The next step hid a waiting delivery.** On an order still in production, which can happen with partial deliveries, the next step said "nothing is needed from you" while a packed delivery waited on the address. Delivery actions now come first at any open stage.
  - **POD to the minute.** The form records minutes, so a POD in the same minute as a pickup recorded with seconds read as "before the pickup". The rule allows that minute.
  - **The approver decided blind.** The override decision now shows the reasons and the justification.
  - **A change invoice labelled "Final".** The customer's invoice list and invoice page now say "Change".

**Verification (2026-10-05, F-17.5).** Browser walk on the dev stack (SO-2026-0002, LOT-7 with 26 pieces in JobWork stock, Demo Precision):

- **Planning, desktop, logistics.**
  - The planner offered JW-61B1CB88 (LOT-7 · WP-2026-0001, 26 of 26) and the Ambattur plant. Planned with half the packing check.
  - Five guards red, from the real facts: balance and change open with no credit, a partial delivery the customer did not allow, packing, a missing receiving phone with no confirmation, and no tax invoice.
  - Editing in the planner chose the balance invoice and completed the check. The change instalment was invoiced as INV-2026-0004.
- **The customer at 390 px.**
  - Added the receiving phone to the address.
  - The order page showed the delivery with "Confirm the address"; confirmed it on the delivery page.
  - Paid INV-2026-0003 and INV-2026-0004 through the dev gateway.
- **The override.** Logistics asked sales to override the partial-delivery guard with a justification. Sales saw it in Approvals and approved it.
- **Release and pickup.** Logistics submitted and released it; the stock left for `OUT-DISPATCHED`. Pickup was recorded with Safexpress, SX-90411.
- **POD at 390 px.** Received by the stores desk "with remarks": outer carton scuffed, seal intact. The window was set to 12 Oct, 11:59 pm.
- **Acceptance at 390 px.** The customer read the warranty statement and accepted. The page then offered only a warranty report.

The walk's API fixes ran against the suites they touch: dispatch, delivery and customer projection (23), customer portal (12).

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

**F-17.6 deferred (2026-10-07, owner).** The owner asked to stop all testing for now and continue the build; testing is a later, separate pass. Scenario 11's delivery half (`scenario-11-delivery-exception.api.spec.ts`) and its UAT steps (11.x) are not written. They are the first items of that pass.

## Increment exit

- [x] Full two-leg physical chain demo with all gates computed from real facts. The F-17.5 browser walk ran plan → gate → address and payment → override → release → pickup → POD → acceptance on dev data. The scenario 11 spec is deferred to the test pass.
- [x] Supplier identity absent from every customer-facing logistics artifact. The leak suites in `customer-dispatch.api.spec.ts` and `customer-deliveries.api.spec.ts`, and the document snapshots, were green at F-17.4.
- [x] POD and acceptance distinct (`BR-LOG-05`, enforced by the trigger); no carrier event accepts anything; every dispatched quantity traceable lot → movement → `OUT-DISPATCHED`, and back on a return (`delivery.api.spec.ts`).

**IN-17 build closed 2026-10-07** (PRs #44–#50), with testing deferred. Waiting for the test pass:

- F-17.6, pilot scenario 11's delivery half, and UAT 11.x;
- a full local gate after F-17.5: CI was green on #50, but the local run was stopped.

Owner items carried:

- the defaults above for review;
- `T-04` and `T-05` (no tax or carrier provider);
- legal and tax review of the e-way bill threshold and the invoice that travels with goods;
- `D-20`, the warranty, refund and cancellation matrix, of which the 7-day window is a default.
