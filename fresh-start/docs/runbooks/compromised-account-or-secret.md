# Compromised internal account or secret

| | |
|---|---|
| Alerts | `SignInFailureSpike` (page), `DocumentExportSpike` (ticket), `LockoutSpike` (ticket); or a report — a lost laptop, a phished colleague, a key in a public place |
| Impact | Someone may act as JobWork staff (approvals, releases, bank details) or hold a key that signs as JobWork (session secret, service token, webhook secret, provider credential) |
| Authority | Security administrator leads: revoke sessions, suspend users, rotate secrets. Platform on-call executes secret rotation in the managed store (`DO-15`) |
| Communication owner | Security administrator with legal (doc 11 §15) |

## Diagnose

Failed sign-ins by address in the last hour — spraying shows many accounts from few addresses:

```sql
SELECT user_id, count(*) AS sessions, count(DISTINCT ip) AS addresses, max(created_at) AS latest
  FROM iam.session
 WHERE created_at > now() - interval '1 hour'
 GROUP BY user_id
 ORDER BY addresses DESC
 LIMIT 20;
```

Accounts locked out now:

```sql
SELECT id, lockout_until, failed_login_count
  FROM iam.user_account
 WHERE lockout_until > now()
 ORDER BY lockout_until DESC;
```

What one account did — the audit trail, newest first:

```sql
SELECT occurred_at, action, subject_type, subject_id, correlation_id
  FROM platform.audit_event
 WHERE actor_id = '00000000-0000-0000-0000-000000000000'
 ORDER BY occurred_at DESC
 LIMIT 100;
```

Downloads by an account (mass download):

```sql
SELECT action, count(*) AS accesses, min(occurred_at) AS first, max(occurred_at) AS last
  FROM dms.access_log
 WHERE actor_id = '00000000-0000-0000-0000-000000000000' AND occurred_at > now() - interval '7 days'
 GROUP BY action;
```

```promql
sum by (event) (rate(jobwork_auth_events_total[5m]))
```

## Mitigate

**An account**

1. Suspend the user (**Operations → Organizations → member → Suspend**, `POST /admin/users/{id}/suspend`): every session ends and every API call is refused at once.
2. Review what it did in the window (audit above); undo through the owning commands — withdraw a quote revision, revoke a document grant, return an approval — each audited with the incident as the reason.
3. Reinstate only after the person has re-enrolled MFA on a clean device.

**A secret**

| Secret | Rotate | Effect |
|---|---|---|
| `SESSION_SECRET` | New value in the secret store, restart the API | Every session ends; everyone signs in again |
| `SERVICE_TOKEN_SECRET` | New value for API and worker together, restart both | Worker tokens are short-lived; nothing else changes |
| `PAYMENT_WEBHOOK_SECRET` | Add the new one with an overlap window at the provider, then remove the old (doc 08 §10) | Callbacks continue across the switch |
| Object store / provider keys | Rotate at the provider, update the store, restart | Uploads/downloads or deliveries resume |

A leaked secret is rotated, not just deleted from where it leaked (`DO-15`).

**Credential stuffing** (`SignInFailureSpike`): per-address and per-account budgets and lockouts are already refusing; block the worst addresses at the edge, and tell affected staff to expect a lockout.

## Verify recovery

No session for the suspended user; failed sign-ins back in band; the rotated secret's old value refused (a request signed with it answers 401).

## After the incident

List every action the account took in the window and its disposition; name how the credential was lost.
