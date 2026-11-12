# JobWork

Managed B2B custom-manufacturing procurement for India, Chennai first. JobWork is the accountable middleman: `Supplier → JobWork → Customer`, two separate commercial legs, identities and prices shielded between the parties.

**The project lives in [`fresh-start/`](fresh-start/README.md)**: the specification (25 numbered docs and the ADRs), the build plans, and the applications (`apps/`), packages, database and infrastructure.

## Live demo

Free Cloudflare Workers and Supabase, made-up data only ([ADR-0009](fresh-start/docs/adr/0009-cloudflare-workers-supabase-demo.md), deployment guide in [`fresh-start/infra/cloudflare/`](fresh-start/infra/cloudflare/README.md)).

| | Address |
|---|---|
| Front door | https://jobwork.gugantennyson.workers.dev |
| Customer and supplier portal | https://jobwork-portal.gugantennyson.workers.dev |
| Operations console | https://jobwork-operations.gugantennyson.workers.dev |

The front door is the `jobwork` Worker that Cloudflare Workers Builds deploys from this repository's root on every push (`wrangler.jsonc`, `site/`). The applications are deployed from `fresh-start/` with `go-live.sh`.

## History

An Android prototype (Firebase, Kotlin) preceded the rebuild; it was removed from the tree on 2026-11-12 and stays in the git history before that date. `JobWork_UI_Prototype.png` is kept as the design reference the first screens were built from (`fresh-start/docs/00-source-analysis.md`).
