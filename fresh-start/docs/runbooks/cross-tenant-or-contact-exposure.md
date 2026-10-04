# Cross-tenant or contact-data exposure suspicion

| | |
|---|---|
| Alerts | `ExternalDenialSpike` (page), `HeldMessageSurge` (ticket), `HeldMessagesWaiting` (ticket); or a report from a customer, supplier or colleague |
| Impact | The product's core promise: a customer never learns a supplier's identity or cost, a supplier never learns the customer's or another supplier's (`BR-*`, doc 03 §3). A suspected breach is treated as real until shown otherwise |
| Authority | Security administrator leads. Revoking sessions, suspending memberships and revoking document grants are theirs; a business owner confirms what the exposed party could have seen |
| Communication owner | Security administrator with legal; nobody tells an affected party anything until they have agreed the words (doc 11 §15 notification/legal escalation) |

## Diagnose

**Enumeration** — refusals by external callers, by route (a 404 for another organization's id is the expected answer, doc 13 §5):

```promql
topk(10, sum by (route, caller, status_code) (rate(http_server_request_duration_seconds_count{caller=~"customer|supplier",status_code=~"403|404"}[10m])))
```

Recent sessions behind the noise — ids and address only:

```sql
SELECT user_id, organization_id, count(*) AS sessions, max(last_seen_at) AS last_seen, count(DISTINCT ip) AS addresses
  FROM iam.session
 WHERE last_seen_at > now() - interval '1 hour' AND revoked_at IS NULL
 GROUP BY user_id, organization_id
 ORDER BY sessions DESC
 LIMIT 20;
```

**What a party could have read** — document access by organization in the window (ids only):

```sql
SELECT organization_id, action, count(*) AS accesses, min(occurred_at) AS first, max(occurred_at) AS last
  FROM dms.access_log
 WHERE occurred_at > now() - interval '1 day'
 GROUP BY organization_id, action
 ORDER BY accesses DESC
 LIMIT 20;
```

**Contact leakage** — held messages and decisions (the review queue shows the flagged text to reviewers; this does not):

```sql
SELECT status, action, count(*) AS reviews, min(created_at) AS oldest
  FROM communication.leakage_review
 GROUP BY status, action
 ORDER BY oldest;
```

The audit trail for one subject or actor, by correlation id from an error report:

```sql
SELECT occurred_at, actor_type, action, subject_type, subject_id
  FROM platform.audit_event
 WHERE correlation_id = '00000000-0000-0000-0000-000000000000'
 ORDER BY occurred_at;
```

## Mitigate

1. **Contain**: suspend the membership or organization behind the activity (**Operations → Organizations**, audited; its sessions end at once). For a single document, revoke its audience grant.
2. **Preserve evidence**: export the audit window for the actor and subjects before anything is changed further (audit is append-only; nothing is lost by waiting to delete).
3. **Held messages**: review them in **Operations → Held messages** — release, release an edited copy, or reject. A surge from one party is a deliberate attempt to go around JobWork; tell the account owner.
4. If data did cross a boundary: list exactly which records, which fields, to whom, when — from audit and access logs, not from memory.

## Verify recovery

External refusal rate back to its band; no further access by the contained party (sessions revoked, `iam.session` shows none live); held-message queue back under five.

## After the incident

A review within two working days naming the control that failed (query filter, projection, template, export). Add the missing case to `apps/api/test/cross-tenant-matrix.api.spec.ts`.
