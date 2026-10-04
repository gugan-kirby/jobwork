# API latency or error spike

| | |
|---|---|
| Alerts | `ApiDown` (page), `ApiErrorRateHigh` (page), `ApiLatencyHigh` (page), `RateLimitStoreDegraded` (ticket), `RateLimitingSustained` (ticket) |
| Impact | Screens fail or crawl; people retry commands (idempotency keys make the retries safe) |
| Authority | Platform on-call: restart, roll back, scale, change `RATE_LIMIT_MODE`. A schema change is never a mitigation |
| Communication owner | JobWork support (`jobwork_support`), using the status message below |

## Diagnose

1. **Platform dashboard** (Grafana → JobWork → Platform): which routes, which callers, since when, and whether the running build changed (*Running builds*).
2. Errors and slowness by route, last 15 minutes:

```promql
topk(10, sum by (route, status_code) (rate(http_server_request_duration_seconds_count{status_code=~"5.."}[15m])))
```

```promql
topk(10, histogram_quantile(0.95, sum by (le, route) (rate(http_server_request_duration_seconds_bucket[15m]))))
```

3. Is the database the bottleneck? Waiting clients mean go to [database pressure](database-pressure.md).

```promql
max(jobwork_db_pool_connections{state="waiting"})
```

4. Which commands are failing, and how — `error` is a fault, `rejected` a rule saying no, `conflict` two people deciding the same thing:

```promql
sum by (operation, outcome) (rate(jobwork_commands_total{outcome!="ok"}[15m]))
```

5. API logs: filter on `"level":50` and the correlation ids a user quotes from an error screen ("Quote this to support").
6. Recent deploy? `jobwork_build_info` changed in the last hour → roll back first, investigate second (`DO-12`).

## Mitigate

| Cause | Action |
|---|---|
| A deploy | Roll back to the previous image (one command, `DO-12`). The schema is expand-only, so the previous build runs on it |
| One route hot (export, search) | Its rate-limit budget absorbs abuse; tighten that class in `RATE_LIMIT_POLICIES` and restart. Never raise a budget during an incident |
| Database | [Database pressure](database-pressure.md) |
| Redis unreachable (`RateLimitStoreDegraded`) | Nothing breaks: each instance counts limits in memory, so they are looser across the fleet. Restore Redis; the gauge returns to 0 within 30 seconds |
| Sustained refusals (`RateLimitingSustained`) | Rate limited by class on the Security dashboard: an abusive client (block at the edge) or a legitimate integration whose budget is too tight (raise it by configuration, with a ticket) |
| Process exhaustion | Restart the instance; scale out if CPU or event-loop lag stays high |

Status message for customers and suppliers: "JobWork is slow or unavailable for some actions. Nothing you submitted is lost; if an action did not complete, retry it — it will not be applied twice."

## Verify recovery

- 5xx ratio under 0.5% and p95 under 400 ms for 15 minutes; `up{job="jobwork-api"} == 1`.
- The *Command conflicts* and *Rejected commands* panels back to their usual band.

## After the incident

Review within two working days: which signal caught it, whether a test could have, and what changed. If a deploy caused it, the review names the missing pre-merge check.
