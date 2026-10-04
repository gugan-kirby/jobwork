# Payment callback mismatch or provider outage

| | |
|---|---|
| Alerts | `PaymentCallbacksRejected` (page), `ReceiptsInSuspenseAging` (ticket) |
| Impact | The provider may hold money JobWork has not recorded; an order may wait for an advance the customer already paid. Never a false capture: a payment is recorded only from a verified callback or reconciliation (doc 08 §11) |
| Authority | Finance (`jobwork_finance`): allocate receipts in suspense, with a second finance approval above threshold (maker-checker). Platform on-call: provider credentials and webhook secret rotation |
| Communication owner | JobWork finance, to the affected customers only, once the amount is known |

## Diagnose

Callback outcomes in the last day — `rejected` means a failed signature, a stale timestamp or an unknown provider:

```sql
SELECT provider, outcome, signature_ok, count(*) AS callbacks, max(received_at) AS latest
  FROM finance.webhook_receipt
 WHERE received_at > now() - interval '1 day'
 GROUP BY provider, outcome, signature_ok
 ORDER BY latest DESC;
```

```promql
sum by (status_code) (rate(http_server_request_duration_seconds_count{route="/api/v1/webhooks/payments/:provider"}[10m]))
```

Intents still open past their expiry (the reconcile sweep closes them):

```sql
SELECT status, count(*) AS intents, min(expires_at) AS oldest_expiry
  FROM finance.payment_intent
 WHERE status NOT IN ('captured', 'expired', 'failed', 'cancelled')
 GROUP BY status;
```

Receipts in suspense, oldest first (ids and age; the amount is visible to finance on the screen, not here):

```sql
SELECT id, provider, received_at, now() - received_at AS waiting
  FROM finance.payment_transaction
 WHERE status = 'suspense'
 ORDER BY received_at
 LIMIT 50;
```

## Mitigate

| Cause | Action |
|---|---|
| All callbacks rejected after a secret rotation | Restore the previous secret alongside the new one (rotation keeps an overlap window, doc 08 §10); the provider retries. Never disable signature checking |
| Provider outage | Nothing to fix on JobWork's side: intents stay pending, orders stay held (no false release). The reconcile sweep catches up when callbacks resume; tell finance which window to reconcile against the provider's settlement report |
| Receipts in suspense | **Operations → Finance**: allocate each to its invoice; a second finance user approves above the threshold |
| Duplicate or out-of-order callbacks | Expected: deliveries are claimed by provider event id, so a duplicate is acknowledged and changes nothing |

## Verify recovery

No rejected callback for 30 minutes; payment reconcile sweep succeeding; no receipt in suspense older than four hours.

```promql
time() - max(jobwork_worker_sweep_last_success_timestamp_seconds{sweep="payment_reconcile"})
```

## After the incident

Finance reconciles the incident window against the provider's report and records the result; any amount that moved without a callback is named in the review.
