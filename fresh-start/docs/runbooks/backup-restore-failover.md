# Backup restore and failover

| | |
|---|---|
| Alerts | None: a declared disaster (data corruption, lost database, region loss), declared by the platform lead. Judged against RPO 15 minutes and RTO 2 hours, not the availability budget (doc 12 §1) |
| Impact | The platform is down or wrong until restored and reconciled |
| Authority | Platform lead declares and runs the restore; finance signs off payment reconciliation; security administrator signs off sessions and secrets before re-enabling access |
| Communication owner | Platform lead with support: a status message at declaration, at restore, and at "consistent" |

The procedure is drilled in IN-12 (F-12.2, `infra/drills/`); the timed drill report is the evidence that these steps work.

## Restore

1. Freeze writes: stop the API and worker; set the web apps' maintenance page.
2. Restore PostgreSQL to a new, isolated instance at the chosen point in time (PITR). Never restore over the damaged instance — it is evidence.
3. Point a single API instance at it with external callbacks disabled, and validate (doc 12 §9):

```sql
-- 1. Migration version: the restored schema is the one the build expects.
SELECT name, applied_at FROM public.schema_migrations ORDER BY name DESC LIMIT 3;
```

```sql
-- 3. Audit and outbox: the last committed work, and what was not yet delivered.
SELECT (SELECT max(occurred_at) FROM platform.audit_event) AS last_audit,
       (SELECT max(occurred_at) FROM platform.outbox_event) AS last_event,
       (SELECT count(*) FROM platform.outbox_event WHERE status IN ('pending', 'processing')) AS undelivered;
```

```sql
-- 2. Files: the newest objects the database knows about, to sample-verify against the store's hashes.
SELECT id, sha256, created_at FROM dms.file_object ORDER BY created_at DESC LIMIT 20;
```

```sql
-- 4. Money in the recovery window, to reconcile with the provider's report.
SELECT provider, status, count(*) AS transactions, min(received_at) AS first, max(received_at) AS last
  FROM finance.payment_transaction
 WHERE received_at > now() - interval '1 day'
 GROUP BY provider, status;
```

4. Reconcile providers for the window between the restore point and the outage: payment captures, webhook deliveries (doc 19 §9 "restore loses external callbacks in window").
5. Rebuild projections: queue stays and SLA deadlines rebuild on the first sweep; nothing else is cached.
6. Re-enable sessions and secrets: rotate the session secret if the incident touched credentials (all users sign in again); re-enable webhooks.
7. Run the critical-journey checks (doc 12 §2) against the restored stack; then lift maintenance.

## Verify recovery

All seven validation steps recorded with times; RPO and RTO measured and written in the incident record.

## After the incident

The review states the measured RPO/RTO against the objectives, and any step that took longer than the drill.
