# IN-10 — Communication, notifications, leakage baseline

Scope source: [Implementation plan](../24-implementation-plan.md) §4 IN-10; `FR-1001`–`FR-1005`; doc 07 §12; doc 14 §11; doc 21 audience components.
Edge cases owned (doc 19 §9): internal note attached to external message fails closed; notification provider duplicate; notification after rollback impossible (re-verified here at feature level).
Use cases: UC-04/UC-13 (thread halves), UC-38, UC-40 (text half).

## F-10.1 Communication migrations

| File | Action | Contents |
|---|---|---|
| `database/migrations/0011_communication.sql` | new | `conversation` (bound context: enquiry/RFQ/order/change/NCR), `participant`, `message` (audience enum: internal/customer/supplier/shared_technical; immutable body), `message_attachment` (dms refs), `leakage_review` (finding, action, reviewer), `notification` (template version, locale, consent basis, correlation), `delivery_attempt`, `template_version` |

## F-10.2 Threads with explicit audience

Covers: `FR-1001`; doc 14 §11; `BR-AUTH-06` allowlist principle.

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/communication/application/{post-message,release-shared-message}.command.ts` | new | Audience fixed at post; external audiences pass leakage scan gate (F-10.4) before visibility; common-technical publish anonymizes asker |
| `packages/ui/src/conversation/{AudienceBanner,Composer,Thread}.tsx` | new | Doc 21 contract: audience in words+icon+color; internal-note distinct sub-mode, no keyboard toggle |
| Portal/ops thread panels on enquiry/RFQ/order pages | edit | Mount thread component with context binding |

Tests: internal message absent from every external listing/projection/export (query-level, not filter-level); audience immutability after post.

## F-10.3 Notification pipeline

Covers: `FR-1003`–`FR-1005`; outbox-driven only.

| File | Action | Contents |
|---|---|---|
| `apps/worker/src/notifications/{composer.ts,channels/email.ts}.ts` | new | Template-version rendering (audience-safe variables only — allowlist per template), delivery attempts with idempotent delivery ids, SMS/WhatsApp port stubs (`T-0x` inception) |
| `apps/api/src/modules/communication/presentation/notifications.controller.ts` | new | In-app notification center feed + read state |
| `apps/portal-web/app/(shell)/notifications/*` + ops twin | new | Center UI; deep links land on authenticated context |

Tests: template variable outside allowlist fails render (leak guard); duplicate provider delivery → single user-visible notification (edge); rollback drill → zero notifications (edge).

## F-10.4 Contact-leakage detection v1

Covers: `FR-1002`; doc 07 §12 pipeline stages 1–2, 5–6 (text detectors + known-token trie + context action); file-metadata stages extend IN-03 scanner later.

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/communication/domain/leakage.ts` | new | Normalization (unicode/confusables), detectors (phone/email/url/handle/party names), Aho-Corasick token set from org registry, action policy: allow/warn/quarantine/block |
| `apps/api/src/modules/communication/application/resolve-leakage-review.command.ts` | new | Reviewer decision with redacted-derived alternative |
| `apps/operations-web/app/(shell)/leakage-reviews/*` | new | Review queue with evidence highlighting |
| `packages/ui/src/conversation/LeakWarning.tsx` | new | Composer warning + safe-edit path (doc 14 §11) |

Tests: engineering false positives (part numbers resembling phones) → warn not block; supplier name in outbound customer message → quarantined; reviewer release audited.

## Increment exit

- [ ] Doc 03 §7 final negative ("internal content never in external output") green across listings, notifications, exports.
- [ ] Every notification traces to a committed outbox event with template version and correlation id.
- [ ] Leakage queue functioning with human review; no silent content mutation.
