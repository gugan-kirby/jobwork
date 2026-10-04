# ADR-0001: Modular monolith first

- Status: Proposed
- Date: 2026-09-01

## Context

RFQ, bid, cost sheet, quote, order, document baseline, quality, payment and shipment transitions share strong invariants and a still-evolving domain. Premature services would require distributed consistency, versioned network contracts and more operations before bounded contexts/scale are proven.

## Decision

Build one modular backend application and one worker deployable around PostgreSQL. Enforce module ownership and application interfaces; keep external integrations asynchronous through outbox. Deploy web applications separately. Extract a module only against documented load, compliance, ownership, cadence or failure-isolation evidence.

## Consequences

- Atomic critical transactions and faster initial delivery.
- Simpler local development, tracing and migrations.
- Requires architectural tests/review to prevent module/data coupling.
- Application can scale horizontally as a unit; heavy workers scale separately.
- Future extraction needs clean module interfaces and event contracts but avoids paying that cost now.

## Rejected alternatives

- Microservices from day one: excessive distributed consistency/operations for current evidence.
- Unstructured CRUD monolith: cannot protect module ownership/invariants.
- Serverless function per endpoint: fragments domain transactions and runtime behavior.
