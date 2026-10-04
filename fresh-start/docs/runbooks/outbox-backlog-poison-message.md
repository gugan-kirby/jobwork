# Outbox backlog or poison message

| | |
|---|---|
| Alerts | `OutboxBacklogAging` (page), `WorkerDown` (page), `OutboxDeadLetters` (ticket), `OutboxLagObjectiveMissed` (ticket), `WorkerSweepFailing` (ticket) |
| Impact | Side effects are late: notifications, file scans, deadline and SLA sweeps. Business state is committed and true — screens are right; e-mails and follow-on steps are behind. Nothing is lost: the outbox row stays until handled |
| Authority | Platform on-call: restart the worker. Platform administrator (MFA): replay or dismiss a dead letter, with a reason |
| Communication owner | JobWork support, only if notifications are more than an hour late |

## Diagnose

```promql
max(jobwork_outbox_oldest_pending_age_seconds)
```

```promql
sum by (event_type, outcome) (rate(jobwork_outbox_handled_total[15m]))
```

Backlog by type and state, oldest first — what is stuck and since when:

```sql
SELECT event_type, status, count(*) AS events, min(occurred_at) AS oldest, max(attempts) AS most_attempts
  FROM platform.outbox_event
 WHERE status IN ('pending', 'processing', 'dead')
 GROUP BY event_type, status
 ORDER BY oldest;
```

Dead letters and why (the error, never the payload):

```sql
SELECT id, event_type, aggregate_type, occurred_at, attempts, left(last_error, 160) AS last_error
  FROM platform.outbox_event
 WHERE status = 'dead'
 ORDER BY occurred_at
 LIMIT 50;
```

Rows held by a crashed worker are reclaimed after the visibility timeout; many old `processing` rows mean the worker keeps dying mid-handler:

```sql
SELECT count(*) AS leased, min(locked_at) AS oldest_lease
  FROM platform.outbox_event
 WHERE status = 'processing';
```

## Mitigate

| Cause | Action |
|---|---|
| Worker down | Restart it. On start it reclaims leased rows and drains the backlog; sweeps run on their first tick |
| `no handler registered for …` | A new event type shipped without a subscription. Deploy the worker with the type in `apps/worker/src/outbox/subscriptions.ts` (the subscription test should have caught it), then replay the dead letters |
| A provider failing (mail) | [Notification provider failure](notification-provider-failure.md); retries are automatic with backoff |
| A poison message (handler throws on one event) | Let it dead-letter (it stops blocking others). Fix the handler, then replay. If the step is no longer wanted, dismiss it |

**Replay or dismiss** — **Operations → Health → Events given up on → Resolve**, or `POST /api/v1/operations/dead-letters/{eventId}/replay` and `/dismiss` with `{ "reason": "…" }`. Both are audited (`platform.outbox_replayed`, `platform.outbox_dismissed`); only a dead event moves, so a replay can never double a side effect that is already in flight. A dismissed event is `dismissed`, never `delivered`.

## Verify recovery

Oldest pending event under 60 seconds; dead letters zero or each with a recorded decision; `jobwork_worker_sweeps_total{outcome="ok"}` increasing for every sweep.

```sql
SELECT count(*) FILTER (WHERE status = 'dead') AS dead,
       count(*) FILTER (WHERE status = 'pending' AND occurred_at < now() - interval '1 minute') AS pending_over_a_minute
  FROM platform.outbox_event;
```

## After the incident

For a missing subscription: why did the subscription test not catch it (a new emitter shape the scanner does not read)? Extend the test.
