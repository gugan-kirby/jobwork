# ADR-0004: PostgreSQL, private object storage, and transactional outbox

- Status: Proposed
- Date: 2026-09-01

## Context

The platform needs relational integrity, atomic acceptance/release/ledger operations, large sensitive files, asynchronous scanning/notifications/integrations, and reliable audit/event intent.

## Decision

- PostgreSQL is transactional source of truth with constraints and optimistic locking.
- File bytes live in private versioned object storage; PostgreSQL stores metadata/hash/grants/lineage.
- Critical transactions insert audit and outbox rows atomically.
- Workers deliver/process outbox work idempotently through a durable queue/provider adapters.
- Redis/search/analytics are projections or ephemeral support, never authority.

## Consequences

- Strong transaction model and practical initial operations.
- Requires outbox cleanup/partition/retry monitoring and provider reconciliation.
- DB/file recovery must be coordinated and drill-tested.
- Search may later move to a dedicated engine without changing truth.

## Rejected alternatives

- Store files in PostgreSQL: undesirable operational/storage/serving characteristics for CAD packages.
- Publish directly to broker after DB commit without outbox: can lose event between commit and publish.
- Event sourcing as sole truth: unnecessary complexity for current team/product evidence.
