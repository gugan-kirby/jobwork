# Glossary

| Term | Meaning in JobWork |
|---|---|
| ABAC | Attribute-based access control using facts such as classification, geography, amount, NDA or state. |
| Acceptance | Immutable evidence that an authorized actor agreed to an exact quote/delivery/other subject version. |
| Aggregate | Consistency boundary whose invariants are protected together by commands and transaction/version. |
| APQP | Advanced Product Quality Planning; an automotive quality planning approach enabled only when required. |
| Audience grant | Explicit permission for a party/relationship to access a specific document version/action. |
| Audit event | Append-only attributable record of a critical business/security action; different from an application log. |
| Award | JobWork decision selecting one or more exact supplier bid lines/versions for quantity/operation. |
| Baseline | Immutable named manifest of exact document versions approved for a purpose such as RFQ, production or inspection. |
| Bid | Supplier's buy-side commercial/feasibility offer to JobWork; never customer-visible by default. |
| Bill | Supplier commercial/tax claim payable by JobWork; distinct from customer invoice. |
| Buy side | Supplier-to-JobWork commercial leg: RFQ, bid, award, PO, bill, settlement. |
| CAPA | Corrective and preventive action following root-cause analysis and verification. |
| Characteristic | A quality requirement to inspect, with specification, method, sampling and evidence. |
| Clarification | Versioned question/answer that resolves ambiguity without silently changing scope. |
| Configuration | The controlled technical definition of the product/work, including exact revisions and relationships. |
| Concession/deviation | Scoped temporary authorization to accept known non-conformance; it does not change the specification/result. |
| Contract snapshot | Immutable copy/hash of accepted commercial scope, terms, parties and referenced technical package. |
| Correction / ECN | Enquiry job type: a correction or engineering change to a part already enquired or ordered, carrying the customer's change reference (ECN — Engineering Change Notice, the communicated approved change) and what changed; lineage to the corrected enquiry, never an edit of it (`FR-307`, `BR-ENG-09`). |
| Corrective action | Action addressing root cause, with implementation and effectiveness evidence. |
| Cost sheet | JobWork-only landed-cost, risk, finance and margin scenario derived from selected supplier input. |
| Customer quote | JobWork's sell-side commercial offer to customer; independent from supplier bid. |
| DFM | Design for manufacturability/feasibility analysis. |
| DMS | Document management system for immutable files, versions, audience, release and retention. |
| Evidence | Uploaded/recorded fact supporting progress or quality; evidence alone may still require verification. |
| FAI | First Article Inspection before continuing/accepting production as configured. |
| Hard eligibility | Mandatory supplier requirement that cannot be compensated by a high ranking score. |
| Hold | Explicit blocker preventing a scoped release/action until resolved or authorized. |
| Idempotency | Repeating the same command/key has one semantic effect and returns the original result. |
| Inspection | Planned execution of quality checks against exact characteristic/baseline. |
| JobWork | Middleman/reseller and accountable customer-facing commercial party in this product model. |
| Legal hold | Retention override preventing destruction of defined records/documents. |
| Middleman | JobWork's operational role controlling identity, sourcing, commercial, quality, payment and delivery handoffs. |
| Job type | What kind of work an enquiry asks for: job work, new model, or correction/ECN (`FR-307`). First question of the wizard; part of the frozen requirement. |
| Job work | Enquiry job type: a treatment or process on goods the customer owns (CGST Act s.2(68)); the customer is the principal, normally supplies the material under a delivery challan and files ITC-04. JobWork and the supplier add process, not material. |
| New model | Enquiry job type: a part JobWork has not made for this customer before — new part development from drawings; material is sourced by JobWork. First-article inspection is the suggested default. |
| Milestone | Planned production/operations step with evidence and verification policy. |
| NCR | Non-Conformance Report describing failed requirement, affected scope, containment, disposition and closure. |
| NRE | Non-recurring engineering/tooling/setup cost. |
| Outbox | Event-intent rows written atomically with business transaction and delivered asynchronously. |
| P2P/direct marketplace | Customer and supplier directly transact; explicitly not JobWork's default model. |
| PWA | Progressive Web App providing installable/mobile-friendly web capability. |
| PPAP | Production Part Approval Process, configurable for jobs requiring automotive quality evidence. |
| Principal/reseller | JobWork buys from supplier and sells to customer in two contractual legs. |
| Production release | Authorized command confirming commercial, technical, plan and compliance gates for work start. |
| Purchase order (PO) | JobWork's buy-side commitment to an awarded supplier, referencing exact bid/baseline. |
| Quality release | Independent decision that required evidence is complete and all issues are dispositioned for scoped quantity. |
| ReBAC | Relationship-based access control, e.g. invited supplier to a particular RFQ. |
| Receiving | Custody/quantity/condition verification after a shipment carrier reports delivery. |
| Reconciliation | Comparison of internal records with provider/bank/carrier/accounting truth to resolve missing/duplicate/ambiguous events. |
| Revision label | Customer/engineering identifier such as A or 01; separate from system version. |
| RFQ | Request for quotation released by JobWork to selected suppliers against an exact requirement snapshot. |
| RLS | PostgreSQL row-level security, optional defense-in-depth for tenant isolation. |
| RPO | Maximum acceptable data-loss interval in recovery. |
| RTO | Maximum target time to restore priority service. |
| Sales order | Sell-side order created from accepted JobWork customer quote. |
| Sell side | JobWork-to-customer commercial leg: quote, acceptance, sales order, invoice, payment, warranty. |
| Segregation of duties | Rule preventing conflicting initiation/approval/reconciliation/release by one actor. |
| Settlement | JobWork's payment of an eligible supplier payable; distinct from customer payment. |
| SLA | Service-level rule for response/action deadlines and escalation. |
| SLO | Measurable service reliability objective such as availability or latency. |
| Supplier | Manufacturing/service organization selling to JobWork; preferred term over vendor in product/domain. |
| Technical release | Approval of an exact baseline for specified use. |
| Tenant | Organization/security boundary; not all records are owned by only one tenant, so relationships matter. |
| Three-way match | Supplier PO, received goods/evidence, and supplier bill comparison before settlement. |
| Transactional outbox | See Outbox; prevents business commit and notification/event intent from diverging. |
| Transmittal | Formal released package manifest of exact document versions to recipients with acknowledgment. |
| Work package | Supplier/operation/quantity execution unit linking PO, route, baseline, milestones, quality and custody. |
