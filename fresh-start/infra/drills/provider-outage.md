# Provider-outage drill

Doc 12 §3 lists what JobWork must do while a dependency is gone. `provider-outage.sh` takes away one dependency at a time on the local stack, probes the required behaviour, restores it and times the recovery.

## Run it

```bash
pnpm stack:up && pnpm -r build
# API on :4000 and a worker running (apps/worker: node dist/main.js)
bash infra/drills/provider-outage.sh
```

It changes development data only: one or two customer messages, two small uploads, and, for case D, a payment of the oldest open invoice of `buyer@demo.local`. It signs in once and reuses the session, so the run is not cut short by the sign-in rate limit.

## Cases

| Case | Taken away | Doc 12 §3 requirement | Probed |
|---|---|---|---|
| A | The worker | Outbox retains work; nothing claims a side effect completed | A customer message commits; its event stays `pending` with no worker; once the worker restarts the event is `delivered`, timed |
| B | The object store | Metadata remains; upload, download and release blocked; no database corruption | Sign-in and reads still work; an upload is refused without recording a document version; after restart the same upload succeeds |
| C | Redis | Degrade rate-limit convenience safely; core truth stays in the database | Sign-in, reads and a command work with Redis stopped (the limiter falls back to per-process counters); reads after it returns |
| D | The payment provider's callback | Payment stays pending; no false capture; retry or reconcile | An intent opens; with no callback the invoice stays unpaid; past its expiry the reconcile sweep expires it and the invoice is still unpaid; a capture arriving late is recorded, never dropped |

Case D needs an open invoice. When none is left, issue one from a sales order: operations, the sales order page, then "Issue" on an installment.

## Not covered here

| Dependency | Why not | Where it is covered |
|---|---|---|
| Notification provider (email) | Only the file mailer exists until a provider is chosen | Worker notification tests: delivery failures retry from the outbox |
| Carrier, tax/ERP, search projection, read replica | Not built in Phase 1 | Phase 2 increments (IN-16 to IN-18) |
| Database | A database outage is a restore case | `restore-drill.md`; `database-resilience.spec.ts` covers connections the server ends |
