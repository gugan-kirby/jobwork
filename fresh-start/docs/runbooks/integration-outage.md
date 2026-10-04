# Carrier, tax or ERP integration outage

| | |
|---|---|
| Alerts | None yet: carrier, e-way bill/e-invoice and ERP integrations arrive with IN-16–IN-18 (`T-0x` provider decisions). This runbook fixes the behaviour they must be built to |
| Impact | Shipment creation or tracking, statutory documents, or accounting sync are pending — never fabricated (doc 12 §3) |
| Authority | Platform on-call for the connection; finance for statutory documents; logistics for shipments |
| Communication owner | The owning team, to the affected customer or supplier |

## Required behaviour (doc 12 §3, doc 08 §§11–12)

| Integration down | JobWork must |
|---|---|
| Carrier | Keep shipment creation and tracking pending; allow a manual reference with a reason; reconcile when the API returns. A carrier's "delivered" is never treated as receipt |
| Tax / e-invoice / e-way bill | Place the document in an explicit pending or manual-review state; never mark a statutory document generated without the authority's acknowledgement |
| ERP | Queue the sync; the JobWork ledger stays the record until reconciled |

## Diagnose

Integration callbacks are claimed like payment callbacks; until those integrations exist, the shape to read is the payment one:

```sql
SELECT provider, outcome, count(*) AS callbacks, max(received_at) AS latest
  FROM finance.webhook_receipt
 WHERE received_at > now() - interval '1 day'
 GROUP BY provider, outcome;
```

## Mitigate

Follow the required behaviour above; reconcile the outage window against the provider's records when it returns, and record the reconciliation.

## Verify recovery

Every item left pending during the outage is reconciled — confirmed or corrected against the provider's own record — and none stays pending without an owner.

## After the incident

When each integration ships (IN-16–IN-18), this runbook gains its alert, its safe queries and its manual path, and the increment's exit checklist names it.
