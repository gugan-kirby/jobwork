# ADR-0008: Free single-VM staging until the hosting decision

- Status: Proposed
- Date: 2026-11-07

## Context

The owner wants a reachable staging environment with no spend and no domain before `T-01` is decided. JobWork needs four long-running processes plus PostgreSQL, Redis, and S3-compatible storage. The worker polls continuously, so hosts that sleep on idle cannot run it.

## Decision

Run all of staging on one Oracle Cloud Always Free Ampere A1 VM in an India region, using Docker Compose (`infra/deploy/`):

| Need | Choice |
|---|---|
| Compute | Oracle Always Free, 2 OCPU / 12 GB (limit since 2026-08-18) |
| Database, Redis, objects | Containers on the VM, not published to the internet |
| Hostnames | Free DuckDNS subdomains |
| TLS | Caddy with Let's Encrypt |
| Mail | Gmail SMTP with an app password; no domain to authenticate |
| First admin | `database/src/bootstrap-admin.ts`, run once; the dev seed never runs here |

## Consequences

- Synthetic data only. There is one disk, no managed backup or PITR, and no redundancy.
- Deviations from doc 23, accepted for this stack only: `DO-01` (one shared account), `DO-04`/`DO-05` (no IaC), `DO-06` (one image for all deployables, built on the VM), `DO-13` (SSH access), `DO-15` (a `.env` file with mode 600 instead of a secret store).
- Oracle may stop an instance whose 7-day 95th-percentile CPU, network, and memory are all under 20%. Restarting it keeps the data.
- Gmail mail is limited by Google's sending quota and comes from a personal address.
- Payment, carrier, and malware scanning stay on their development adapters (`T-03`, `T-05`, `T-06`). Production turns off simulated checkout, so an online payment cannot complete here.
- `T-01` stays open. This does not choose the production platform.
