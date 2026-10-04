# Reliability and observability

## 1. Reliability goals

| Signal | Launch objective | Measurement boundary |
|---|---|---|
| Transactional availability | 99.9% monthly | Authenticated API operations needed for core workflow |
| Normal API latency | p95 under 500 ms | Excludes documented file/search/export async work |
| Supplier search latency | p95 under 1.5 s | Includes filter/rank projection query, reports freshness |
| Critical event enqueue | p95 under 30 s | Commit to durable outbox/queue, not provider delivery |
| Audit coverage | 100% critical commands | Verified by command/event inventory tests |
| Recovery point | no more than 15 minutes | DB plus ability to reconcile outbox/providers/files |
| Recovery time | no more than 2 hours | Demonstrated restoration of priority workflow |

Targets become formal SLOs only after traffic definitions, maintenance policy, and measurement tooling are approved. Provider delivery uptime is measured separately from JobWork enqueue/processing.

The availability objective and the recovery-time objective are deliberately separate measurements: a declared disaster event is judged against RPO/RTO and the drill evidence, not against the 43-minute monthly availability budget (a single 2-hour RTO-compliant recovery would otherwise consume ~2.8 months of budget). The SLO policy document must state this exclusion explicitly, along with what qualifies as a declared event and who declares it.

## 2. Critical user journeys

Monitor separately:

- authenticate and load action queue;
- create/submit enquiry;
- release RFQ and supplier access package;
- submit bid version;
- issue and accept customer quote;
- capture/reconcile payment;
- release baseline and production;
- submit/verify milestone and inspection;
- authorize quality/shipment release;
- upload/download authorized files;
- process provider webhook and notification.

Synthetic checks use non-production-safe test tenants/data and never exercise real money/shipment accidentally.

## 3. Failure design

| Dependency failure | Required behavior |
|---|---|
| Payment provider down | Order/payment remains pending; no false capture; retry/reconcile; alternate approved method if configured |
| Notification provider down | Transaction commits; durable retry; UI remains source of truth; visible delivery status |
| Carrier API down | Shipment creation/tracking pending; manual reference path; reconcile later |
| File scanner backlog | Upload remains quarantined; no release; expose processing delay |
| Search projection stale | Show freshness; allow controlled exact/internal fallback; never weaken eligibility/security |
| Redis down | Degrade cache/rate convenience safely; core truth remains DB; protect DB from stampede |
| Queue down | Outbox retains work; alert/backpressure; do not claim side effect completed |
| Object storage down | Metadata remains; block upload/download/release; no DB corruption |
| Read replica lag | Route strong-consistency reads to primary; expose no stale acceptance/release decision |
| Tax/ERP integration down | Place item in explicit pending/manual-review state; never fabricate statutory success |

## 4. Timeout, retry, and circuit rules

- Every external request has connect/read/overall timeouts.
- Retry only transient and idempotent operations; use provider idempotency key where possible.
- Exponential backoff with jitter and cap.
- Per-provider circuit breaker/concurrency budget prevents cascade.
- Long retry queues expose age/attempt/error and controlled replay.
- User-visible request timeout does not imply command failure; query by idempotency/operation ID.
- Unknown outcomes enter reconciliation, not blind repeat.

## 5. Backpressure

- Bounded upload size/count and organization quotas.
- Separate worker pools/queues for file conversion, notifications, provider callbacks, exports, scoring, and critical financial jobs.
- Priority protects payment/audit/security operations from bulk preview/export jobs.
- Queue-age and DB-connection saturation trigger autoscale/load shedding.
- Nonessential analytics/indexing may pause; transactional writes and authorization cannot.

## 6. Observability model

### Logs

Structured, redacted events with `timestamp`, `level`, `service`, `module`, `environment`, `operation`, `outcome`, `duration_ms`, `correlation_id`, `trace_id`, safe actor/org identifiers, aggregate type/id/version, and stable error code.

### Metrics

- RED: request rate, error rate, duration by route/operation and caller type.
- USE: utilization, saturation, errors for CPU, memory, connections, queue workers, storage.
- Domain: queue age, conversion/scanning, provider callbacks, command failures, concurrency conflicts, outbox age.
- Business-control: untriaged enquiry, quote approval, blocked releases, open NCR, payment mismatch, shipment exceptions.

Keep high-cardinality IDs out of metric labels.

### Traces

Propagate trace/correlation context from edge through API, DB spans, outbox causation, worker, and integration attempt. Do not put sensitive payloads in spans.

### Audit

Audit is a separate durable business/security record, not derived from observability logs.

## 7. Operational dashboards

### Platform

- availability/latency/error budget;
- API/worker deploy version and error regression;
- DB connections/locks/slow queries/replication/PITR health;
- queue/outbox age, retries, dead letters;
- file scan/conversion backlog;
- provider latency/error/circuit state;
- object-storage errors and signed-download failures.

### Operations

- enquiry triage and clarification age;
- RFQ response deadline/no-response;
- bid evaluation/quote approval backlog;
- production variance/critical-path risk;
- unacknowledged baseline/change/transmittal;
- inspection/quality hold/NCR/corrective action age;
- payment/unapplied cash/bill match/settlement exception;
- shipment delay/receiving discrepancy/missing document;
- support/warranty/dispute SLA.

### Security

- authentication/MFA/reset anomalies;
- cross-tenant authorization denials and suspicious enumeration;
- malware/leakage detections;
- sensitive download/export spikes;
- role/config/break-glass changes;
- webhook signature/replay failures;
- secret/dependency vulnerability and patch status.

## 8. Alert quality

Every page-worthy alert has owner, user/business impact, threshold/window, deduplication, severity, runbook, and recovery signal. Prefer symptom/SLO alerts over noisy single-instance metrics. Ticket-level alerts cover slow business queues; paging covers active material impact or security risk.

Alerts must avoid exposing customer/supplier/file/payment data in chat/pager payloads.

## 9. Backup and disaster recovery

- PostgreSQL automated snapshots plus point-in-time recovery; encrypted and access-controlled.
- Object versioning/replication/lifecycle aligned to DB retention.
- Configuration, infrastructure definitions, schemas/migrations, templates, and key metadata included.
- Cross-zone and, if approved, cross-region copies with data-residency review.
- Restoration uses an isolated environment and integrity/reconciliation checks.
- Quarterly restore drills measure RPO/RTO and produce evidence/action items.

Restore validation:

1. Database consistency and migration version.
2. File-object references exist and hashes sample-verify.
3. Audit/outbox sequence and unpublished work identified.
4. Provider transactions/webhooks reconciled for recovery window.
5. Search/cache projections rebuilt.
6. Sessions/secrets and external callbacks safely re-enabled.
7. Critical journey synthetic tests pass.

## 10. Deployment reliability

- Immutable build artifacts and environment-specific configuration.
- Automated migration compatibility check and backup readiness.
- Expand/migrate/contract schema changes.
- Health/readiness probes distinguish process alive from ready.
- Progressive rollout/canary for risky changes and rapid reversible application rollback.
- Feature flags have owner, purpose, expiry, safe default, and audit.
- Workers handle old/new event versions through rollout window.
- Provider callbacks remain compatible during deployment.

## 11. Capacity planning

Track transaction/file volumes by enquiry, RFQ invites, bids, messages, document bytes/versions, previews, inspection results, audit/outbox, notifications, and carrier events. Load tests model bursts around RFQ deadlines and large file packages, not only average requests.

Scale stateless API/workers first. Add read replicas/search service/partitioning only after measurements. Database connection pool, indexes, queue partitioning, and file-worker resource isolation are likely earlier bottlenecks than API CPU.

## 12. Initial runbook set

- API latency/error spike.
- Database connection/lock/storage pressure.
- Outbox/queue backlog or poison message.
- Payment callback mismatch/provider outage.
- File scan backlog/malware campaign.
- Cross-tenant or contact-data exposure suspicion.
- Object storage upload/download failure.
- Notification/provider failure.
- Carrier/tax/ERP integration outage.
- Incorrect release/dispatch and emergency hold.
- Backup restore/failover.
- Compromised internal account/secret.

Runbooks include safe diagnostic queries, mitigation, authority, customer communication owner, recovery verification, and post-incident review.
