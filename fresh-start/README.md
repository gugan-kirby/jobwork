# JobWork fresh start

Status: **implementation in progress** — walking skeleton, identity, and platform spine complete (IN-00–IN-02, the roadmap foundation exit); see the [build plan](docs/build-plan/README.md) for live status  
Baseline date: 2026-09-01 (engineering baseline extended 2026-09-02; implementation started 2026-09-02)  
Working product name: JobWork

JobWork is a managed B2B custom-manufacturing procurement platform. It is not a supplier phone directory and it is not a direct customer-to-supplier marketplace. JobWork is the accountable middleman and commercial reseller:

```text
Supplier --sells to--> JobWork --sells to--> Customer
```

The platform controls requirement intake, sourcing, technical release, commercial quotation, production evidence, quality decisions, two-leg logistics, payment, settlement, and disputes. Customer and supplier identities, contacts, raw quotations, and delivery details are disclosed only through explicit policy.

## Source material

| Source | SHA-256 | How it is used |
|---|---|---|
| `JobWork_Production_Grade_Product_and_Architecture_Specification_v1.docx` | `4f05470209f954803540f052e5c118ef324ae52879f2bdf469f46b983c0022f7` | Product and architecture source of truth for this analysis |
| `../JobWork_UI_Prototype.png` | `e3bda34444f8958250fc9d93fc0f094077b9f648449039fa5593d772ee71bb9e` | Sixteen-screen UI concept; evidence of intent, not an approved transaction model |

The DOCX was read completely, including its two embedded diagrams. No code or database schema has been generated from assumptions hidden outside these sources.

## Documentation map

Read in this order for implementation:

1. [Deep source analysis](docs/00-source-analysis.md)
2. [Product requirements](docs/01-product-requirements.md)
3. [Business rules and invariants](docs/02-business-rules-and-invariants.md)
4. [Roles, permissions, and approvals](docs/03-roles-permissions-approvals.md)
5. [System architecture](docs/04-system-architecture.md)
6. [Data and DBMS design](docs/05-data-model-dbms.md)
7. [Workflows and state machines](docs/06-workflows-state-machines.md)
8. [Data structures and algorithms](docs/07-dsa-algorithms.md)
9. [API and event contracts](docs/08-api-events-integrations.md)
10. [Documents, engineering change, and quality](docs/09-documents-engineering-quality.md)
11. [Finance, tax, and logistics](docs/10-finance-tax-logistics.md)
12. [Security, privacy, and threat model](docs/11-security-privacy-threat-model.md)
13. [Authentication, session, and identity design](docs/20-authentication-identity-design.md)
14. [Reliability and observability](docs/12-reliability-observability.md)
15. [Testing strategy](docs/13-testing-strategy.md)
16. [UX and screen map](docs/14-ux-screen-map.md)
17. [Design system and UI foundations](docs/21-design-system-ui-foundations.md)
18. [Delivery roadmap](docs/15-roadmap.md)
19. [Implementation plan](docs/24-implementation-plan.md)
    - [Build plan (file-level, per functionality)](docs/build-plan/README.md)
20. [Engineering standards and repository playbook](docs/22-engineering-standards.md)
21. [DevOps, CI/CD, and environments](docs/23-devops-cicd-environments.md)
22. [Decisions, risks, and open questions](docs/16-decisions-risks-open-questions.md)
23. [Requirements traceability](docs/17-requirements-traceability.md)
24. [Glossary](docs/18-glossary.md)
25. [Use cases and edge cases](docs/19-use-cases-edge-cases.md)
26. [Architecture decision records](docs/adr/README.md)

## Non-negotiable product invariants

- A submitted supplier bid is never edited; a revision is a new immutable version.
- Supplier cost, JobWork's internal cost/margin, and the customer quote are different records with different visibility.
- Accepted quotes, issued purchase orders, invoices, and approvals are immutable snapshots.
- Production and inspection reference a named baseline containing exact document versions and hashes; never a floating “latest file.”
- Customer and supplier communicate through policy-controlled, auditable threads.
- Customer money and supplier settlement are independent obligations recorded in a ledger; a customer payment is not a direct supplier payment.
- Supplier-to-JobWork and JobWork-to-customer are separate shipments with separate release gates.
- No generic “update status” endpoint exists. Named commands validate authority, state, and business preconditions.
- Every critical mutation writes business data, an audit event, and an outbox event atomically.

## Current gate

Before implementation begins, the client must resolve decisions `D-01` through `D-07` in [Decisions, risks, and open questions](docs/16-decisions-risks-open-questions.md); `D-08`–`D-10` must be resolved before pilot launch. The proposed implementation can otherwise begin with safe defaults documented in the ADRs.
