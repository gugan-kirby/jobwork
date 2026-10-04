# File scan backlog or malware campaign

| | |
|---|---|
| Alerts | `FileScanBacklogAging` (page) |
| Impact | New uploads stay quarantined, so anything that needs them — evidence verification, baseline items, RFQ packages — waits. That is the design: an unscanned file is never served (doc 09 §4, doc 12 §3). Already-clean files are unaffected |
| Authority | Platform on-call: worker and scanner. Security administrator: anything involving an infected file — the organization that uploaded it, its sessions, its other files |
| Communication owner | JobWork support for the delay; the security administrator, with legal, for a malware campaign |

## Diagnose

Files waiting for a verdict, and verdicts in the last day:

```sql
SELECT scan_state, count(*) AS files, min(created_at) AS oldest
  FROM dms.file_object
 WHERE scan_state IN ('quarantined', 'scanning') OR updated_at > now() - interval '1 day'
 GROUP BY scan_state
 ORDER BY scan_state;
```

Infected files by uploading organization — ids only; a sudden cluster from one organization is a campaign or a compromised account:

```sql
SELECT owning_organization_id, count(*) AS infected, max(updated_at) AS latest
  FROM dms.file_object
 WHERE scan_state = 'infected' AND updated_at > now() - interval '7 days'
 GROUP BY owning_organization_id
 ORDER BY infected DESC;
```

Is the worker handling `dms.file_finalized`, or retrying it?

```promql
sum by (outcome) (rate(jobwork_outbox_handled_total{event_type="dms.file_finalized"}[15m]))
```

```promql
max(jobwork_scan_oldest_age_seconds)
```

## Mitigate

| Cause | Action |
|---|---|
| Worker down or behind | [Outbox backlog](outbox-backlog-poison-message.md): restart; scans resume in order |
| Object store unreachable | [Object storage failure](object-storage-failure.md) — the scanner reads quarantine bytes |
| Scans failing on one file type | The file is marked `failed`, not clean, and stays unserved; the uploader is asked to re-upload. Nothing to override |
| Malware campaign | Security administrator: suspend the uploading membership or organization (**Operations → Organizations**, audited; sessions end), then review that organization's other recent uploads. Infected bytes never leave quarantine and are never served |

Never move a file to the clean bucket by hand, and never mark a file clean without a scanner verdict.

## Verify recovery

Oldest waiting file under two minutes; `dms.file_finalized` handled with outcome `delivered`.

## After the incident

For a campaign: which organization, how it was admitted, whether its evidence still stands; whether the scanner's signatures need an update.
