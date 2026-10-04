# Notification provider failure

| | |
|---|---|
| Alerts | `NotificationDeliveryFailing` (ticket) |
| Impact | People are not e-mailed about work. The in-app feed and the records are the source of truth (`D-18`), so nothing is wrong — only late to be noticed |
| Authority | Platform on-call: provider credentials, sender configuration |
| Communication owner | JobWork support, only if delivery is down for more than a working hour: a banner in both apps |

## Diagnose

Delivery attempts in the last hour, by outcome:

```sql
SELECT channel, status, error_code, count(*) AS attempts, max(attempted_at) AS latest
  FROM communication.delivery_attempt
 WHERE attempted_at > now() - interval '1 hour'
 GROUP BY channel, status, error_code
 ORDER BY attempts DESC;
```

Attempts stuck `sending` (a worker died mid-send; the next dispatch closes them as `outcome_unknown`):

```sql
SELECT count(*) AS stuck, min(attempted_at) AS oldest
  FROM communication.delivery_attempt
 WHERE status = 'sending' AND attempted_at < now() - interval '15 minutes';
```

```promql
max by (state) (jobwork_notification_deliveries)
```

## Mitigate

- Provider down: wait; deliveries retry with backoff through the outbox. Do not re-send by hand — each delivery has a stable id, and a manual mail would be a duplicate the user cannot tell apart.
- Credentials or sender rejected: fix the configuration and restart the worker; failed deliveries for events still within the retry budget are attempted again; for older ones, replay the dead letters ([outbox runbook](outbox-backlog-poison-message.md)) — a notification is created once per event and recipient, so a replay never doubles it.

## Verify recovery

No failed attempt in the last hour; stuck count zero.

## After the incident

If e-mail was down for more than a working day, support decides whether to post a summary in the apps of what people may have missed.
