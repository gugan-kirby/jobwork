# Use cases and edge cases

## 1. Use-case catalogue

| ID | Actor | Goal | Critical acceptance condition |
|---|---|---|---|
| `UC-01` | Customer | Discover relevant manufacturing capability | Results meet hard eligibility and hide supplier identity/contact by default |
| `UC-02` | Customer requester | Create enquiry from scratch, copy, or assisted intake | Draft autosaves; copied data requires current review/version |
| `UC-03` | Customer requester | Upload CAD/drawing/BOM/specification | Immutable version/hash, scan/classification/audience; no release while quarantined |
| `UC-04` | Customer requester | Answer technical clarification | Answer is versioned, attributed and tied to requirement snapshot |
| `UC-05` | Customer approver | Review/request revision/reject/accept JobWork quote | Exact active quote revision/hash and authority are locked atomically |
| `UC-06` | Customer approver | Decide engineering change or deviation | Full impact/evidence, scoped authority and immutable decision |
| `UC-07` | Customer | Pay installment and obtain receipt/invoice | Provider callback/reconciliation is idempotent; customer pays JobWork |
| `UC-08` | Customer | Track order | Curated accurate milestones/ETA without supplier identity/internal notes |
| `UC-09` | Customer | Accept delivery or report defect/shortage/damage | Evidence window, exact delivered quantity/lot and support case linkage |
| `UC-10` | Supplier admin | Onboard and verify organization | GST/Udyam/certification/bank evidence status, expiry and reviewer tracked |
| `UC-11` | Supplier admin | Maintain capability, machine and capacity | Changes versioned; expired evidence affects eligibility without rewriting history |
| `UC-12` | Supplier estimator | Acknowledge or decline RFQ | Deadline and structured decline reason; no customer identity leak |
| `UC-13` | Supplier estimator | Ask technical question | Controlled thread; answer audience can be private/common without identifying parties |
| `UC-14` | Supplier estimator | Submit feasibility and bid | Exact RFQ baseline, assumptions/exclusions/validity and immutable submitted version |
| `UC-15` | Supplier estimator | Revise bid | New submitted version with reason/diff; old version remains evidence |
| `UC-16` | Supplier planner | Accept PO and production baseline | Exact PO/bid/baseline transmittal acknowledged before release |
| `UC-17` | Supplier production | Plan work and report progress/risk | Evidence tied to operation/milestone/baseline; no silent backdating |
| `UC-18` | Supplier quality | Submit inspection/FAI/certificates | Structured characteristics, units, instruments/calibration and hashes validated |
| `UC-19` | Supplier quality | Respond to NCR/corrective action | Containment, cause, action, reinspection/effectiveness; cannot self-release |
| `UC-20` | Supplier logistics | Ship released goods to JobWork | Quantity/identity/documents/packing and quality gate complete |
| `UC-21` | JobWork sourcing | Triage enquiry | Completeness, confidentiality, conflict and manufacturability inputs dispositioned |
| `UC-22` | JobWork sourcing | Match/shortlist and issue RFQ | Hard eligibility, explainable ranking, conflict/NDA and audience-safe release |
| `UC-23` | JobWork sourcing | Normalize/compare/negotiate bids | Original bids untouched; scenario inputs/rates/risks explicit |
| `UC-24` | JobWork sourcing | Award supplier(s) | Exact bid lines/quantities/operations, authority and fallback/single-source risk |
| `UC-25` | JobWork sales | Build and send customer quote | Approved cost lineage/margin/terms; strict customer-safe projection |
| `UC-26` | JobWork engineering | Validate feasibility and release baseline | Governing files/conflicts resolved; immutable baseline/transmittal |
| `UC-27` | JobWork engineering | Process change | WIP/scrap/cost/date/quality/customer approval and new baseline controlled |
| `UC-28` | JobWork quality | Plan/record/review inspection | Category template, decimal/unit/calibration and independent verification |
| `UC-29` | JobWork quality | Open NCR, decide disposition and release | Scoped evidence/authority; deviation does not convert failed result to pass |
| `UC-30` | JobWork finance | Capture/reconcile customer payment | Gateway/bank/ledger/allocation agree or explicit suspense exception |
| `UC-31` | JobWork finance | Validate supplier bill and settle | PO/receipt/bill match or approved exception; separate from customer payment |
| `UC-32` | JobWork logistics | Receive supplier shipment | Custody, package/quantity/identity/damage documented; discrepancy hold on mismatch |
| `UC-33` | JobWork logistics | Dispatch to customer | Receiving, quality, finance, identity/packing, address and statutory gates pass |
| `UC-34` | JobWork support | Resolve dispute/warranty/return/rework | Physical, quality, customer remedy and supplier recovery remain linked but separate |
| `UC-35` | Platform admin | Configure taxonomy/templates/SLA/approvals/features | Versioned activation/rollback; no ambient business-data access |
| `UC-36` | Security/admin | Suspend party or revoke access | Sessions/grants/queries affected immediately and action audited |
| `UC-37` | Auditor | Export evidence history | Scoped read-only manifest, watermark/reason, immutable hashes and access audit |
| `UC-38` | System | Remind/escalate/retry integration | Durable idempotent job with policy/template version and observable delivery |
| `UC-39` | System | Recompute supplier performance | Deduplicated closed-loop facts, confidence/raw denominator and formula version |
| `UC-40` | System/reviewer | Detect malicious file/contact leakage | Quarantine/review/derived sanitation; no silent engineering-content corruption |

## 2. Cross-cutting preconditions

Most use cases require:

- authenticated active account and organization membership;
- role/action plus relationship/audience authorization;
- expected aggregate version for mutations;
- exact artifact/configuration version;
- valid NDA/verification where applicable;
- no conflicting hold or separation-of-duties violation;
- idempotency key for money, acceptance, issue/release and provider operations;
- audit reason for override, rejection, manual correction and sensitive export.

## 3. Requirement and file edge cases

| Edge case | Required outcome |
|---|---|
| Only a photo/vague description | Assisted engineering intake; do not release an under-specified RFQ |
| CAD and 2D drawing conflict | Declare governing document or resolve change; technical release blocked |
| Corrupt/malicious/password-protected/unsupported/huge file | Quarantine/reject with safe replacement instruction |
| New revision after quote | Preserve quote baseline; re-evaluate technical/commercial impact/new quote if needed |
| New revision after production starts | Change workflow, scoped hold/continue decision, WIP/scrap/rework impact |
| Same bytes under new filename/revision | May reuse storage bytes, but preserve new business document-version history |
| Embedded party metadata/signature/contact | Produce reviewed sanitized release artifact; original restricted |
| Customer withdraws a file | Revoke future access; preserve legal/transaction evidence and assess released copies |
| Supplier downloaded before revocation | Record access and manage contract/incident; revocation cannot erase prior copy |
| Correction/ECN names an enquiry that is not the customer's own (or none exists) | Refuse with one stable answer for "not yours" and "does not exist"; correction may proceed with the reference quoted in text and an advisory flag for the reviewer |
| Correction/ECN submitted without change reference or description | Submit refused naming both fields; reviewer checklist blocks approval until present |
| Job work on customer-supplied material | Intake records the customer as owner and who supplies the material; reviewer sees a custody advisory; receiving/challan handling follows IN-16 |

## 4. Sourcing and quotation edge cases

| Edge case | Required outcome |
|---|---|
| No eligible supplier | Explain hard exclusions internally; broaden/alternate process/date only with customer review |
| Eligible suppliers decline/no response | Extend/re-source/close with reason; SLA and supplier response fact |
| One response only | Single-source risk acknowledgment/approval |
| Late bid | Preserve receipt time; accept/reject only under explicit fair-sourcing policy |
| Supplier changes price after validity | Old version remains expired evidence; request/review new version |
| Split suppliers/operations | Validate route, custody, quantity conservation, consolidated customer commitment |
| Negative margin after new freight/change | Block quote/release; approve exception or re-quote |
| Quote accepted as it expires/supersedes | One atomic winner; loser receives stable conflict and current revision |
| Customer approver limit too low | Route approval/delegation; do not accept partially |
| Supplier certification expires after bid | Recheck at award/release; risk disposition/re-source |

## 5. Production and change edge cases

| Edge case | Required outcome |
|---|---|
| Supplier starts without release | Record unauthorized work/containment; never auto-advance or imply JobWork acceptance |
| Machine breakdown/material delay | Append risk/forecast, critical path and mitigation; customer projection curated |
| Supplier subcontracting discovered | Hold affected scope; verify `D-08` policy, capability/IP/quality/custody impact |
| Customer urgent change in production | Interim stop/continue authority plus formal change/cost/date approval |
| Partial completion/yield loss | Quantity reconciliation, remake/partial-delivery plan and commercial/quality impact |
| Reused/fake-looking progress photo | Flag for review/corroboration; do not automatically accuse or verify milestone |
| Milestone backdated | Enhanced permission/reason; preserve submitted and actual observation timestamps |
| Baseline acknowledgment missing | Block affected start even if files were downloaded |

## 6. Quality edge cases

| Edge case | Required outcome |
|---|---|
| Different measurement units | Convert with versioned rule retaining original; unknown conversion = cannot evaluate |
| Value exactly on tolerance boundary | Apply explicit inclusive/exclusive rule without premature display rounding |
| Instrument calibration expired | Mark evidence invalid/pending quality disposition; block release as policy requires |
| Claimed verbal deviation | No authorization until formal decision by valid actor |
| Deviation only for some quantity/lot | Release only scoped items; remaining failure stays held |
| Rework creates new defect | New/branched defect/NCR lineage; cannot circularly close |
| Inspection data corrected | Invalidate/supersede result with reason; original retained |
| Defect after customer delivery | Warranty case linked to lot/baseline/inspection/supplier corrective action |
| Customer accepts delivery but hidden defect appears | Delivery acceptance does not erase contractual warranty rights/policy |

## 7. Finance and payment edge cases

| Edge case | Required outcome |
|---|---|
| Browser says success; callback absent | Pending/verify provider; no false ledger posting |
| Callback duplicated/delayed/out of order | Provider-ID/idempotent handler; reconcile final truth |
| Unknown/short/combined bank transfer | Suspense/unapplied cash and maker-checker allocation |
| Customer overpays | Unapplied customer credit/refund path; no automatic wallet promise |
| Customer paid but supplier fails | Alternate sourcing/revised commitment/refund/credit decision |
| Refund after invoice/tax issue | Linked refund plus approved credit/tax correction; original retained |
| Chargeback after supplier settled | Customer dispute and supplier recovery/risk remain separate obligations |
| Supplier bill exceeds PO/receipt | Match exception with approval/hold, not silent adjustment |
| Exchange rate changes | Existing snapshot preserved; new scenario/version for future commitment |

## 8. Logistics edge cases

| Edge case | Required outcome |
|---|---|
| Package short/damaged at JobWork | Receiving discrepancy/hold, carrier claim and supplier response |
| Customer address changes after dispatch | Carrier exception and cost/authority; never edit original shipment snapshot |
| Carrier says delivered but site did not receive | Carrier event not acceptance; investigate POD/custody |
| E-waybill/invoice/challan mismatch | Block release/correct through authorized document workflow |
| Partial/multi-package delivery | Package-item quantity allocation and remaining commitment visible |
| Direct ship becomes necessary | Explicit `D-13` exception including identity, tax, inspection, label/POD policy |
| Customer refuses delivery | Exception custody/storage/return/cost approval |
| Return-to-supplier for rework | New shipment/custody leg linked to NCR/return authorization |

## 9. Access and operations edge cases

| Edge case | Required outcome |
|---|---|
| User changes organization/is suspended mid-session | Revoke sessions/grants and deny subsequent API/file/real-time access |
| Same person has conflicting roles | Policy blocks conflict or records separately approved exception |
| Admin needs emergency file access | Time-limited break-glass with reason/alert/review |
| Internal note attached to external message | Fail closed through distinct audience/allowlist and tests |
| Notification queued but transaction rolled back | No outbox event, therefore no false notification |
| Notification provider sends duplicate | Stable notification/delivery identity and idempotent UX/thread |
| Two users edit same draft/decision | Optimistic conflict with diff/refresh; no lost update |
| Search/cache stale after revocation | Detail/download current authorization remains deny; invalidate projection/cache |
| Restore loses external callbacks in window | Provider/bank/carrier reconciliation before declaring consistent |

## 10. Pilot acceptance scenarios

The pilot must exercise at least:

1. Clean single-item RFQ with two suppliers and one accepted JobWork quote.
2. Incomplete enquiry requiring two clarifications.
3. One supplier decline plus single-source approval.
4. Quote revision and concurrency/expiry retry.
5. Engineering revision after supplier bid.
6. Engineering change after material/production start with commercial impact.
7. Failed measurement → NCR → rework → reinspection.
8. Scoped customer-approved deviation.
9. Duplicate/delayed payment callback plus reconciliation.
10. Partial/damaged supplier shipment and receiving hold.
11. Customer delivery exception/warranty/return/refund.
12. User suspension and attempted cross-party file/bid access.

Each scenario must demonstrate data versions, authority, audit/outbox, projections, notifications, failure recovery, and final financial/quantity/configuration consistency.
