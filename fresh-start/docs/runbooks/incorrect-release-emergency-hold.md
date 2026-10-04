# Incorrect release and emergency hold

| | |
|---|---|
| Alerts | None: raised by a person — a wrong baseline went to a supplier, production started on the wrong revision, a customer's credit is in question, work started without release |
| Impact | Parts made to the wrong drawing, money owed without cover, or work done outside the contract. Speed matters: every hour of production on a wrong baseline is scrap |
| Authority | Engineering: baselines and transmittals. Sourcing and quality: work-package containment. Finance: credit holds. Quality (IN-15) and logistics (IN-17): release and dispatch holds when they exist. Each acts through their own command; nobody edits a released record (released baselines are frozen by trigger) |
| Communication owner | Sourcing, to the supplier; sales, to the customer — after engineering confirms what is affected |

## Diagnose

Work packages released or in production on an order, with the baseline they were released against (`release_snapshot` holds it):

```sql
SELECT w.id, w.number, w.status, w.released_at, w.release_snapshot -> 'baseline' ->> 'number' AS baseline_number
  FROM orders.work_package w
 WHERE w.status IN ('released', 'in_production')
 ORDER BY w.released_at DESC
 LIMIT 50;
```

Transmittals issued and whether the supplier acknowledged:

```sql
SELECT id, number, status, issued_at, acknowledged_at, superseded_by_transmittal_id
  FROM dms.transmittal
 ORDER BY issued_at DESC NULLS LAST
 LIMIT 50;
```

Containment recorded and its disposition:

```sql
SELECT id, purchase_order_id, work_package_id, kind, reported_at, disposition, disposed_at
  FROM orders.containment_event
 ORDER BY reported_at DESC
 LIMIT 50;
```

Credit holds in force:

```sql
SELECT id, customer_organization_id, placed_at
  FROM finance.credit_hold
 WHERE released_at IS NULL
 ORDER BY placed_at;
```

## Mitigate

1. **Stop the work**: record containment on the purchase order (**Operations → Orders → Production**, `POST /purchase-orders/{id}/containment`) — it is audited and visible to the supplier.
2. **Correct the baseline**: release a new baseline version and issue a new transmittal; the old one is superseded, never edited (`ADR-0003`). The supplier must acknowledge the new one before production resumes.
3. **Money**: place a credit hold (`POST /api/v1/finance/credit/{organizationId}/holds`, finance); the commercial gate then holds release for that customer until finance releases it with a reason.
4. Tell the supplier through the purchase order's conversation, not by phone alone — the thread is the record (`D-18`).

## Verify recovery

Every affected work package is contained or re-released against the corrected baseline; the new transmittal is acknowledged; the hold is released with a reason, or stays with an owner.

## After the incident

Quantify the scrap or exposure; review which gate should have stopped it (doc 06 §§7–8 release gates) and add the failing case to that gate's tests.
