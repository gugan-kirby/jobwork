# Database connection, lock or storage pressure

| | |
|---|---|
| Alerts | `DatabasePoolSaturated` (page); usually seen first as `ApiLatencyHigh` |
| Impact | Every request slows; commands time out. PostgreSQL is the system of record — protect it before anything else (doc 12 §3) |
| Authority | Platform on-call: cancel a runaway query, restart an API instance, pause the worker. Terminating a backend that holds a transaction rolls that command back in full — safe by design, but say so in the incident log |
| Communication owner | JobWork support |

## Diagnose

Connections by state and the longest-running statements (no query text: it can carry values):

```sql
SELECT state, count(*) AS connections, max(now() - xact_start) AS longest_transaction
  FROM pg_stat_activity
 WHERE datname = current_database()
 GROUP BY state
 ORDER BY connections DESC;
```

```sql
SELECT pid, state, wait_event_type, wait_event, now() - query_start AS running_for, backend_type
  FROM pg_stat_activity
 WHERE datname = current_database() AND state <> 'idle'
 ORDER BY query_start
 LIMIT 20;
```

Who blocks whom:

```sql
SELECT blocked.pid AS blocked_pid, blocking.pid AS blocking_pid,
       now() - blocked.query_start AS blocked_for, blocking.state AS blocking_state
  FROM pg_stat_activity blocked
  JOIN pg_stat_activity blocking ON blocking.pid = ANY (pg_blocking_pids(blocked.pid))
 WHERE blocked.datname = current_database();
```

Storage — the append-only tables grow fastest:

```sql
SELECT n.nspname || '.' || c.relname AS relation, pg_size_pretty(pg_total_relation_size(c.oid)) AS size
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind = 'r' AND n.nspname IN ('platform', 'dms', 'communication', 'finance', 'orders', 'sourcing', 'commercial', 'supplier', 'iam')
 ORDER BY pg_total_relation_size(c.oid) DESC
 LIMIT 10;
```

```promql
max by (state) (jobwork_db_pool_connections)
```

## Mitigate

1. A single long transaction blocking others: cancel it (`pg_cancel_backend(pid)`); terminate (`pg_terminate_backend`) only if cancel does not end it. Record the pid and duration, not the query text.
2. Pool exhaustion across instances: scale API instances *down* if the database is the limit — more instances means more connections. Each instance holds at most 10.
3. Pause the worker (stop its process) to shed sweep and outbox load; nothing is lost — the outbox keeps the work.
4. Storage near its limit: expand the volume; never delete audit or outbox rows to make room (`BR-SYS-05`).

## Verify recovery

No waiting pool clients for 10 minutes; no transaction older than 30 seconds; API p95 back under 400 ms.

## After the incident

Identify the query or command; add the missing index or batching (`ES-19`) through a normal migration.
