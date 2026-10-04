# Restore drill

Doc 12 §9: a quarterly drill measures RPO and RTO and leaves evidence and action items. `restore.sh` runs the drill end to end. This page explains each step, what passes, and what changes in production.

## Run it

```bash
pnpm stack:up                      # postgres, redis, object store
pnpm -r build                      # the drill boots apps/api/dist against the copy
bash infra/drills/restore.sh       # SOURCE_DB=jobwork_dev TARGET_DB=jobwork_restore_drill
DRILL_HASH_SAMPLE=all bash infra/drills/restore.sh   # every clean file, not ten
```

It never writes to the source database. The restored copy is left in place for inspection. Drop it with `dropdb jobwork_restore_drill`.

## Steps and pass criteria

| # | Step (doc 12 §9) | Passes when |
|---|---|---|
| 1 | Snapshot | `pg_dump -Fc` completes; size and time recorded |
| 2 | Isolated restore | `pg_restore` into a fresh database with no errors |
| 3 | Consistency and migration version | Same migration count and latest migration as the source; same row counts in the ten tables that carry money, quantity, files, audit and outbox; a restored bid version still refuses an edit (triggers came back) |
| 4 | File references and hashes | Each sampled clean file's bytes in the clean bucket hash to the digest on its row. Demo-seed rows (`clean/demo-…`) are inserted without bytes and are counted separately |
| 5 | Audit, outbox, unpublished work | Audit count and newest event listed; outbox events not yet delivered listed by type. The worker resumes them; nothing is re-sent by hand |
| 6 | Providers, sessions, callbacks | Open payment intents and suspense money listed for reconciliation with the provider; every restored session revoked, so everyone signs in again |
| 7 | Critical journey | An API booted on the copy serves the customer's enquiries, orders and quotations and the sourcing queue, and a download through a fresh grant hashes to the restored row |

The summary prints the measured time from snapshot to green journey.

## What changes in production (T-01)

| Here | Production |
|---|---|
| `pg_dump` of the live database | Provider snapshot plus point-in-time recovery to the chosen instant; RPO is the gap to that instant (objective ≤ 15 minutes) |
| Restore into another database on the same server | Restore into an isolated environment with no route to providers |
| Revoke sessions in SQL | Same; then rotate the session secret if the incident involved credentials |
| Provider callbacks never paused | Pause callback ingress, reconcile the window in step 6 against the provider's own records, then re-enable |
| Synthetic journey with seed accounts | A dedicated synthetic customer and staff account whose credentials live in the secret store |

## When a step fails

A failed step fails the drill; the evidence file records it with an action item and an owner. A missing or altered file object is an incident in production. The document version is withdrawn, and its owner is asked for the file again.
