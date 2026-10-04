# Delivery roadmap

## 1. Delivery principle

Build one controlled end-to-end vertical slice before broad category coverage or automation. Immutable versions, baseline control, relationship authorization, audit/outbox, decimal money/measurements, and release gates are foundation work—not later hardening.

Durations are indicative and require team size, design readiness, provider/legal decisions, and acceptance capacity.

## 2. Phase 0: operating-model discovery (2–3 weeks)

### Objectives

- Resolve client decisions `D-01`–`D-10` (`D-01`–`D-07` block implementation start; `D-08`–`D-10` block pilot launch).
- Map real SOPs using anonymized completed and failed jobs.
- Select one launch category/process and a small controlled supplier set.
- Confirm JobWork legal entity/reseller contracts, tax/invoice/shipment and payment model with professionals.
- Define authority matrix, category intake, quality plan, change/NCR/deviation, finance/logistics SOP.
- Prototype five difficult UX journeys from `14-ux-screen-map.md`.

### Deliverables

- Approved domain language and status/action map.
- Business process and exception maps.
- Data classification/retention/identity-disclosure matrix.
- Initial architecture decisions and threat model.
- Prioritized requirements and acceptance scenarios.
- Provider selection criteria; no premature integration commitment.

### Exit gate

Product owner, operations, engineering/quality, finance, and legal/accounting owners approve the controlled MVP scope and unresolved risks have named owners/dates.

## 3. Foundation increment (2–3 weeks, overlaps early MVP)

- Monorepo, environments, CI/CD, infrastructure baseline.
- Identity, organizations, memberships, role/policy skeleton, MFA for internal.
- PostgreSQL migrations, transaction conventions, IDs/time/money/measurement types.
- Audit/outbox/idempotency/correlation and worker skeleton.
- Private object-storage upload quarantine/scan interface.
- Shared design system, API contracts, observability, test kit.
- Cross-tenant authorization harness and seed scenarios.

Exit: one secure audited command and one scanned document flow work end to end in staging.

## 4. Phase 1: controlled sourcing and commerce MVP (10–14 weeks total including foundation)

### Vertical slices

1. Supplier onboarding, verification, capabilities, certifications.
2. Customer organization and structured enquiry/file intake.
3. Operations triage and clarification.
4. Supplier matching hard filters, shortlist, masked RFQ release.
5. Supplier feasibility and immutable bid versions.
6. Internal bid comparison, award, cost-sheet versions/approval.
7. JobWork customer quote versions, approval, send, acceptance.
8. Basic payment intent/reconciliation and customer invoice integration boundary.
9. Sales order, supplier PO, contract snapshots.
10. Minimal technical baseline, transmittal, and supplier acknowledgment — required because a PO references an exact baseline (`FR-502`) and work cannot start without acknowledgment (`BR-ENG-07`).
11. Basic production plan/milestone evidence, minimal computed release gate, and customer timeline.
12. Communication/notifications with audience and leakage review baseline.
13. Audit explorer and operational queues.

### MVP constraints

- Operations manually reviews every enquiry, shortlist, award, and quote.
- One currency/geography/category configuration unless decisions require more.
- Small number of provider integrations; manual controlled fallback exists.
- No wallet, public contacts, direct party chat, or auto-award.

### Exit gate

At least several internal/pilot jobs complete sourcing-to-PO with exact version/audit trace; authorization and money/revision concurrency tests pass; users approve usability.

## 5. Phase 2: production, quality, and delivery control (8–12 weeks)

- Full production release gate and work-package routing (extends the Phase 1 minimal gate and baseline machinery).
- Engineering change and commercial impact.
- Category quality plan, measurements, instruments/calibration.
- Inspection, FAI/trial, NCR, deviation, rework, corrective action, quality release.
- Supplier-to-JobWork shipment, receiving/discrepancy.
- JobWork-to-customer shipment, POD, acceptance.
- Supplier bill/settlement with match and holds.
- Returns/warranty/dispute and linked financial/physical resolution.
- Operations command center, risk/critical-path projections, SLO dashboards/runbooks.

Exit: controlled pilot completes the full enquiry-to-customer-acceptance path, including at least one change and NCR drill, restore drill, and production security assessment.

## 6. Phase 3: scale and automation (continuous)

- Matching relevance, score confidence, shortlist diversity.
- Capacity planning and ETA risk.
- ERP/accounting/logistics/tax automation and reconciliation.
- Advanced APQP/PPAP/customer quality templates.
- Offline/field PWA improvements; native app only if justified.
- Analytics warehouse and governed operational insights.
- Search service/file worker/service extraction only for proven hotspots.
- Multi-region/currency/language/category expansion after legal/operating model.

## 7. Recommended first epics

| Priority | Epic | Why first |
|---|---|---|
| P0 | Identity/organization/relationship authorization | Every artifact depends on correct party boundary |
| P0 | Audit/outbox/idempotency/concurrency foundation | Prevents untraceable and duplicate critical actions |
| P0 | DMS upload/version/audience | RFQ cannot be safe without document control |
| P0 | Enquiry/triage/RFQ snapshot | Establishes technical source |
| P0 | Immutable bid/cost/quote chain | Encodes the reseller business model |
| P0 | Acceptance/contract/order snapshots | Creates contractual truth |
| P1 | Baseline/transmittal/production release | Prevents wrong-revision manufacturing |
| P1 | Quality/NCR/release | Prevents unsafe shipment |
| P1 | Two-leg receiving/logistics | Encodes physical middleman control |
| P1 | Ledger/reconciliation/settlement | Encodes independent money obligations |

## 8. Team capabilities

Minimum cross-functional ownership should cover:

- product/business analysis with manufacturing procurement;
- UX/product design for dense operations and external portals;
- backend/domain and PostgreSQL expertise;
- web/PWA frontend;
- platform/DevOps/observability;
- QA automation/security testing;
- JobWork sourcing, engineering, quality, finance, and logistics subject-matter owners;
- external legal/tax/accounting/security advice at required gates.

One person can cover multiple engineering roles initially, but domain approval duties in the product must still remain separate.

## 9. Backlog slicing rule

Slice by valuable workflow, not database table. A story is incomplete without authorization, audit, error/retry, observability, and tests.

Example slice:

```text
“Supplier submits a bid version against RFQ baseline”
includes supplier relationship auth, exact RFQ version, line validation,
immutable persistence, diff lineage, audit/outbox, deadline race,
customer-data exclusion, notification, API/UI and tests.
```

## 10. Release environments

- Local/test with synthetic data and provider fakes.
- Shared development integration.
- Staging production-like with sandbox providers and anonymized UAT scenarios.
- Production isolated account/network/data/secrets.
- Optional pilot tenant/feature gates inside production with strict data and rollback plan.

## 11. Production-readiness checklist

- Client/legal/accounting decision gates approved and configured.
- Critical workflow and exception UAT complete.
- Cross-tenant/role/approval negative test suite passes.
- Immutable quote/baseline/invoice/audit behavior verified.
- Payment/logistics/tax provider reconciliation tested.
- Backup/restore and provider outage drills pass RPO/RTO.
- Monitoring, alerts, runbooks, on-call and incident contacts active.
- Accessibility and performance targets met for launch journeys.
- Data migration/seed/supplier onboarding verified.
- Support, dispute, cancellation, refund, and manual fallback SOPs trained.
- No unresolved critical/high security defect without executive risk acceptance.

## 12. “Not ready” conditions

Do not call the platform production-ready if any of these is true:

- supplier bid can be edited after submission;
- customer can see buy-side identity/cost or directly pay/message supplier by default;
- manufacturing can start without exact baseline and release evidence;
- dispatch can bypass unresolved quality/payment/document holds through generic status change;
- payment retries can duplicate ledger/capture;
- cross-tenant access suite is absent;
- audit/outbox can diverge from business mutation;
- backup restoration is assumed but untested;
- legal/tax/invoice/payment responsibilities remain ambiguous.
