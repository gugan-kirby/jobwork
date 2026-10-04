# IN-10 — Communication, notifications, leakage baseline

Scope source: [Implementation plan](../24-implementation-plan.md) §4 IN-10; `FR-1001`–`FR-1005`; doc 07 §12; doc 14 §11; doc 21 audience components; doc 11 §9 (contact and identity shielding) and the "notification leak" threat row; `D-18` (in-app thread authoritative, email/SMS/WhatsApp are delivery only).
Edge cases owned (doc 19 §9): internal note attached to external message fails closed; notification provider duplicate; notification after rollback impossible (re-verified here at feature level).
Use cases: UC-04/UC-13 (thread halves), UC-38, UC-40 (text half).

**Refresh (2026-10-04, before build).** This plan was written at inception; the codebase has since moved. Changes against the original, each with its reason:

| Original | Now | Why |
|---|---|---|
| `0011_communication.sql` | `0015_communication.sql` | 0011–0014 were taken by registration, commercial, orders/finance and production |
| Templates rendered in `apps/worker/src/notifications/composer.ts` | Rendered in the API (`communication/domain/templates.ts`); the worker only delivers | The worker holds no business-state access (doc 20 §9, `apps/worker/src/main.ts`); recipients and template variables need the database. The worker calls service-only routes, as the scan pipeline already does |
| Routes under `app/(shell)/…` | The apps' real paths (`/notifications`, `/leakage-reviews`, existing detail pages) | No route groups exist; the shells are client components in the root layout |
| Portal `notifications/*` new | Extended | F-MX built `/notifications` from the queue summaries; the feed joins it |
| Thread contexts enquiry/RFQ/order/change/NCR | enquiry, RFQ, sales order, purchase order | Change (IN-13) and NCR (IN-15) aggregates do not exist yet; the context enum is open to them |
| `message_attachment` exposed | Table created, posting attachments refused | An attachment in an external thread needs a dms audience grant decided per audience; that belongs with the file-metadata leakage stages (doc 07 §12 stages 3–4) rather than a text-first increment |
| Action policy allow/warn/quarantine/block, automatic | Automatic: allow, warn, quarantine. Block is a reviewer decision (reject) | `FR-1002` asks for human review of uncertain cases, and doc 07 §12 warns that engineering text produces false positives; nothing is refused unseen |
| Execution order 10.1 → 10.2 → 10.3 → 10.4 | 10.1 → 10.4 → 10.2 → 10.3 | Posting to an external audience must be gated from its first commit; the detector and review path exist before the composer can post |

## F-10.1 Communication migration

| File | Action | Contents |
|---|---|---|
| `database/migrations/0015_communication.sql` | new | Schema `communication`: `conversation` (context type + id, unique), `participant` (external organizations a conversation is held with), `message` (audience `internal`/`customer`/`supplier`/`shared_technical`, counterpart organization for supplier messages, status `visible`/`held`/`rejected`/`superseded`, `derived_from_message_id`; body and audience immutable by trigger), `message_attachment` (dms version refs), `leakage_review` (findings, action, status, reviewer, decision, derived message), `template_version` (key, version, locale, channel, subject, body, variable allowlist; immutable), `notification` (recipient, template version, locale, consent basis, source outbox event, correlation id, read state; unique per source event + recipient + template key), `delivery_attempt` (stable delivery id per notification + channel, attempts, provider reference, status). Seeds v1 templates. |
| `database/tests/communication.db.spec.ts` | new | Body/audience immutability, template immutability, one notification per event + recipient |

## F-10.4 Contact-leakage detection v1 (built second)

Covers: `FR-1002`; doc 07 §12 stages 1–2 and 5–6; doc 11 §9 message text; UC-40 (text half).

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/communication/domain/leakage.ts` | new | Stage 1: NFKC, zero-width removal, confusable folding, spelled-out separators ("at", "dot"). Stage 2: detectors — email (plain and obfuscated), URL/domain, social/messaging handles (wa.me, t.me, @handle), Indian phone numbers (mobile, landline with STD code) with an engineering-context test (part/drawing/rev/lot/units, alphanumeric adjacency) that downgrades to a low-confidence finding, PIN-code address phrases. Stage 5: Aho-Corasick trie over the counterpart registry (organization legal/display/trade names with and without legal suffixes, website domains, contact emails and phones, member email addresses). Stage 6: policy → `allow`/`warn`/`quarantine` |
| `apps/api/src/modules/communication/domain/leakage-policy.ts` | new | Who is shielded from whom per audience: a customer audience must not learn supplier identities; a supplier or shared-technical audience must not learn the customer's or another supplier's. Counterpart identity → quarantine. High-confidence contact detail → quarantine when JobWork writes outward or anything is shared to all suppliers; warn when the external party writes to JobWork. Engineering-looking numbers → warn |
| `apps/api/src/modules/communication/application/leakage-review.command.ts` | new | Queue and detail for reviewers (`jobwork_support`, `jobwork_sourcing`); decide: release original, release a redacted derived message (original kept, lineage recorded), or reject. The author of a held message cannot review it. Audited, outboxed |
| `apps/operations-web/app/leakage-reviews/page.tsx` | new | Review queue: evidence spans highlighted, decision panel; nav badge from the operations summary |
| `packages/ui/src/conversation/LeakWarning.tsx` | new | Composer warning naming each finding, with "Edit message" and "Send for review" (doc 14 §11) |

Tests: `communication/domain/leakage.spec.ts` — part numbers, drawing numbers and dimensions that resemble phone numbers warn rather than quarantine; obfuscated email and confusable-letter supplier names are caught; counterpart names match on word boundaries only. API — supplier name in a JobWork message to the customer is quarantined and invisible to the customer until released; reviewer release audited; redacted release creates a new message and leaves the original intact; author cannot review own message.

## F-10.2 Threads with explicit audience (built third)

Covers: `FR-1001`; doc 14 §11; `BR-AUTH-06` allowlist principle; doc 03 §7 last negative; UC-04/UC-13.

| File | Action | Contents |
|---|---|---|
| `packages/contracts/src/communication.ts` | new | Thread, message (external and internal projections are separate types), post/check requests, leakage findings, review, notification DTOs |
| `apps/api/src/modules/communication/{communication.module.ts,index.ts}` | new | Module wiring; imports iam |
| `apps/api/src/modules/communication/infrastructure/{communication.repository.ts,context.resolver.ts}` | new | Context resolution per type (who may read, which audiences each party may post to, counterpart registry for the detector). External listings select by audience allowlist in SQL (`audience = ANY($allowed)` and organization match), never by filtering rows after the fetch |
| `apps/api/src/modules/communication/application/message.command.ts` | new | `post-message` (audience fixed at post, leakage gate before visibility, idempotent), `check-message` (composer pre-check, no persistence), `share-message` (a supplier's RFQ question republished by JobWork to every invited supplier as shared-technical, asker never shown) |
| `apps/api/src/modules/communication/presentation/conversations.controller.ts` | new | `GET/POST /conversations/:contextType/:contextId(/messages, /messages/check)`, `POST /messages/:id/share` |
| `packages/ui/src/conversation/{AudienceBanner,Composer,Thread}.tsx` | new | Doc 21 contract: audience in words + icon + colour; internal note a distinct mode reached only by a deliberate control, no keyboard toggle |
| `apps/portal-web/app/thread-panel.tsx`; enquiry, order, RFQ, supplier PO detail pages | new/edit | Mount the thread for the page's context |
| `apps/operations-web/app/thread-panel.tsx`; intake, RFQ, sales-order pages | new/edit | Internal view: every audience labelled, per-supplier audience on RFQs, share-to-all action |

Tests: an internal note is absent from every external listing (customer, supplier, other supplier); a supplier never sees another supplier's private messages; a shared-technical message never names the asking supplier; audience and body cannot change after post (trigger); a customer cannot post to a supplier audience or read a thread for another organization's enquiry; the check endpoint persists nothing.

## F-10.3 Notification pipeline (built last)

Covers: `FR-1003`–`FR-1005`; UC-38; outbox-driven only.

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/communication/domain/templates.ts` | new | `{{variable}}` rendering against the template version's allowlist; a placeholder or a variable outside it refuses to render |
| `apps/api/src/modules/communication/domain/notification-rules.ts` | new | Event type → template key, recipient audience and role set, variable builder from projection-safe fields only. Customer: clarification requested, quote sent, invoice issued, payment received, new message. Supplier: RFQ invitation, purchase order issued, transmittal issued, evidence rejected, new message. JobWork: enquiry submitted, clarification answered, bid submitted, approval requested, quote accepted, evidence submitted, new message, leakage review opened |
| `apps/api/src/modules/communication/application/notification.command.ts` | new | Service-only `dispatch(eventId)`: reads the committed outbox event, resolves recipients, inserts notifications idempotently (one per event + recipient + template), opens one email delivery per notification, returns pending deliveries; `recordDelivery` stores the provider outcome. User feed, unread count, mark read |
| `apps/api/src/modules/communication/presentation/notifications.controller.ts` | new | `GET /notifications`, `GET /notifications/unread-count`, `POST /notifications/:id/read`, `POST /notifications/read-all`; service-only `POST /internal/notifications/dispatch`, `POST /internal/notifications/deliveries/:id/result` |
| `apps/worker/src/notifications/{deliver.ts,channels.ts}` | new | Outbox handler per notified event type: dispatch → send each delivery through its channel → report. Email via the existing mailer; SMS and WhatsApp ports that refuse until a provider is chosen. Notified event types leave `ACKNOWLEDGED_UNTIL_NOTIFICATIONS` |
| `apps/portal-web/app/notifications/page.tsx`, ops `notifications/page.tsx`, both shells | edit/new | Feed with read state; bell shows unread; links land on the authenticated page, never the message body (doc 14 §11) |

Tests: a template referencing a variable outside its allowlist refuses to render (leak guard); dispatching the same event twice yields one notification per recipient and the same delivery ids (provider duplicate edge); a command that rolls back leaves no outbox event and no notification (rollback edge); a customer notification about a quote carries the quote reference, never supplier names or cost; every notification row carries its outbox event id, template version and correlation id; a user reads only their own feed.

## Increment exit

- [ ] Doc 03 §7 final negative ("internal content never in external output") green across listings, notifications, exports.
- [ ] Every notification traces to a committed outbox event with template version and correlation id.
- [ ] Leakage queue functioning with human review; no silent content mutation.
