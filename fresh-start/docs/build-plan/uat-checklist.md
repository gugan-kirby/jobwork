# Phase 1 UAT checklist (IN-12 F-12.1)

Human acceptance of the pilot scenarios (doc 19 §10: 1–5, 9, 12 for Phase 1; 6 from IN-13; 7 from IN-14–15; 8 from IN-15; 10 from IN-16) by the people who will run them. The automated scenarios (`apps/api/test/pilot/scenario-*.api.spec.ts`) prove the rules hold. This checklist proves the screens let each role do the job without help.

**Where and with what.** On staging, with approved anonymized fixtures (doc 13, UAT row). Never use production data, real customer or supplier identities, real CAD, or real payment credentials (`ES-39`). Each tester uses their own account with only the roles listed below, and MFA is enrolled where the role requires it. The payment provider is in sandbox mode.

**How to record.** Tick a step only when the expected outcome is seen exactly. For anything else, write the scenario and step number, what happened, and a screenshot reference under **Findings**. A finding blocks sign-off until it is fixed and re-tested, or the owner accepts it in writing.

## Testers and roles

| Tester | Roles | App |
|---|---|---|
| Customer requester | `customer_requester` | Portal |
| Customer approver | `customer_approver` | Portal |
| Supplier A estimator | `supplier_estimator` (supplier A) | Portal |
| Supplier B estimator | `supplier_estimator` (supplier B) | Portal |
| Supplier A production | `supplier_production` (supplier A) | Portal |
| Engineering | `jobwork_engineering` | Operations |
| Sourcing | `jobwork_sourcing` | Operations |
| Sales | `jobwork_sales` | Operations |
| Finance | `jobwork_finance` | Operations |
| Platform admin | `platform_admin`, `security_admin` | Operations |

## Scenario 1: clean RFQ, two suppliers, one accepted quote

| # | Who | Screen | Do | Expect | ✓ |
|---|---|---|---|---|---|
| 1.1 | Customer requester | `/enquiries/new` | Raise a one-item enquiry with a drawing, quantity 100, required-by date 60 days out; submit | Reference shown; status "submitted"; nothing asks for a supplier | ☐ |
| 1.2 | Engineering | `/intake` → enquiry | Open it; checklist shows nothing blocking; approve for sourcing | "Approved. Revision 1 is what sourcing quotes against." | ☐ |
| 1.3 | Sourcing | `/rfqs/new` | Start a round on the enquiry; invite suppliers A and B; release | Round open; both invitations "invited"; deadline in IST | ☐ |
| 1.4 | Supplier A, Supplier B | `/rfqs` → round | Each opens the round, downloads the drawing, submits a bid | Own bid shown as v1; no customer name anywhere; the other supplier's bid not visible | ☐ |
| 1.5 | Sourcing | `/rfqs/[id]` | Close for evaluation; run an evaluation; propose an award to the better normalized bid | Both bids ranked with original and normalized totals; award "proposed" | ☐ |
| 1.6 | Sales | `/approvals` | Approve the award | Award approved; the sourcing proposer cannot approve their own | ☐ |
| 1.7 | Sales, Finance, second sales user | `/awards/[id]`, `/approvals`, `/quotes` | Build the cost sheet (finance approves it); draft the quote, have a second sales user approve it, send it | Award lines show each supplier's setup, freight and NRE; the customer view shows JobWork as seller and no supplier name, cost or margin | ☐ |
| 1.8 | Customer approver | `/quotations/[id]` → accept | Accept the quote | Accepted, with an order number; repeated clicks create one order | ☐ |
| 1.9 | Sourcing | `/sales-orders/[id]` | Release the commercial gate once it passes; issue purchase orders | PO issued to supplier A; the customer sees no PO | ☐ |
| 1.10 | Supplier A | `/supplier/orders/[id]` | Acknowledge the PO | Acknowledged; the PO shows JobWork as buyer, not the customer | ☐ |
| 1.11 | Platform admin | `/audit` | Filter by the enquiry, the round, the quote and the PO | Every step above has one audit row with actor, time (IST) and version | ☐ |

## Scenario 2: incomplete enquiry, two clarifications

| # | Who | Screen | Do | Expect | ✓ |
|---|---|---|---|---|---|
| 2.1 | Customer requester | `/enquiries/new` | Submit an enquiry with no material grade and no tolerance | Submitted | ☐ |
| 2.2 | Engineering | `/intake/[id]` | Checklist flags both; send two questions (material, tolerance) | Status "clarification required"; approve is disabled with the reason | ☐ |
| 2.3 | Customer requester | `/enquiries/[id]` | Answer both questions | Notice received; status back to "in review" after the last answer | ☐ |
| 2.4 | Engineering | `/intake/[id]` | Approve; then use "Revise requirement" to put the answered grade and tolerance into the item | The approved revision keeps both answers; the revised item shows the grade and tolerance; the revisions table shows the reason | ☐ |

## Scenario 3: one decline, single-source approval

| # | Who | Screen | Do | Expect | ✓ |
|---|---|---|---|---|---|
| 3.1 | Sourcing | `/rfqs/new` | Round with suppliers A and B | Released | ☐ |
| 3.2 | Supplier B | `/rfqs/[id]` | Decline with code "capacity" and a reason | Decline recorded; the bid form is gone | ☐ |
| 3.3 | Supplier A | `/rfqs/[id]` | Bid | v1 shown | ☐ |
| 3.4 | Sourcing | `/rfqs/[id]` | Close; propose the award | Single-source risk is flagged; the award is refused until a fallback note says what happens if the supplier fails | ☐ |
| 3.5 | A second sourcing user | `/approvals` | Approve with the fallback visible | Sales cannot approve a single-source award, and nor can the proposer; once approved, the fallback note is kept with the award | ☐ |

## Scenario 4: quote revision, concurrency and expiry retry

| # | Who | Screen | Do | Expect | ✓ |
|---|---|---|---|---|---|
| 4.1 | Sales | `/quotes/[id]` | Revise an issued quote (new price) | v2 issued; v1 marked superseded, still readable | ☐ |
| 4.2 | Customer approver | `/quotations/[id]` (two tabs) | Accept in tab 1, then in tab 2 | Tab 2 is told it changed and nothing is accepted twice | ☐ |
| 4.3 | Customer approver | expired quote | Try to accept after the validity date | Refused with "expired"; sales can re-issue | ☐ |
| 4.4 | Sales → customer | `/quotes/[id]` → `/quotations/[id]` | Re-issue, then accept | Accepted once; one order | ☐ |

## Scenario 5: engineering revision after a supplier bid

| # | Who | Screen | Do | Expect | ✓ |
|---|---|---|---|---|---|
| 5.1 | Supplier A | `/rfqs/[id]` | Bid on an open round | v1 shown | ☐ |
| 5.2 | Engineering | `/intake/[id]` → Revise requirement | Change the tolerance with a reason | "Revision N is in force", naming the superseded round | ☐ |
| 5.3 | Suppliers A and B | `/notifications`, `/rfqs` | Open the notice and the round | "Closed: requirements updated"; supplier A's bid unchanged and marked as not awardable | ☐ |
| 5.4 | Sourcing | `/rfqs/new` | New round on the new revision | Lines show the new tolerance; bids can be taken and awarded | ☐ |
| 5.5 | Customer requester | `/enquiries/[id]` | Look at the enquiry | No rounds, suppliers or bids are visible | ☐ |

## Scenario 6: engineering change after production start (IN-13)

Start from an order in production: advance paid, baseline released and acknowledged, the first milestone started with evidence submitted.

| # | Who | Screen | Do | Expect | ✓ |
|---|---|---|---|---|---|
| 6.1 | Customer requester | `/orders/[id]` → Changes → Request a change | Ask for a laser-marked part number, urgent | The change shows "received"; no price or date yet | ☐ |
| 6.2 | Engineering | `/changes/[id]` | Start triage; issue a stop on the supplier's PO until a date within 30 days | Stop shown with its end in IST; the production page's technical gate is red | ☐ |
| 6.3 | Supplier A production | `/supplier/orders/[id]` | Open the order; try to start the next milestone | "Stop affected work until …"; the start is refused | ☐ |
| 6.4 | Engineering | `/changes/[id]` | Classify as scope with a supplier brief | Status "impact analysis"; the brief is what the supplier sees | ☐ |
| 6.5 | Supplier A estimator | `/supplier/orders/[id]` → Engineering changes | Send a cost and lead-time estimate | "Your estimate is with JobWork"; no customer name or wording anywhere | ☐ |
| 6.6 | Engineering | `/sales-orders/[id]/production`, then `/changes/[id]` | Assemble a draft baseline with the marking drawing; answer all eight areas (20 pieces scrap), name the draft, save, complete | "Release" of the draft is disabled on the production page; the change goes to approval | ☐ |
| 6.7 | Sales | `/approvals` | Approve the engineering change | Change shows "approved", waiting for the customer | ☐ |
| 6.8 | Customer approver | `/orders/[id]` → Changes | Confirm the effect, approve | Only price (tax included) and delivery days are shown; "You approved this on …" | ☐ |
| 6.9 | Engineering | `/changes/[id]` | Release the new baseline | Stop lifted; diff shows the marking drawing "added"; amendments listed per PO | ☐ |
| 6.10 | Supplier A production | `/supplier/orders/[id]` | Acknowledge the new drawing pack and amendment | Drawing pack shows the new transmittal acknowledged; work can start again | ☐ |
| 6.11 | Engineering | `/changes/[id]` | Verify with a note; close | "This change is closed" | ☐ |
| 6.12 | Finance | `/sales-orders/[id]` | Invoice the change installment | Invoice total equals the customer's approved price change | ☐ |

## Scenario 7: first-article inspection on the launch template (IN-14)

Start from an order in production planning: baseline released and acknowledged, work package planned. Testers add **JobWork quality** (`jobwork_quality`, two people) and **Supplier A quality** (`supplier_quality`).

| # | Who | Screen | Do | Expect | ✓ |
|---|---|---|---|---|---|
| 7.1 | Sourcing | `/sales-orders/[id]/production` | Look at the work package's gates | Compliance is red: "No approved quality plan for the current baseline" | ☐ |
| 7.2 | JobWork quality | same page → Write quality plan | Open the draft from "CNC machined part"; try to approve | Refused: a drawing characteristic is required | ☐ |
| 7.3 | JobWork quality | `/quality/plans/[id]` | Add the bore (balloon 7, critical, 11.98–12.02 mm, both included) and the length; save; approve | Plan v1 approved; compliance turns green; sourcing can release | ☐ |
| 7.4 | Supplier A quality | `/supplier/quality` | Register a bore gauge and a caliper; record each calibration with its certificate | Each shows "calibrated" with its due date in IST; one given an expired due date shows "calibration expired" | ☐ |
| 7.5 | JobWork quality | `/quality/plans/[id]` → Plan inspection | Plan the first article | QI number; the supplier is notified | ☐ |
| 7.6 | Supplier A quality | `/supplier/inspections/[id]` | Start; enter one value in inches and the length with the expired caliper; submit | Grid shows the inch value with its mm equivalent; the caliper result says "calibration expired" | ☐ |
| 7.7 | JobWork quality (not the planner if possible) | `/quality/inspections/[id]` | Start review | "Cannot pass yet" lists the caliper; Pass is disabled | ☐ |
| 7.8 | JobWork quality | same | Correct a deliberately mistyped value with a reason; accept the caliper with a reason; pass | "Corrections on record" keeps the mistyped value; the inspection passes; the supplier is told | ☐ |
| 7.9 | Supplier A quality | `/supplier/inspections/[id]` | Plan and submit a second FAI with an oversize bore (JobWork quality plans it) | JobWork quality cannot pass it; failing it needs a note the supplier reads | ☐ |
| 7.10 | Customer requester | `/orders/[id]` | Look at the order | No inspection, instrument or result is visible | ☐ |
| 7.11 | JobWork quality | `/quality/inspections/[id]` (the failed FAI) | Open an NCR on the failed bore, critical, with the lot | NCR number; the supplier is notified; a corrective action is requested | ☐ |
| 7.12 | Supplier A quality | `/supplier/ncrs/[id]` | Record containment; answer the corrective action with "Operator mistake", then with real causes | The first answer is refused; the second is recorded | ☐ |
| 7.13 | JobWork quality | `/quality/ncrs/[id]` | Move to disposition; approve a rework plan; accept the corrective action | Status "rework"; the supplier sees the plan | ☐ |
| 7.14 | Supplier A quality → JobWork quality | NCR page, then the reinspection | Record the rework; JobWork plans the reinspection; the supplier measures; another reviewer passes it | The NCR shows "verified"; the original FAI still shows its fail | ☐ |
| 7.15 | JobWork quality (the one who approved the rework) | `/quality/ncrs/[id]` | Try to close | Refused: someone else closes; verify the corrective action first | ☐ |
| 7.16 | Second JobWork quality member | `/quality/ncrs/[id]`, then `/quality/releases/[workPackageId]` | Close the NCR; after a final inspection and milestones, release the lot | NCR closed; the checklist is all green; the release shows its hash | ☐ |

## Scenario 8: scoped customer-approved deviation (IN-15)

Start from an order in production with an approved plan, a passed first article, and two lots at final inspection.

| # | Who | Screen | Do | Expect | ✓ |
|---|---|---|---|---|---|
| 8.1 | Supplier A quality | `/supplier/inspections/[id]` | Submit LOT-A's final inspection in tolerance and LOT-B's a few microns over | LOT-A passes; LOT-B fails | ☐ |
| 8.2 | JobWork quality | `/quality/inspections/[id]` → Open an NCR | Open an NCR for LOT-B (major, lot LOT-B); contain; move to disposition | Release of anything is refused while LOT-B's failure stands | ☐ |
| 8.3 | JobWork quality | `/quality/ncrs/[id]` → Use as is under a deviation | Scope it to LOT-B, its parts, 30 days, with a labelling effect | Deviation number; waiting for approval | ☐ |
| 8.4 | Second JobWork quality member | `/approvals` | Approve the deviation | It moves to the customer; the requester could not have approved it | ☐ |
| 8.5 | Customer requester, then approver | `/orders/[id]` → Quality decisions | The requester looks; the approver confirms the scope and accepts | The requester cannot decide; the approver sees requirement, measured values, scope, period and effects; it shows "accepted as is" in violet | ☐ |
| 8.6 | JobWork quality | `/quality/releases/[workPackageId]` | Check a release of both lots together; then LOT-B alone; then LOT-A alone | Both together are refused; each alone releases; LOT-B's release names the deviation | ☐ |
| 8.7 | JobWork quality | `/quality/inspections/[id]` (LOT-B) | Look at the results | Still "fail", each marked "accepted under DV-…", never green | ☐ |

## Scenario 9: duplicate and delayed payment callback, reconciliation

| # | Who | Screen | Do | Expect | ✓ |
|---|---|---|---|---|---|
| 9.1 | Finance | `/sales-orders/[id]` | Issue the invoice for the first installment | Invoice issued with GST lines; the customer sees it under `/invoices` | ☐ |
| 9.2 | Customer approver | `/invoices/[id]` → pay | Pay through the sandbox | Payment "pending" until the provider confirms | ☐ |
| 9.3 | Finance (with the provider sandbox) | — | Replay the same success callback twice; send one late | One payment recorded; the invoice is paid once; the duplicates are logged | ☐ |
| 9.4 | Finance | `/finance` | Open the reconciliation queue | Nothing left unmatched; the replayed callbacks did not create a second receipt | ☐ |

## Scenario 10: short and damaged supplier shipment (IN-16)

Start from an order in production with two lots released by quality (e.g. LOT-A 60 and LOT-B 40 of 100 ordered), and a JobWork logistics member signed in with MFA.

| # | Who | Screen | Do | Expect | ✓ |
|---|---|---|---|---|---|
| 10.1 | Supplier A production | `/supplier/orders/[id]` → Plan a shipment | Pack LOT-A in two packages of 30 and LOT-B in one of 40; leave the challan blank and save | Released lots show what is available; the documents guard is red with its reason; submit is disabled | ☐ |
| 10.2 | Supplier A production | `/supplier/shipments/[id]` | Add the challan (and an e-way bill if over ₹50,000); submit | Every guard green; "With JobWork" | ☐ |
| 10.3 | JobWork logistics | `/logistics` → To release | Open it and release | Guards re-checked; addresses frozen; the supplier is told to hand it over | ☐ |
| 10.4 | Supplier A production | `/supplier/shipments/[id]` | Record pickup with the transporter and LR number | Without the LR number it is refused; then "on the way"; the order shows in transit | ☐ |
| 10.5 | JobWork logistics | `/logistics/shipments/[id]` → Carrier update | Record "delivered" (or let the carrier feed send it) | "Carrier delivered — receive it"; nothing is in stock yet | ☐ |
| 10.6 | JobWork logistics (phone) | `/logistics/shipments/[id]` → Receive | Count package 2 as 25, mark package 3 damaged with 4 quarantined, add a photo; check the preview; record | Shortage and damage previewed, then opened as RD-…; shipment on hold; ordered and shipped unchanged; the supplier is told | ☐ |
| 10.7 | JobWork logistics | Same screen → Discrepancies | Try to scrap the damage; then mark the shortage "replacement expected" | Scrap is refused (quality's); the shortage resolves | ☐ |
| 10.8 | JobWork quality | Same screen | Scrap the quarantined pieces | The shipment is received; the work package shows 9 outstanding | ☐ |
| 10.9 | JobWork quality | `/quality/releases/[workPackageId]` | Release 10 of a replacement lot after its final inspection; then 9 | 10 is refused, naming the 9 released but never delivered; 9 releases | ☐ |
| 10.10 | Supplier A, then JobWork logistics | Plan, release, pick up, receive | Ship the 9 and receive them in full | The order reaches "received at JobWork" | ☐ |
| 10.11 | JobWork logistics | `/logistics/work-packages/[id]` | Read the reconciliation and the lots | Ordered 100, shipped 109, counted 104, accepted 100, scrapped 4, outstanding 0; every lot's received quantity = stock + scrapped | ☐ |
| 10.12 | Supplier A | `/supplier/shipments/[id]` | Read the first shipment | JobWork's counts and both discrepancies with their resolutions; no stock locations, no internal split | ☐ |

## Scenario 11: delivery refused, damaged, made good (IN-17, IN-18)

Start from the scenario 10 order received at JobWork in full (LOT-A 60, LOT-B 40), with partial delivery allowed. The JobWork logistics, sales, support, finance and quality members sign in with MFA; two finance members are needed.

| # | Who | Screen | Do | Expect | ✓ |
|---|---|---|---|---|---|
| 11.1 | JobWork logistics | `/logistics/dispatch/new` | Plan a delivery of LOT-A 60 with the packing check ticked | The balance invoice is issued; payment, address and documents are red, each with its reason; lots show JobWork's `JW-` markings only | ☐ |
| 11.2 | Customer requester | `/orders/[orderId]/deliveries/[shipmentId]` | Confirm the delivery address; pay the balance | Address confirmed; payment turns green on the ops screen | ☐ |
| 11.3 | JobWork logistics | `/logistics/shipments/[id]` | Enter the invoice number and e-way bill `1811-XX`, then `1811 0000 0042`; submit; release | The malformed number is refused by the documents guard with its reason; then every guard is green and it releases | ☐ |
| 11.4 | JobWork logistics | Same screen → Label, Delivery note | Open both documents | Neither names the supplier, its lot codes, its PO or its city | ☐ |
| 11.5 | JobWork logistics | Same screen | Record pickup, then a refusal at the door with who refused and why | "Refused"; a return leg to the hub appears under the same marking | ☐ |
| 11.6 | JobWork logistics (phone) | Return leg → Receive | Receive it in full | Stock is back on the same lots; the refusal shows "returned to stock" | ☐ |
| 11.7 | JobWork logistics | Plan, release, pick up | Re-dispatch LOT-A 60; record the POD with remarks | "Receiving check"; the customer is asked to confirm | ☐ |
| 11.8 | Customer requester | Delivery page → Report an issue | Report 2 damaged on the lot with a photo | "Issue reported"; Accept is unavailable | ☐ |
| 11.9 | JobWork support | `/support` → New case | Open a delivery case from the report, naming the PO | The exception shows "handed to case" with the case number; the delivery stays held | ☐ |
| 11.10 | JobWork logistics | Plan, release, pick up, POD | Deliver LOT-B 40; let the window pass (or run the acceptance sweep) | Deemed accepted; the customer is told | ☐ |
| 11.11 | Customer requester | That delivery | Report a hidden defect on 1 piece | Recorded as a warranty claim; the delivery stays accepted | ☐ |
| 11.12 | Supplier A production | `/supplier/bills` | Bill the PO for 100 | Bill submitted | ☐ |
| 11.13 | JobWork finance | `/finance/bills` | Match the bill | Matched; settlement eligible | ☐ |
| 11.14 | JobWork support | `/support/[caseId]` | Triage, investigate, propose a credit note (₹236), a supplier recovery (₹247) and a concession | Goes to finance for approval; the customer sees no remedy yet | ☐ |
| 11.15 | Second JobWork finance | Approvals | Approve | The case shows "resolution approved"; the bill's settlement is held, naming the case | ☐ |
| 11.16 | JobWork finance / support | Case → each action | Issue the credit note on the balance invoice; record the recovery with its debit-note reference; record the concession with a note | The invoice is unchanged and a CN-… is issued; the case moves to verifying; close is refused | ☐ |
| 11.17 | Customer requester | `/support/[caseId]` | Read the case | The credit note and concession appear; no supplier, PO or recovery | ☐ |
| 11.18 | Second finance, support, quality | Case → Verify | Each verifies an action they did not carry out; close the case | The doer cannot verify their own action; the case closes and the delivery waits for acceptance again | ☐ |
| 11.19 | Customer approver | Delivery page | Accept | The order shows accepted | ☐ |
| 11.20 | JobWork finance | `/finance/bills` | Recheck, schedule and pay the settlement with a UTR | Paid; the order is closed | ☐ |
| 11.21 | JobWork finance | `/finance/margin` | Open the order | Revenue is net of the ₹200 credit before tax; cost is net of the ₹247 recovery; the variance is shown | ☐ |

## Scenario 12: suspension and cross-party access

| # | Who | Screen | Do | Expect | ✓ |
|---|---|---|---|---|---|
| 12.1 | Platform admin | `/organizations/[id]` → People | Type the reason; suspend supplier B's estimator | Suspend stays disabled until a reason is given; afterwards the reason is in the audit | ☐ |
| 12.2 | Supplier B estimator | any page | Continue working in the open session | Signed out at the next request; cannot sign in | ☐ |
| 12.3 | Supplier A estimator | address bar | Open supplier B's bid and the customer's enquiry by URL | "Not found" both times; nothing reveals that they exist | ☐ |
| 12.4 | Customer requester | address bar | Open a supplier bid or a PO by URL | "Not found" | ☐ |
| 12.5 | Platform admin | `/audit` | Look up supplier B's estimator | The suspension and the reinstatement, each with the admin who did it and the reason given | ☐ |
| 12.6 | Platform admin | Grafana → JobWork security → "External refusals (403/404)" | Look for the refused attempts from 12.3–12.4 | They appear as supplier and customer refusals; a sustained burst would raise `ExternalDenialSpike` (doc 12 §7) | ☐ |
| 12.7 | Supplier B estimator | address bar | Open supplier A's bill by URL; try `/support` and the ops finance screens | "Not found" for the bill; no access elsewhere | ☐ |
| 12.8 | Customer requester of another company | address bar | Open this customer's case by URL | "Not found"; the case list is empty | ☐ |
| 12.9 | Platform admin, then supplier A and customer | People, then `/supplier/bills` and `/support` | Suspend each user; in their open sessions, submit a bill / open a case | Signed out at the next request; nothing is created; reinstate both | ☐ |

## Findings

| Scenario.step | What happened | Evidence | Fixed in | Re-tested |
|---|---|---|---|---|
| | | | | |

## Sign-off

| Role | Name | Date | Signature |
|---|---|---|---|
| Customer (pilot customer) | | | |
| Supplier (pilot supplier) | | | |
| Engineering | | | |
| Sourcing | | | |
| Sales | | | |
| Finance | | | |
| Platform admin | | | |
| Owner (Phase 1 exit) | | | |
