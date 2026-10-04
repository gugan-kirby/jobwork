# Product requirements

## 1. Product goal

Enable a customer to procure custom-manufactured work from one accountable commercial partner while JobWork privately sources, contracts, monitors, inspects, receives, and settles suitable suppliers.

## 2. Outcomes by participant

### Customer

- Submit an engineering need without already knowing the correct supplier.
- Receive a clear JobWork commercial commitment with revision, validity, delivery, scope, and quality terms.
- Approve changes and deviations using traceable authority.
- Track a curated, truthful production and delivery timeline.
- Receive conforming goods, statutory documents, warranty, and support from JobWork.

### Supplier

- Receive RFQs matched to verified capability and capacity.
- Quote against an exact requirement snapshot without customer-contact exposure.
- Work from one acknowledged technical baseline.
- Submit production and quality evidence in a repeatable format.
- Receive a clear PO and predictable milestone settlement.

### JobWork operations

- Control supplier relationships, margin, releases, exceptions, and audit evidence.
- See queues and risks rather than manually search chats and email.
- Reconstruct who approved what artifact, version, price, deviation, and shipment.
- Improve supplier selection using closed-loop delivery and quality data.

## 3. Personas

| Persona | Primary jobs |
|---|---|
| Customer requester | Create enquiry, upload requirements, answer clarification |
| Customer approver | Approve quote, change, deviation, and delivery within limits |
| Supplier estimator | Feasibility, assumptions, bid, revision |
| Supplier planner/operator | Plan and report production milestones |
| Supplier quality | Inspection evidence, NCR response, corrective action |
| JobWork sales | Customer relationship and sell-side quotation |
| JobWork sourcing | Supplier eligibility, competition, negotiation, award |
| JobWork engineering | Requirement completeness, feasibility, baseline, change impact |
| JobWork quality | Quality plan, inspection, NCR, deviation, release |
| JobWork finance | Customer receivable, supplier payable, tax documents, reconciliation |
| JobWork logistics | Pickup, receiving, neutralization, dispatch, return |
| Support/dispute operator | Warranty, dispute, refund/rework coordination |
| Platform administrator | Configuration and access; no ambient business-data access |
| Auditor | Read-only, scoped evidence review |

## 4. Functional requirement groups

Requirement identifiers are stable references for design and testing.

### FR-100 Identity and organizations

- `FR-101`: A user can belong to one or more organizations through explicit memberships.
- `FR-102`: Membership roles, approval limits, scope, validity, and suspension are versioned and auditable.
- `FR-103`: Internal users require MFA; organization policy may require customer/supplier MFA.
- `FR-104`: Access is revoked immediately when a user, membership, or organization is suspended.
- `FR-105`: Supplier onboarding stores verification status, evidence, expiry, and reviewer.

### FR-200 Supplier network and matching

- `FR-201`: Supplier profiles describe processes, materials, machines, envelopes, tolerances, capacity, locations, certifications, and service areas.
- `FR-202`: Expired/unverified mandatory capability evidence excludes a supplier from eligible matching.
- `FR-203`: Customer-visible results are anonymized capability cards by default.
- `FR-204`: Matching records inputs, hard-filter reasons, score components, model/configuration version, and selected shortlist.
- `FR-205`: Sponsored/business preference cannot bypass technical or certification eligibility.

### FR-300 Enquiry and RFQ

- `FR-301`: An enquiry supports multiple items, quantities, units, destinations, target dates, and confidential documents.
- `FR-302`: Drafts autosave; submission validates category-dependent mandatory fields.
- `FR-303`: Operations can request structured clarification without changing the submitted requirement silently.
- `FR-304`: An approved enquiry can create multiple sourcing rounds with requirement snapshots.
- `FR-305`: RFQ release grants only intended suppliers access to sanitized document versions.
- `FR-306`: Supplier feasibility, decline reason, assumptions, exclusions, price, lead time, and validity are structured.
- `FR-307`: Every enquiry declares a job type — `job_work` (process on customer-owned goods, CGST Act s.2(68)), `new_model` (new part, material sourced) or `correction_ecn` (change to a part already enquired/ordered) — and who supplies the material. A correction must carry its change reference and description; a related enquiry, if named, is the customer's own. The job type is part of the frozen requirement revision. (Added 2026-09-30.)

### FR-400 Bid, award, and customer quote

- `FR-401`: A submitted supplier-bid version is immutable; revision creates a new version and diff.
- `FR-402`: Bid evaluation normalizes currency, tax treatment, freight, tooling/NRE, quantity, lead time, and risk without altering source bids.
- `FR-403`: Award may split by item, quantity, or operation with explicit routing and approval.
- `FR-404`: Internal cost sheets include source-cost lineage and configurable freight, quality, finance, risk, and margin components.
- `FR-405`: Margin/discount/terms outside policy require approval by a different authorized actor.
- `FR-406`: A customer receives only JobWork customer-quote versions.
- `FR-407`: Acceptance binds exact quote bytes/hash, terms version, actor, organization, authority, time, and idempotency key.

### FR-500 Contract, order, and production

- `FR-501`: Accepted quote creates an immutable sell-side contract snapshot and sales order.
- `FR-502`: Supplier award creates a purchase order referencing the exact bid and baseline.
- `FR-503`: Work packages model one or more suppliers/operations while JobWork owns customer responsibility.
- `FR-504`: Production release requires computed commercial, technical, planning, and compliance gates.
- `FR-505`: Milestones have planned/actual dates, responsible organization, baseline, required evidence, verification, and exception reason.
- `FR-506`: Backdating, reopening, and overrides require explicit permission and audit reason.

### FR-600 Document and engineering control

- `FR-601`: Every uploaded/generated artifact is a logical document with immutable versions, hash, scan state, classification, and audience.
- `FR-602`: Release packages use transmittals with exact version manifests and acknowledgment.
- `FR-603`: A named baseline contains exact approved versions and cannot mutate after release.
- `FR-604`: A post-baseline revision opens a change request; it never replaces production input silently.
- `FR-605`: Change impact covers technical feasibility, affected items/operations, scrap/rework, price, date, quality, and warranty.

### FR-700 Quality

- `FR-701`: Quality plans define characteristics, specifications, method, sampling, stage, and evidence.
- `FR-702`: Measurements retain original and normalized value/unit, instrument, calibration status, inspector, time, and baseline.
- `FR-703`: Failed inspection can open an NCR with containment, severity, affected quantity/lot, owner, and due date.
- `FR-704`: Deviation/concession approval is scoped by characteristic, quantity/serial/lot, period, rationale, and warranty effect.
- `FR-705`: Rework requires an approved plan and reinspection; an NCR cannot close itself circularly.
- `FR-706`: Independent quality release verifies all required evidence and dispositioned issues.

### FR-800 Finance and tax documents

- `FR-801`: Customer receivables and supplier payables are separate schedules and ledger accounts.
- `FR-802`: Money uses currency plus integer minor units; exchange and tax rates are explicit snapshots.
- `FR-803`: Provider callbacks and manual bank matches are idempotent and reconcilable.
- `FR-804`: Issued invoices are immutable; correction uses an authorized credit/debit note.
- `FR-805`: Supplier bill settlement uses PO/receipt/bill matching and tolerance approval.
- `FR-806`: Refund, chargeback, write-off, and payout reversal preserve double-entry balance.

### FR-900 Logistics, acceptance, and support

- `FR-901`: Supplier-to-JobWork and JobWork-to-customer are separate shipment legs.
- `FR-902`: Each shipment supports packages, items/quantities, carrier events, documents, and POD.
- `FR-903`: Incoming receiving records package condition, quantity, identity, weight, photos, shortages, and damage.
- `FR-904`: Dispatch is blocked by quality, payment, document, address, or compliance hold.
- `FR-905`: Delivery acceptance and defect reporting have explicit evidence windows.
- `FR-906`: Returns, rework transport, warranty, carrier claim, refund, and dispute link back to item, lot, baseline, and evidence.

### FR-1000 Communication and platform operations

- `FR-1001`: Messages have explicit audience: internal, customer, supplier, or controlled shared-technical.
- `FR-1002`: Contact leakage detection covers text and supported attachment/metadata channels with human review for uncertain cases.
- `FR-1003`: Email/SMS/WhatsApp are delivery channels; the transaction thread is the system of record.
- `FR-1004`: Critical changes create append-only audit events and transactional outbox events.
- `FR-1005`: Notifications have template version, locale, recipient, consent basis, delivery attempts, and correlation ID.
- `FR-1006`: Configuration, approval policies, tax templates, and workflow templates are versioned.

## 5. Non-functional requirements

| ID | Requirement | Initial target |
|---|---|---|
| `NFR-01` | Availability | 99.9% monthly transactional application; declared disaster events are measured against `NFR-05`/`NFR-06`, not this budget |
| `NFR-02` | Normal API latency | p95 below 500 ms, excluding declared asynchronous operations |
| `NFR-03` | Search latency | p95 below 1.5 s with freshness indicated |
| `NFR-04` | Audit coverage | 100% of listed critical transitions |
| `NFR-05` | RPO | no more than 15 minutes; pursue zero committed DB loss with PITR |
| `NFR-06` | RTO | no more than 2 hours, demonstrated by drills |
| `NFR-07` | Tenant isolation | deny-by-default object authorization and automated cross-tenant suite |
| `NFR-08` | Accessibility | WCAG 2.2 AA target for web interfaces |
| `NFR-09` | Time | UTC storage; declared timezone for deadlines; localized display |
| `NFR-10` | Scale | stateless API horizontal scale; independently scalable workers |
| `NFR-11` | Traceability | correlation from command to data, audit, event, notification, and integration attempt |
| `NFR-12` | Recoverability | quarterly restore/failover exercise with evidence |

## 6. Explicitly out of initial scope

- Stored-value customer wallet.
- Direct unmasked customer-supplier chat or payment.
- Native mobile apps before PWA/field-use evidence justifies them.
- Automated instant CAD pricing.
- Full ERP/MRP or machine-control replacement.
- General-purpose public supplier directory with contact disclosure.
- Microservices or event sourcing as default architecture.
- AI making final engineering, award, deviation, or quality-release decisions.

## 7. Product success measures

- Median enquiry-to-first-qualified-quote time.
- Percentage of submissions complete without repeated clarification.
- Qualified supplier response rate and bid comparability.
- Quote acceptance rate and gross-margin variance from approved cost sheet.
- On-time technical release, production milestone, and final delivery.
- First-pass yield, NCR rate, quality escapes, rework time, and closure age.
- Payment reconciliation exceptions and supplier settlement timeliness.
- Contact-leakage incidents and cross-tenant authorization failures (target: zero).
- Customer repeat rate and supplier performance trend, segmented by category.

Metrics must not reward unsafe shortcuts. For example, faster dispatch cannot outrank an active quality hold.
