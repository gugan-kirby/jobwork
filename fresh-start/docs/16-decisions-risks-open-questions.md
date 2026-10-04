# Decisions, risks, and open questions

## 1. Decision policy

The source specification gives a strong architectural direction but does not legally or operationally resolve every product rule. Decisions below require an accountable owner, evidence, date, and approved option. The application snapshots the resulting policy version where it affects contracts, releases, tax, quality, or retention.

Do not bury open decisions in code defaults.

## 2. Client decision gates

| ID | Decision needed | Recommended launch default | Why it matters / blocker |
|---|---|---|---|
| `D-01` | Geography and tax scope | India-only; one JobWork legal entity and INR first | Determines identity, tax, invoice, payment, address, retention, and provider design. Cross-border multiplies controls. **Pre-build domain configuration gate.** |
| `D-02` | Seller/invoice model | JobWork is principal/reseller on both commercial and warranty responsibility; document precise goods/services flow | Defines contracts, revenue/cost, GST, invoices, title/risk, bill-to/ship-to, returns. **Professional legal/accounting approval required.** |
| `D-03` | Payment model | Licensed gateway/virtual account + bank reconciliation; no stored-value wallet; configurable customer and supplier milestones | Affects regulation, ledger, release gates, refunds, chargebacks, credit, settlement. **Finance architecture gate.** |
| `D-04` | Supplier visibility to customer | Anonymized by default; explicit approved disclosure only when legally/operationally required | Core protection of supplier network and templates/logistics/contact-leak controls. **Authorization/UX gate.** |
| `D-05` | Customer visibility to supplier | Masked by default; release minimum technical/application/site data under NDA and approval | Affects RFQ documents, communication, labels/direct ship, and engineering collaboration. **Authorization/DMS gate.** |
| `D-06` | Quality depth by launch category | Choose one category and define required intake, FAI/inspection, certificates, sampling, NCR/deviation and release | Prevents generic “quality check” that cannot prove conformance. **MVP workflow gate.** |
| `D-07` | Acceptance authority | Organization memberships with amount/scope limits for quote, change, deviation, shipment, delivery; no email-only approval | Defines approval data, segregation and contract evidence. **Identity/workflow gate.** |
| `D-08` | Supplier subcontracting | Prohibited unless declared and approved per operation; downstream identity/capability/evidence tracked | Undeclared subcontracting breaks quality, IP, capacity and traceability. |
| `D-09` | Data retention and legal hold | Class-based schedule for CAD, bid, contract, tax, quality, communication, audit and personal data | Determines storage, deletion, privacy, backups, exports, cost. Professional review needed. |
| `D-10` | Brand promise/liability | Market JobWork only to the level supported by reseller contracts, inspection and warranty SOP | “Guaranteed quality/on-time” changes liability, reserves, customer remedies and operations. |

## 3. Additional product decisions

| ID | Question | Suggested default |
|---|---|---|
| `D-11` | Is customer self-service supplier search in MVP? | Capability/category discovery only; operations selects actual suppliers |
| `D-12` | Are multiple customer quote options allowed? | Yes only as JobWork-created Standard/Fast/Premium offers with separate approved cost lineage |
| `D-13` | May goods direct-ship supplier to customer? | Exception only, approved identity/tax/quality route; default two-leg custody |
| `D-14` | Does JobWork physically inspect every job? | Category/risk-based; release policy explicitly states remote evidence vs JobWork incoming inspection |
| `D-15` | Are customer-owned materials/tooling supported initially? | **Resolved 2026-09-30 by the `job_work` job type (`FR-307`):** supported at intake (material supply recorded, reviewer advisory); custody, receiving and challan accounting arrive with IN-16. Tooling remains deferred. |
| `D-16` | Can awards split across suppliers/operations in MVP? | Data model supports it; UI/operations may initially limit to simple approved routes |
| `D-17` | Is guest browsing allowed? | Public category education only; no sensitive supplier details or transactional actions |
| `D-18` | Which communication channels are authoritative? | In-app thread authoritative; email/SMS/WhatsApp notification/inbound capture only |
| `D-19` | Which files/formats and max sizes are required? | Define per launch category from real jobs; do not use a broad unsafe generic list |
| `D-20` | What are cancellation/refund/warranty matrices? | Define by stage, committed cost, defect/custody, contract and authority before accepting live orders |
| `D-21` | Who owns reference/master data (taxonomy, units, tax codes, carriers) and its change process? | Named business owner per set; versioned, audited edits with effective dating per doc 05 §18; initial seeding decided with `D-06` launch category |

## 4. Technical decisions still to make during inception

| ID | Decision | Selection criteria |
|---|---|---|
| `T-01` | Cloud/managed platform and India region | residency, managed PostgreSQL/object/queue, IAM, backup/DR, cost, team skills |
| `T-02` | Identity provider | OIDC, MFA, organization/SSO path, session revoke, audit, India delivery, cost |
| `T-03` | Payment/bank provider | approved legal model, methods, reconciliation, refunds/disputes, idempotency, sandbox/support |
| `T-04` | Tax/invoice/accounting integration | reviewed applicability, immutable snapshots, correction, reconciliation, availability |
| `T-05` | Carrier aggregator | two-leg/multi-package/returns, webhook quality, labels/POD, serviceability |
| `T-06` | Malware/CAD preview approach | format coverage, sandbox, metadata sanitation, accuracy, licensing, cost |
| `T-07` | Authentication session pattern | web security, mobile/PWA, SSO path, revocation, CSRF/refresh design |
| `T-08` | Authorization enforcement/RLS scope | policy expressiveness, query scoping, testability, operational safety |
| `T-09` | Initial search implementation | dataset size, taxonomy, location, explainability; PostgreSQL default unless measured otherwise |
| `T-10` | Analytics/AI provider policy | CAD/message confidentiality, region, retention/training, human review, contract |

Do not pin framework/provider versions in architecture documents before repository inception; use supported versions at build time and record them in dependency policy/ADRs.

## 5. Assumptions used in this baseline

| ID | Assumption | Validation needed |
|---|---|---|
| `A-01` | JobWork intends the reseller/principal model, not a commission-only marketplace | Legal/accounting confirmation `D-02` |
| `A-02` | Initial users are India-based organizations and operations | `D-01` |
| `A-03` | Customer and supplier contact shielding is a core commercial requirement | Exact release matrix `D-04`/`D-05` |
| `A-04` | Operations will manually review early transactions | Staffing/SLA and pilot plan |
| `A-05` | Web/PWA is acceptable for customer, supplier and operations MVP | User research, device/network constraints |
| `A-06` | PostgreSQL/object storage/managed queue can meet initial load | Volume estimates/performance test |
| `A-07` | JobWork receives goods by default before customer dispatch | Physical sites, SOP, tax/logistics `D-13` |
| `A-08` | Category-specific quality templates can start narrow | Launch category and experts `D-06` |

## 6. Risk register

Scales: probability and impact are Low/Medium/High before mitigation.

| ID | Risk | P | I | Mitigation / decision | Owner |
|---|---|---:|---:|---|---|
| `R-01` | Legal/tax model differs from assumed reseller flow | M | H | Resolve `D-01`–`D-03`; professional opinion; versioned SOP/config; pilot audit | Executive + finance/legal |
| `R-02` | Customer/supplier identity or price leaks | H | H | Separate projections, relationship auth, metadata/label sanitation, negative tests, monitoring | Security + product |
| `R-03` | Wrong drawing revision manufactured | M | H | Immutable files, baselines/transmittals/ack, release guards, change workflow | Engineering |
| `R-04` | Quality workflow too generic for category | H | H | Select narrow category, real control plans/failed jobs, domain UAT, independent release | Quality |
| `R-05` | Operations workload overwhelms team | M | H | Queue/SLA dashboards, controlled supplier/customer pilot, progressive automation | Operations |
| `R-06` | Poor supplier data makes matching unreliable | H | M | Hard eligibility, verification/freshness, confidence/explanations, manual shortlist | Sourcing |
| `R-07` | Payment/provider mismatch or duplicate posting | M | H | Idempotency, ledger, verified callbacks, reconciliation, manual maker-checker | Finance |
| `R-08` | Direct-ship/packaging exposes supplier identity | M | H | Default two-leg; explicit exception approval; label/POD template tests | Logistics/security |
| `R-09` | Malicious/unsafe CAD/Office/ZIP files | M | H | Private quarantine, isolated scanning/conversion, limits, no inline origin | Security/platform |
| `R-10` | Scope attempts to build marketplace + ERP + QMS at once | H | H | Narrow vertical slice, explicit out-of-scope, decision gates, outcome roadmap | Product |
| `R-11` | Native mobile prototype drives premature Android-only build | M | M | Validate workflow/device need; web/PWA first ADR; native after evidence | Product/UX |
| `R-12` | Microservices create distributed inconsistency/slow delivery | M | H | Modular monolith ADR; extraction criteria and module tests | Architecture |
| `R-13` | Internal staff have excessive ambient access | M | H | Function roles, JIT/break-glass, no admin data default, access review/anomaly alerts | Security/operations |
| `R-14` | Cancellation/warranty costs destroy margin | M | H | Stage-based terms, risk reserve, approval, linked supplier recovery, metrics | Commercial/finance |
| `R-15` | Evidence is false/reused/insufficient | M | H | Evidence policies, contextual capture, duplicate flags, corroboration/receiving | Quality |
| `R-16` | Regulatory/retention change invalidates hard-coded behavior | M | H | Professional review, versioned policy/config, immutable snapshots, audit | Legal/finance/product |
| `R-17` | Provider outage blocks production/dispatch | M | M | Async integration, explicit pending/manual fallbacks, reconciliation/runbooks | Platform/ops |
| `R-18` | Backup exists but transaction/files cannot be coherently restored | M | H | PITR/object versioning, recovery reconciliation, quarterly drills | Platform |
| `R-19` | Supplier/customer bypass JobWork outside platform | H | H | Value through quality/payment/accountability, masking/DLP, contracts, controlled collaboration | Business/product |
| `R-20` | Sensitive data enters AI/analytics/logs | M | H | Data inventory/minimization, no unapproved model use, redaction, provider contracts | Privacy/security |

## 7. Research and evidence still needed

- 5–10 anonymized real RFQs from one launch category, including incomplete cases.
- At least two full bid comparison/costing/negotiation histories.
- A post-quote engineering change with scrap/rework impact.
- A failed inspection/NCR/deviation/rework example.
- Supplier-to-JobWork and JobWork-to-customer shipping/tax documents.
- Customer invoice/payment/refund and supplier bill/settlement examples.
- Current org chart, authority thresholds, and segregation constraints.
- Expected monthly/peak users, RFQs, suppliers, files, file sizes, messages and orders.
- Physical receiving/quality capacity and geographic service model.
- Legal/accounting opinions and standard contract/terms/warranty text.

Sensitive examples must be redacted and handled under an approved evidence process.

## 8. Decision record template

```text
Decision ID / title:
Status: proposed | approved | rejected | superseded
Owner / approvers:
Date / effective date:
Context and evidence:
Options considered:
Decision and rationale:
Affected requirements, modules, data and SOP:
Security/privacy/legal/financial consequences:
Migration/rollout/rollback:
Review/expiry trigger:
Supersedes / superseded by:
```

## 9. Immediate workshop agenda

1. Confirm reseller legal/tax/payment model (`D-01`–`D-03`).
2. Draw exact identity/disclosure matrix (`D-04`, `D-05`, direct ship).
3. Select launch category and approve its requirement/quality template (`D-06`).
4. Approve role/authority/segregation matrix (`D-07`).
5. Walk one normal job and four exception jobs end to end.
6. Agree MVP boundary, pilot participants, success metrics, and decision owners.
