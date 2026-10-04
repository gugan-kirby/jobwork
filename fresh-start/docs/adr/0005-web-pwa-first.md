# ADR-0005: Responsive web/PWA before native mobile

- Status: Proposed
- Date: 2026-09-01

## Context

The existing concept is mobile, but RFQ/CAD/bid/measurement/operations workflows are often desktop-heavy. External onboarding and approvals benefit from links and no installation. Production-floor capture benefits from mobile access.

## Decision

Build responsive web applications: one customer/supplier portal/PWA and a separate operations web application, sharing a design system/contracts. Use PWA camera/upload/installability for initial field work. Reassess native mobile after measuring offline, background, device-integration and engagement requirements.

## Consequences

- Faster multi-device delivery and one primary client stack.
- Desktop operations and mobile capture both supported.
- Browser/PWA limits background/offline/deep device integration; offline command/evidence UX needs explicit safety.
- Existing Android prototype remains a design reference, not the fresh-start architecture.

## Rejected alternatives

- Android-only MVP: excludes desktop/iOS/link-first workflows and duplicates operations work.
- Native apps plus web from day one: excessive surface area before product workflow stabilizes.
