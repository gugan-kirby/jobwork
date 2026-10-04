# Object storage upload or download failure

| | |
|---|---|
| Alerts | None of its own yet (gap owned by platform, `T-01`); seen as `ApiErrorRateHigh` on upload/download routes and as `FileScanBacklogAging` |
| Impact | Uploads and downloads fail; anything that needs a new file waits. Metadata stays correct and no database row is corrupted (doc 12 §3) |
| Authority | Platform on-call |
| Communication owner | JobWork support: "Uploading and opening files is unavailable for a while. Nothing you uploaded before is affected." |

## Diagnose

```promql
sum by (route, status_code) (rate(http_server_request_duration_seconds_count{route=~".*(uploads|download|grants).*",status_code=~"5.."}[10m]))
```

Upload sessions that did not finish:

```sql
SELECT status, count(*) AS sessions, min(created_at) AS oldest
  FROM dms.upload_session
 WHERE created_at > now() - interval '1 day'
 GROUP BY status;
```

Check the store directly from the API host: the bucket health endpoint (`/minio/health/live` locally, the provider's status page deployed) and the credentials' expiry.

## Mitigate

- Restore the store or its credentials; nothing in JobWork needs repair afterwards: upload grants expire on their own (15 minutes), and a finalize that failed can be retried by the uploader.
- Never point the API at a different bucket to "get uploads working": quarantine and clean buckets are a security boundary (doc 09 §4).

## Verify recovery

An upload and download round trip from a test organization succeeds; upload/download 5xx at zero for 15 minutes.

## After the incident

Add the store's own error rate to the platform dashboard when `T-01` names the provider.
