# Runbooks

The doc 12 §12 initial set (F-11.4). Every paging alert in `infra/alerts/` links to one of these; `apps/api/test/alerts-dashboards.spec.ts` fails if a page has no runbook, and `apps/api/test/runbooks.db.spec.ts` runs every SQL block below, read-only, against the migrated schema — so a renamed column breaks the build, not the night.

| Runbook | Alerts that lead here |
|---|---|
| [API latency or error spike](api-latency-error-spike.md) | `ApiDown`, `ApiErrorRateHigh`, `ApiLatencyHigh`, `RateLimitStoreDegraded`, `RateLimitingSustained` |
| [Database pressure](database-pressure.md) | `DatabasePoolSaturated` |
| [Outbox backlog or poison message](outbox-backlog-poison-message.md) | `OutboxBacklogAging`, `WorkerDown`, `OutboxDeadLetters`, `OutboxLagObjectiveMissed`, `WorkerSweepFailing` |
| [Payment callback mismatch or provider outage](payment-callback-mismatch.md) | `PaymentCallbacksRejected`, `ReceiptsInSuspenseAging` |
| [File scan backlog or malware campaign](file-scan-backlog.md) | `FileScanBacklogAging` |
| [Cross-tenant or contact-data exposure](cross-tenant-or-contact-exposure.md) | `ExternalDenialSpike`, `HeldMessagesWaiting`, `HeldMessageSurge` |
| [Object storage failure](object-storage-failure.md) | — (upload/download errors surface in `ApiErrorRateHigh`) |
| [Notification provider failure](notification-provider-failure.md) | `NotificationDeliveryFailing` |
| [Carrier, tax or ERP integration outage](integration-outage.md) | — (integrations arrive in IN-16–IN-18) |
| [Incorrect release and emergency hold](incorrect-release-emergency-hold.md) | — (raised by people, not metrics) |
| [Backup restore and failover](backup-restore-failover.md) | — (declared disaster; drilled in IN-12) |
| [Compromised internal account or secret](compromised-account-or-secret.md) | `SignInFailureSpike`, `LockoutSpike`, `DocumentExportSpike` |

## Rules for every runbook

- **Diagnose with safe queries.** SQL here is read-only and selects counts, ages, ids and types — never names, contact details, amounts, file names or message text (doc 11 §14). Run it through the incident's just-in-time access (`DO-13`), in a read-only transaction: `BEGIN READ ONLY; … ROLLBACK;`.
- **Mitigate through commands.** Every mitigation named here is an audited application command or a configuration change (`DO-14`). A direct `UPDATE` is an incident-process exception with a second person watching and an after-action record.
- **Authority** says who may take each step; **communication owner** says who tells customers and suppliers, and what. Nobody else speaks to them about the incident.
- **Never paste** a query's raw output into chat or a ticket if it holds more than counts and ids (doc 12 §8).
- **After every page:** a short review within two working days — what happened, how it was noticed, what changed — and a correction to this runbook if it misled anyone.

## Business queues

`QueueFallingBehind` is a ticket for the operations lead, not a page: the SLA sweep (F-11.1) has already told each item's owner and then the whole team. Open the queue from **Operations → Queues**, sort by deadline, and either take items, hand them to someone with capacity (reassignment records the reason), or — if a whole day was lost to a holiday nobody declared — publish a calendar version from **Operations → Queues → Service targets** (platform administrator) so deadlines move for everyone.

```sql
-- Overdue items per queue, oldest deadline first.
SELECT queue_key, count(*) AS overdue, min(due_at) AS oldest_due
  FROM platform.queue_assignment
 WHERE status = 'open' AND due_at <= now()
 GROUP BY queue_key
 ORDER BY oldest_due;
```
