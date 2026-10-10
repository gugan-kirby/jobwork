# Requirements traceability

## 1. Purpose

This matrix connects source intent to design modules, invariants, workflows, tests, and roadmap. It prevents a visually complete application from omitting the middleman, version, quality, security, and accounting controls that define JobWork.

Beyond `FR`/`NFR`/`BR`, later baseline documents mint their own testable rule families: `AUTH-*` ([authentication design](20-authentication-identity-design.md)), `DS-*` ([design system](21-design-system-ui-foundations.md)), `ES-*` ([engineering standards](22-engineering-standards.md)), and `DO-*` ([DevOps](23-devops-cicd-environments.md)). They trace through the same verification machinery: `AUTH-*` lands in the doc 20 §13 negative suite under `FR-100`, `DS-*` in the accessibility/UX suites (doc 13 §12), and `ES-*`/`DO-*` in CI gates (doc 13 §14, doc 23 §4).

## 2. Functional traceability

| Requirement group | Source specification | Primary module(s) | Core rule/workflow | Verification | Phase |
|---|---|---|---|---|---|
| `FR-100` Identity/organizations | Sections 3, 11 | IAM, platform | `BR-AUTH-*`, `AUTH-*` (doc 20); role/approval model | auth matrix, doc 20 §13 suite, session revoke, SoD tests | Foundation/1 |
| `FR-200` Supplier network/matching | 5.1, 8, 9, 10 | Supplier, sourcing | hard filter before rank; DSA §§2–3 | eligibility/ranking properties, search perf | 1/3 |
| `FR-300` Enquiry/RFQ | 4, 5.2–5.3, UC-01–23 | Sourcing, DMS, comms | enquiry/RFQ state machines; `BR-ENG-02/08` | incomplete/conflict/no-bid E2E | 1 |
| `FR-400` Bid/award/quote | 1.2, 5.3–5.4, UC-14/15/23–25 | Sourcing, commercial | `BR-COM-*`; quote state machine | immutable versions, expiry race, margin approval | 1 |
| `FR-500` Order/production | 4, 5.5, UC-16/17/26 | Orders, commercial, DMS | production release gate; `BR-OPS-*` | illegal transition/gate/milestone tests | 1/2 |
| `FR-600` Document/change | 7.1–7.2, UC-03/26/27 | DMS, engineering | `BR-ENG-*`; baseline/change state | malicious file, wrong revision, change E2E | Foundation/2 |
| `FR-700` Quality | 2, 5.5, 7.3, UC-18/19/28/29 | Quality, orders, DMS | `BR-QLT-*`; inspection/NCR/deviation | decimals/units, failed FAI/rework/deviation E2E | 2 |
| `FR-800` Finance | 5.4, 5.7, UC-07/30/31 | Finance, commercial | `BR-FIN-*`; payment/settlement state | ledger properties, duplicate webhook/reconcile | 1/2 |
| `FR-900` Logistics/support | 5.8, UC-20/32–34 | Logistics, quality, finance | `BR-LOG-*`; two-leg state | partial/damage/hold/POD/return E2E | 2 |
| `FR-1000` Communication/platform | 5.6, 9, 11, UC-38–40 | Comms, platform, all | `BR-SYS-*`, audience/leakage | internal leak, retry/outbox/audit tests | Foundation/1 |

## 3. Non-functional traceability

| ID | Architecture/control | Evidence |
|---|---|---|
| `NFR-01` availability | Managed deployment, graceful dependency behavior, SLO | synthetic critical journeys, monthly SLI |
| `NFR-02` API latency | Stateless API, indexed queries, async heavy work | route-level load tests and traces |
| `NFR-03` search latency | Search projection, FTS/trigram/PostGIS initially | representative supplier dataset benchmark |
| `NFR-04` audit coverage | Command inventory writes append-only audit atomically | mutation/audit inventory test |
| `NFR-05` RPO | PostgreSQL PITR, object versioning, outbox reconciliation | quarterly restore evidence |
| `NFR-06` RTO | Runbooks, infra automation, recovery test | timed disaster exercise |
| `NFR-07` tenant isolation | RBAC + relationship/attributes, scoped queries, optional RLS | generated cross-tenant negative suite |
| `NFR-08` accessibility | WCAG 2.2 AA design/test plan | automated + manual role journeys |
| `NFR-09` time | UTC instant + declared timezone/calendar version | boundary/timezone tests |
| `NFR-10` scale | API/worker horizontal scale, DB measurement-first path | saturation/capacity test |
| `NFR-11` traceability | correlation/causation across command/audit/outbox/provider | trace drill on critical journey |
| `NFR-12` recoverability | backup/restore/provider reconciliation | signed drill report/action closure |

## 4. Business-invariant ownership

| Rule family | Code owner | Database support | Independent acceptance owner |
|---|---|---|---|
| `BR-COM-*` | Sourcing/commercial modules | immutable version/unique/foreign-key constraints | Product + sales/finance |
| `BR-ENG-*` | DMS/engineering | hashes, immutable manifest, exact FK | Engineering/quality |
| `BR-OPS-*` | Orders/production | aggregate version, release snapshots | Operations |
| `BR-QLT-*` | Quality | scoped deviation/result/release constraints | Quality/customer policy owner |
| `BR-FIN-*` | Finance | balanced journal/unique provider/allocation constraints | Finance/accounting |
| `BR-LOG-*` | Logistics | leg/package/item/quantity relationships | Logistics/quality/finance |
| `BR-AUTH-*` | IAM + each domain | tenant/relationship constraints, optional RLS | Security/data owner |
| `BR-SYS-*` | Platform + each domain | transactions, audit/outbox/idempotency/version | Architecture/security/operations |

## 5. Source use-case coverage

| Source UC range | Coverage location |
|---|---|
| `UC-01`–`UC-09` customer | Product `FR-200/300/400/700/800/900`; customer UX; workflow E2E |
| `UC-10`–`UC-20` supplier | Product `FR-100/200/300/400/500/700/900`; supplier UX |
| `UC-21`–`UC-27` sourcing/sales/engineering | Ops UX, sourcing/commercial/change workflows |
| `UC-28`–`UC-34` quality/finance/logistics/support | Quality, finance/logistics docs and Phase 2 workflows |
| `UC-35`–`UC-37` admin/auditor | Role model, platform module, audit/security tests |
| `UC-38`–`UC-40` system automation/security | API/outbox, reliability, file/leakage threat model |

## 6. Critical end-to-end acceptance map

| Scenario | Requirements/rules proven |
|---|---|
| Two suppliers quote; customer gets one JobWork quote | `FR-300/400`, `BR-COM-01`–`10`, identity boundary |
| Customer names a target; JobWork offers a fixed supplier price and sets the customer price; the supplier sees neither the customer nor its prices | `FR-305`, `FR-308`, `FR-408`, `FR-409`, `BR-COM-05`, identity boundary; pilot scenario 13 (F-FP) |
| Accepted quote concurrently expires/supersedes | `FR-407`, `BR-SYS-03/04`, quote state/DB uniqueness |
| New drawing arrives after production starts | `FR-600`, `BR-ENG-03`–`07`, change workflow |
| Failed measurement accepted under scoped deviation | `FR-700`, `BR-QLT-01`–`06`, authority/quality evidence |
| Duplicate delayed payment webhook | `FR-800`, `BR-FIN-02/05`, inbox/idempotency/reconciliation |
| Supplier shipment is short/damaged | `FR-900`, `BR-LOG-01`–`05`, receiving hold/claim |
| Customer attempts to fetch supplier bid/contact | `FR-1000`, `BR-AUTH-*`, projection and negative tests |
| Employee suspended mid-job | `FR-104`, `BR-AUTH-05`, session/file revoke tests |
| Notification fails after committed quote | `FR-1004/1005`, `BR-SYS-02/06`, outbox/retry/UI truth |
| Restore after failure with pending provider events | `NFR-05/06/11/12`, DR reconciliation drill |

## 7. Change-control rule

Any new feature/change must update:

1. Requirement ID and acceptance criteria.
2. Relevant business invariant or explicit statement that none changes.
3. Data owner, version/retention and authorization audience.
4. Workflow command/state/guard and error codes.
5. Audit/outbox/integration contract.
6. Test scenario and observability/runbook.
7. Roadmap/release decision and ADR if architecture materially changes.

Traceability is reviewed during refinement and release; it is not a one-time document.
