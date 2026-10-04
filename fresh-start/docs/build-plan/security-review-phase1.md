# Phase 1 security review (IN-12 F-12.3)

Review of the Phase 1 build against doc 11 §16, the security release gates, dated 2026-10-05. This is the engineering team's own review: it collects evidence, fixes what the code can fix, and names what only the owner, an external tester or a qualified professional can close. It is not an independent assessment. The external penetration test (gate 9) is that.

**Method.** Each gate was checked against running tests, source and configuration, not against intentions. Every finding found during IN-12 (F-12.1 scenarios and this review) is listed with its fix or its owner. The threat model below is doc 11 §4 applied to each Phase 1 workflow.

## 1. Release gates (doc 11 §16)

| # | Gate | Status | Evidence | Closes with |
|---|---|---|---|---|
| 1 | Threat model reviewed for each major workflow | Done for Phase 1 | §2 below | Re-review per new workflow in Phase 2 |
| 2 | Authorization matrix and cross-tenant negative suite passing | Passing | `cross-tenant-matrix.api.spec.ts` (every read probe answers a real id as it answers an invented one), `sourcing-negative`, `dms-negative`, `pilot/scenario-12`. CI on every PR, again by name in the nightly | — |
| 3 | High/critical findings resolved or formally risk-accepted | Resolved in code; two highs fixed in this review | §3 | Owner reviews the open mediums |
| 4 | Upload/preview isolation verified with adversarial corpus | Upload: verified. Preview: not applicable yet | Worker `scan.spec.ts` corpus (nothing unsafe ever returns clean; timeouts and crashes quarantine, never guess clean); `dms-scan` (only the service principal may record a verdict); downloads are short-TTL grants with a forced `attachment` disposition (`packages/object-store/src/client.ts`) | Re-run when a preview or conversion pipeline exists |
| 5 | MFA and privileged access operational | MFA: operational. Just-in-time elevation: not built | Every internal command requires a password+TOTP session (`requireTransactionalStrength`; `iam-auth` suite); recovery codes; sessions revoked on enrolment and suspension; separation of duties on approvals (`APPROVAL_SEPARATION`; pilot 3, 9) | Finding 7 |
| 6 | Secrets, deploy, backups and restores tested | Partly | Production refuses public secrets (finding 1, `production-config.spec.ts`); frozen lockfile; CI images pinned by digest. Restores: F-12.2 | F-12.2 drills; secret store with T-01 |
| 7 | Audit coverage verified for all critical commands | Verified | `audit-coverage.spec.ts`: 89 executor commands each return an audit row on their working path; 21 direct audit writes all inside their transaction (the writer's client parameter is a transaction client by type); the inventory is a reviewed snapshot (`test/__snapshots__/audit-inventory.txt`) | — |
| 8 | Incident contacts and runbooks exercised | Runbooks: written and their queries tested. Contacts: none named | `docs/runbooks/` (F-11.4), SQL blocks executed by `runbooks.db.spec.ts`; every paging alert names its runbook (`alerts-dashboards.spec.ts`) | F-12.2 exercises two; owner names contacts (finding 12) |
| 9 | External penetration test before material transaction volume | Not started | — | Owner commissions it before real money (finding 10) |
| 10 | Privacy, contract, payment, tax and retention decisions approved by professionals | Not started | Doc 10 §1 and doc 11 §13 state the dependency | Owner (finding 13) |

## 2. Threat model per Phase 1 workflow

Threat names are doc 11 §4's rows.

| Workflow | Threats that apply | Controls in place | Evidence | Residual |
|---|---|---|---|---|
| Enquiry intake and documents | Malicious upload; broken object authorization; identity leakage | Quarantine → isolated scan → clean bucket; size, type and digest checks; customer-owned documents only; grants per audience | `dms-upload`, `dms-scan`, `dms-negative`, worker `scan.spec.ts`; pilot 2 (customer's words never reach suppliers) | Preview isolation when previews arrive |
| Sourcing: RFQ, bids, revisions | Broken object authorization; identity leakage; tampered evidence; late or altered bids | Relationship-scoped queries; supplier sees only its own invitation and bid; bid versions immutable by trigger; superseded rounds take no bids or award | `sourcing-negative`, `rfq-bids`, `bid-immutability.db.spec.ts`; pilots 1, 3, 5 | — |
| Award, cost sheet, quote | Margin leakage; tampered approval; approval by the wrong person | Separate internal and customer projections; approval policy versions with authority snapshots; proposer cannot approve; single-source needs a second sourcing lead | `commercial.api.spec.ts`; `quote-immutability.db.spec.ts`; pilots 1, 3, 4 | — |
| Acceptance and orders | Duplicate/replay; tampered acceptance; acceptance beyond authority | Acceptance binds version, content hash and terms hash; idempotency keys; one acceptance per offer set (unique index); customer approval limits | `orders-payments`, `finance-constraints.db.spec.ts`; pilot 1 (replay), pilot 4 (simultaneous acceptance) | — |
| Payments | Duplicate/replay; forged callback; unmatched money | HMAC signature with timestamp window; delivery-id and transaction-id uniqueness; suspense with maker-checker allocation | `orders-payments`; pilot 9 | Re-verify the scheme with the real provider (T-03) |
| Identity and administration | Account takeover; insider misuse; unrecorded suspension | MFA; lockout and rate limits; session inventory and revocation; suspension needs a reason, audited in its transaction | `iam-auth`, `rate-limit.api.spec.ts`, `operations-admin`; pilot 12 | Just-in-time elevation (finding 7) |
| Communication and notifications | Notification leak; contact exchange | Audience-scoped threads; templates allowlist their variables; contact-leakage detector holds messages for review | `communication`, `notifications` ("sends nothing when a template reaches outside its allowlist"), `leakage.spec.ts` | — |
| All | Injection/SSRF | Every query parameterized; SQL text interpolates only constant fragments (lock clauses, column lists, typed table names) — checked in this review | Source review, 2026-10-05 | — |
| All | Availability attack | Rate limits per operation class (Redis-backed); upload size and scan time limits; outbox backpressure; database blips no longer crash the processes (finding 4) | `rate-limit.api.spec.ts`, `database-resilience.spec.ts` | Capacity measured in F-12.4 |
| All | Supply-chain compromise | Frozen lockfile; nightly high/critical dependency audit (ES-30); CI service images pinned by digest; no credentials in the repository (scanned 2026-10-05) | `.github/workflows/ci.yml`, `infra/nightly.sh` | Repository secret-scanning settings (finding 6) |
| Monitoring | Enumeration; credential stuffing; mass export | `ExternalDenialSpike`, `SignInFailureSpike`, `DocumentExportSpike` alerts with runbooks; refusals by route, status and caller on the security dashboard | `infra/alerts/security.yaml`, `infra/dashboards/security.json` | — |

## 3. Findings

Severity is the impact if exploited in production. "Fixed" means the fix is merged with a regression test.

| # | Severity | Finding | Status |
|---|---|---|---|
| 1 | High | In production the API and worker would start on the service-token, payment-webhook and session secrets this public repository ships as defaults. Anyone could then mint a worker token (for example, record a malicious upload as clean) or forge a payment callback | Fixed in this review: `productionConfigProblems` (`@jobwork/service-auth`) refuses public values, short secrets, dev object-store credentials and the localhost database |
| 2 | High | Nine state changes wrote their audit row after their transaction committed. A failed audit write would leave the change without a record (`BR-SYS-02`) | Fixed in this review. Organizations, sites, invitations, profile, organization switch, MFA enrolment and upload rejection now commit audit with the change; `AuditWriter.write` takes only a transaction client |
| 3 | Medium | A user or membership could be suspended with no recorded reason (`BR-SYS-05`) | Fixed, PR #9 |
| 4 | Medium | A database restart or failover ending idle pooled connections would crash the API and worker (unhandled pool error) | Fixed, PR #11 |
| 5 | Medium (integrity) | Bid freight and tooling/NRE never reached the award, cost sheet or PO, so margin was overstated and the PO under-committed | Fixed, PR #7 |
| 6 | Medium | Secret scanning and push protection on the public GitHub repository could not be confirmed with the build token | Owner: confirm both are on in the repository settings |
| 7 | Medium | Doc 11 §4 asks for just-in-time access and a reason on staff document export. Staff access is role-based with MFA and a mass-download alert, but there is no time-boxed elevation | Owner: build in Phase 2 or risk-accept for the pilot, with the alert as the compensating control |
| 8 | Low | Clarification answers reach suppliers only when engineering transcribes them (the customer's own words never do: verified, pilot 2) | Accepted as designed |
| 9 | Low | Secrets live in environment variables; doc 20 §9 prefers a secret store and workload identity | With T-01 (hosting selection) |
| 10 | — | External penetration test | Owner, before material transaction volume |
| 11 | — | Payment callback scheme proven only against the simulated gateway | Re-verify with the real provider (T-03) |
| 12 | — | No named incident contacts or on-call roster for the runbooks | Owner |
| 13 | — | Privacy, contract, payment, tax and retention decisions | Owner, with counsel and a chartered accountant |

## 4. Verdict

No high or critical finding is open in the code. Phase 1 may run its pilot on non-production infrastructure with test money. Before real customers, real money or real drawings, the owner closes or formally accepts findings 6, 7 and 10–13, and F-12.2 records a passing restore drill.
