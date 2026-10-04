# ADR-0003: Immutable versions and explicit baselines

- Status: Proposed
- Date: 2026-09-01

## Context

Custom manufacturing decisions depend on exact supplier bids, customer quotes, CAD/drawings, terms, inspections and approvals. Editing records in place or referencing “latest file” makes disputes and wrong-revision production likely.

## Decision

Submitted/issued/accepted artifacts are immutable versions. Revisions append a new version with lineage/diff/reason. Files are content-hashed. A released baseline is an immutable manifest of exact document versions; production, inspection, NCR and shipment evidence reference the baseline actually used. Changes after release use engineering-change workflow and new baseline.

## Consequences

- Complete evidence and deterministic contract/configuration history.
- Storage and UI must support versions, supersession, diff, and current projections.
- Corrections use replacement/amendment/credit/debit/change records, not edits.
- Retention/deletion requires class/legal-hold design.

## Rejected alternatives

- Mutable row with audit diff only: current row can become ambiguous/corrupted and external hashes cannot bind content.
- Filename/revision label as authority: neither guarantees bytes or manifest.
