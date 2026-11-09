# Architecture decision records

ADRs capture durable architecture choices and their consequences. All current records are **Proposed** until the inception workshop/client technical approval. Once accepted, a change requires a new superseding ADR rather than rewriting history.

| ADR | Status | Decision |
|---|---|---|
| [0001](0001-modular-monolith-first.md) | Proposed | Modular monolith first |
| [0002](0002-reseller-two-commercial-legs.md) | Proposed | Model separate buy-side and sell-side contracts |
| [0003](0003-immutable-versions-and-baselines.md) | Proposed | Immutable versions and explicit baselines |
| [0004](0004-postgresql-object-storage-outbox.md) | Proposed | PostgreSQL + private object storage + transactional outbox |
| [0005](0005-web-pwa-first.md) | Proposed | Responsive web/PWA before native mobile |
| [0006](0006-hybrid-authorization.md) | Proposed | RBAC plus relationship/attribute authorization |
| [0007](0007-disclosed-suppliers-on-customer-quotes.md) | Proposed | Name the supplier on JobWork quotes and let the customer choose |
| [0008](0008-free-single-vm-staging.md) | Proposed | Free single-VM staging until the hosting decision `T-01` |
| [0009](0009-cloudflare-workers-supabase-demo.md) | Proposed | Cloudflare Workers and Supabase for the free demo environment (supersedes 0008 once it runs) |

ADR states: Proposed, Accepted, Rejected, Deprecated, Superseded.
