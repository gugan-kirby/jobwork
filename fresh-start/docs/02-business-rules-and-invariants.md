# Business rules and invariants

These rules are system contracts. Enforcement may live in domain code, authorization policy, database constraints, or all three. Critical rules require automated tests at more than one layer.

## 1. Commercial separation

| ID | Invariant |
|---|---|
| `BR-COM-01` | The supplier contracts with JobWork; the customer contracts with JobWork. No record may ambiguously represent both legs. |
| `BR-COM-02` | Supplier bid, internal cost sheet, and customer quote are separate versioned aggregates. |
| `BR-COM-03` | A submitted bid version is immutable. A change creates a later version with reason and field diff. |
| `BR-COM-04` | A sent customer-quote version is immutable. Reissue/revision supersedes; it does not edit. |
| `BR-COM-05` | Supplier cost, identity, and settlement are never included in customer projections or exports by default. |
| `BR-COM-06` | Customer sell price, customer identity, and customer payment are never included in supplier projections by default. |
| `BR-COM-07` | An award references exact bid versions. A PO cannot reference “current bid.” |
| `BR-COM-08` | A sales order references the exact accepted customer-quote version and terms snapshot. |
| `BR-COM-09` | A quote cannot be accepted if expired, rejected, superseded, already accepted, or outside the actor's authority. "Valid until D" means until the end of D in the customer's business time zone (India: `Asia/Kolkata`). |
| `BR-COM-10` | Price/tax/rounding results are reproducible from stored line inputs and policy versions. |

## 2. Engineering and document control

| ID | Invariant |
|---|---|
| `BR-ENG-01` | File bytes are immutable after finalization and identified by cryptographic checksum. |
| `BR-ENG-02` | A release grants access to a specific document version, never a mutable document pointer. |
| `BR-ENG-03` | A released baseline is an immutable manifest of exact document versions. |
| `BR-ENG-04` | Production, inspection, NCR, and shipment evidence state the baseline actually used. |
| `BR-ENG-05` | A new revision after release creates a change request and new candidate baseline. |
| `BR-ENG-06` | Conflicting governing documents block technical release until formally resolved. |
| `BR-ENG-07` | Supplier acknowledgment of the active transmittal is required before affected work starts. |
| `BR-ENG-08` | Quarantined, failed-scan, unsupported, or revoked content cannot be released/downloaded externally. |

- `BR-ENG-09`: A correction/ECN enquiry is a new requirement revision of its own, never an edit of the enquiry it corrects; the reference between them is lineage, and the corrected enquiry's frozen revisions and any quote or order on it are untouched. Job work on customer-supplied material records the customer as owner of the goods throughout (custody per §5; GST job-work challan and ITC-04 are the customer's obligations, recorded not performed by JobWork).

## 3. Production and quality

| ID | Invariant |
|---|---|
| `BR-OPS-01` | Work starts only after all category-required release gates pass. |
| `BR-OPS-02` | A milestone is completed only through its named command and evidence policy. |
| `BR-OPS-03` | Evidence upload is not equivalent to milestone verification. |
| `BR-OPS-04` | Backdating, override, reopen, or unauthorized-start disposition requires reason and enhanced permission. |
| `BR-QLT-01` | A failed mandatory characteristic blocks quality release unless an authorized scoped deviation exists. |
| `BR-QLT-02` | A deviation is temporary and scoped; it never edits the specification or marks the measurement as passing. |
| `BR-QLT-03` | The supplier cannot give final JobWork quality release to its own output. |
| `BR-QLT-04` | Rework completion requires reinspection; the reinspection is a new evidence record. |
| `BR-QLT-05` | Expired calibration invalidates use of an instrument until quality disposition. |
| `BR-QLT-06` | An NCR closes only when all required dispositions/actions have independent verification. |

## 4. Money and accounting

| ID | Invariant |
|---|---|
| `BR-FIN-01` | Monetary values use ISO currency plus integer minor units; no binary floating point. |
| `BR-FIN-02` | Every posted financial transaction balances total debits and credits per currency. |
| `BR-FIN-03` | Customer payment does not automatically imply supplier settlement eligibility. |
| `BR-FIN-04` | Supplier settlement does not erase JobWork's customer receivable or refund liability. |
| `BR-FIN-05` | Provider transaction identifiers are unique within provider/account and webhook handling is idempotent. |
| `BR-FIN-06` | Issued invoices are immutable; adjustments use linked credit/debit notes. |
| `BR-FIN-07` | Supplier bill payment requires configured PO/receipt/bill match or an approved exception. |
| `BR-FIN-08` | Currency conversion uses a dated source/rate snapshot and explicit rounding policy. |

## 5. Logistics

| ID | Invariant |
|---|---|
| `BR-LOG-01` | Each physical movement is one shipment leg with one origin and destination; two-leg delivery is never collapsed into one shipment. |
| `BR-LOG-02` | Shipment quantities cannot exceed released, available quantities without an explicit discrepancy workflow. |
| `BR-LOG-03` | Customer dispatch requires quality release, commercial release, correct address, and required statutory documents. |
| `BR-LOG-04` | Receiving shortage/damage creates a hold and exception; it does not silently reduce ordered quantity. |
| `BR-LOG-05` | POD and receiving acceptance are different evidence at different custody boundaries. |

## 6. Authorization and confidentiality

| ID | Invariant |
|---|---|
| `BR-AUTH-01` | Authorization is deny-by-default and checked server-side for every object operation. |
| `BR-AUTH-02` | Role alone is insufficient; organization, relationship, audience, state, NDA, and approval limit are evaluated. |
| `BR-AUTH-03` | A platform administrator has configuration authority, not automatic document/commercial access. |
| `BR-AUTH-04` | An actor cannot approve their own above-policy discount, manual reconciliation, or conflicting decision. |
| `BR-AUTH-05` | Suspension/revocation affects new access immediately and invalidates active sessions/signed download grants as designed. |
| `BR-AUTH-06` | Internal content is selected by allowlist for external output; labels alone are not trusted. |

## 7. State, audit, and concurrency

| ID | Invariant |
|---|---|
| `BR-SYS-01` | No public generic status mutation exists. A named command owns each transition. |
| `BR-SYS-02` | A critical command atomically writes aggregate state, audit event, and outbox event. |
| `BR-SYS-03` | Every mutable aggregate uses optimistic concurrency/version checks. |
| `BR-SYS-04` | Retried commands with the same actor, operation, and idempotency key return the original semantic result. |
| `BR-SYS-05` | Audit events are append-only and include actor, organization, action, subject, before/after reference, reason, time, and correlation ID. |
| `BR-SYS-06` | Consumers tolerate duplicate and out-of-order events using event identity, aggregate version, and reconciliation. |
| `BR-SYS-07` | Deadlines store an instant and declared business timezone/rules when calendar semantics matter. |

## 8. Example invariant transaction: accept customer quote

Within one PostgreSQL transaction:

1. Lock/read the quote aggregate and idempotency record.
2. Return prior response if this key already completed.
3. Verify quote version is sent, current, unexpired, and not superseded.
4. Verify actor membership, approval authority, and organization relationship.
5. Verify exact quote hash/terms acknowledged by request.
6. Insert immutable acceptance evidence.
7. Transition quote to accepted using expected aggregate version.
8. Create sales-order and contract snapshots.
9. Append audit event.
10. Append outbox event.
11. Commit; publish asynchronously after commit.

If any condition fails, none of steps 6–10 persist.
