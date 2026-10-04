# ADR-0006: Hybrid authorization

- Status: Proposed
- Date: 2026-09-01

## Context

A role alone cannot answer whether a supplier may view one RFQ file or a customer approver may accept one deviation. Decisions depend on organization relationship, artifact audience, state, NDA, amount limits, geography, and segregation of duties.

## Decision

Use RBAC for job actions plus relationship-based and attribute checks for every object. Enforce centrally/server-side with domain guards and query scoping; deny by default. Use database constraints and selectively RLS for defense-in-depth. Platform administrator receives no ambient sensitive-business access.

## Consequences

- Fits customer/supplier/JobWork boundaries and approval duties.
- Requires a policy vocabulary, efficient relationship queries, cache/revocation discipline and large negative-test matrix.
- List/search/export/file/notification paths must use the same policy, not only detail endpoints.
- Authorization decisions and overrides are observable/auditable without logging sensitive payloads.

## Rejected alternatives

- Pure RBAC: too coarse for per-RFQ/audience/amount/state decisions.
- Frontend-only visibility: not a security control.
- Universal super-admin data access: conflicts with least privilege and customer IP protection.
