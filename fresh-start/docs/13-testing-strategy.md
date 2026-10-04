# Testing strategy

## 1. Quality objective

Tests must prove business invariants, authorization boundaries, numerical correctness, concurrency behavior, integration reconciliation, and recoverability—not only page rendering or happy-path CRUD.

The highest-priority automated tests correspond to rules in `02-business-rules-and-invariants.md`.

## 2. Test layers

| Layer | Focus | Typical environment |
|---|---|---|
| Domain unit/property | State guards, price/measurement/score algorithms, invariant logic | In process, deterministic |
| Database integration | Constraints, transactions, locking, migrations, RLS/query scopes | Real PostgreSQL container/database |
| API contract | Validation, authn/authz, errors, idempotency, pagination, compatibility | API plus real DB |
| Module integration | Cross-module command and outbox behavior | API/worker plus DB/queue adapters |
| Browser E2E | Critical participant workflows and accessibility | Production-like stack |
| Provider contract | Gateway/carrier/message/tax adapter and callback schemas | Sandboxes + recorded safe fixtures |
| Security | Object authorization, upload, session, injection, abuse | Isolated test/staging |
| Performance/resilience | Latency, bursts, saturation, retries, failover | Dedicated representative environment |
| UAT | Real anonymized SOP by each role | Staging with approved fixtures |

## 3. Domain tests

Required examples:

- bid/quote/PO/invoice version cannot mutate after submission/issue;
- quote expiry/supersession/acceptance race has one valid winner;
- margin approval and segregation thresholds;
- production/quality/dispatch release guard combinations;
- state machine rejects every illegal edge;
- change cannot replace active baseline silently;
- deviation scope does not exceed authorized quantity/characteristic/expiry;
- NCR rework requires reinspection and independent closure;
- money journals balance and allocations conserve minor units;
- quantity conserved across split award, work, scrap, receipt, shipment, return;
- unit conversion/tolerance handles boundaries and unknown units;
- supplier matching excludes hard failures before scoring;
- deterministic ranking/rounding/hash for same inputs/config version.

Use property-based tests for conservation, bounds, monotonicity, idempotency, and deterministic canonicalization.

## 4. Database tests

- Foreign keys and check/unique/exclusion constraints.
- One accepted quote/valid active relationship/provider transaction as designed.
- Optimistic update conflict with two concurrent connections.
- Idempotency key same payload returns original; different payload conflicts.
- Transaction rolls back business, audit, and outbox together on failure.
- Worker `SKIP LOCKED` claims each outbox task safely under concurrency.
- Immutable-table write restrictions/triggers where adopted.
- Tenant-scoped query and RLS tests, including background job context.
- Migration forward/backward compatibility, rerunnable backfill, and failure rollback/roll-forward.
- Timezone/decimal/currency extremes and high-volume index plans.

## 5. Authorization matrix tests

Generate positive and negative cases across role × organization relationship × resource × action × state × audience × NDA/account status × amount limit.

Mandatory attacks:

- replace top-level and nested IDs with another tenant's IDs;
- use valid document URL after grant revoke/membership suspend;
- enumerate search/export/audit endpoints;
- fetch another supplier's bid or customer cost projection;
- invoke internal command from external role;
- approve own conflicting decision;
- access via notification/deep link after permission loss;
- use stale cache/session or organization-switch context;
- infer existence through status/error/timing differences.

## 6. File-security tests

Maintain a safe adversarial corpus:

- wrong signature/extension/MIME;
- EICAR test sample and scanner failure;
- corrupt/truncated/password-protected/encrypted files;
- nested archive, zip bomb simulation under controlled limits, path traversal names;
- oversized count/dimensions/pages and parser timeout;
- macro/script/active PDF content;
- metadata/contact/signature/QR/EXIF leakage;
- duplicate hash across tenants and revoked derived artifact;
- unauthorized preview/original download and unsafe inline content type.

Verify quarantine is fail-closed and worker compromise cannot access production credentials/network.

## 7. API and event contract tests

- Schema required/optional/unknown fields, enums, decimal serialization, timestamps.
- Stable problem codes and safe cross-tenant errors.
- Cursor stability under inserts/deletes and allowed filters/sorts.
- `If-Match` conflict and retry recovery.
- Event envelope, minimal data, schema compatibility, aggregate version ordering.
- Duplicate/out-of-order/missing event handling and reconciliation.
- Webhook signature/timestamp/replay/body-size and secret rotation.
- Consumer contracts run before event/API breaking changes deploy.

## 8. Workflow E2E scenarios

### Golden path

Customer enquiry → triage → supplier RFQ → two bids → award → cost sheet → customer quote → acceptance/payment → baseline/PO → production milestones → inspection → two shipments → customer acceptance → settlement/closure.

### Mandatory exception paths

- incomplete requirement and multi-round clarification;
- no bid / only one bid / supplier withdraws after selection;
- quote revision and simultaneous expiration/acceptance;
- customer change after production starts with scrap/requote;
- conflicting CAD/drawing blocks baseline;
- failed FAI, NCR, rework, reinspection;
- customer-approved scoped deviation;
- duplicate delayed successful payment webhook after UI timeout;
- partial shipment, receiving shortage/damage, carrier delay;
- customer rejection/warranty/return/refund and supplier recovery;
- membership suspension in the middle of a job;
- notification/provider/worker outage with eventual recovery.

## 9. Numerical test matrix

- Zero/one/large quantities and fractional units where permitted.
- Currency with 0, 2, and 3 minor digits.
- Percentage precision, inclusive/exclusive tax, line versus document rounding.
- NRE/freight allocation with remainder and stable tie-break.
- Partial payments, overpayment, multi-invoice allocation, refund, chargeback.
- Negative/zero margin and threshold boundaries.
- Measurement at lower/upper tolerance, just inside/outside, negative values, offset units, unknown unit.
- Timezone/DST where relevant, date-only tax documents, deadline at expiration instant.

Expected values are independently hand-calculated and reviewed by domain owners.

## 10. Performance tests

Model realistic datasets and access scopes:

- supplier search with structured filters, geography, text and ranking;
- operations queues over many active jobs;
- RFQ deadline burst of concurrent bid submissions;
- quote acceptance/payment callback concurrency;
- large upload initiation/finalization and file-worker backlog;
- inspection grids and audit timeline pagination;
- notification/event burst and provider throttling;
- document export/evidence package without starving transactions.

Capture p50/p95/p99, throughput, errors, saturation, DB query plans/locks, queue age, and recovery after load.

## 11. Resilience and disaster tests

- Kill worker during side effect before/after provider response.
- Duplicate and reorder webhooks/events.
- Pause queue/provider and recover backlog without storm.
- Fail cache and read replica; verify safe fallback.
- Simulate object-store/scanner unavailable; confirm no unsafe release.
- Database failover during command and verify unknown-outcome/idempotency behavior.
- Restore DB/object snapshot and reconcile recovery window.
- Deploy mixed API/worker versions with compatible events/migrations.

## 12. Accessibility and UX tests

- Keyboard-only, logical focus, visible focus, skip/navigation landmarks.
- Screen-reader names, errors, status announcements, dialog focus.
- Color contrast and non-color status cues.
- 200–400% zoom/reflow and mobile/desktop layouts.
- Large tables have accessible alternatives/sticky context.
- File/progress/timeline states are textual, not icon-only.
- Slow/offline/retry behavior avoids duplicate business commands.
- Locale, long text, timezone, currency, and unit display.

## 13. Test data

- Factories generate organizations/relationships intentionally; default factory cannot accidentally cross tenants.
- Synthetic CAD/quality/commercial fixtures contain no real personal/client IP.
- Production data is never copied to developer machines without approved masking.
- Provider fixtures strip tokens, accounts, contacts, and payload secrets.
- Seeded scenarios have stable IDs only in test environments.

## 14. CI/CD gates

On pull request: format/lint/type, unit/property, migration/static security, dependency/secret scan, targeted DB/API tests. On merge/staging: full integration/contract/E2E/accessibility and artifact/container/IaC scanning. Before production: migration rehearsal, smoke, rollback readiness, critical security test, approvals, and release notes.

Nightly/periodic: complete cross-tenant matrix, provider sandbox, performance trend, adversarial file corpus, dependency/container scan, backup restore, and synthetic journeys according to cost/risk.

## 15. Definition of done for a feature

- requirement/rule IDs and acceptance criteria linked;
- authorization and data audience defined;
- state/invariant/error/idempotency behavior implemented;
- audit/outbox/notification impacts defined;
- unit, DB, API, negative-auth, and relevant E2E tests pass;
- observability/dashboard/runbook impact included;
- migration/retention/privacy/accessibility reviewed;
- user/domain owner accepts production-like scenario;
- no unresolved high-risk defect or undocumented override.
