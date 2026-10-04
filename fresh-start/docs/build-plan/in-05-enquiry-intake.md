# IN-05 — Enquiry intake and triage

Scope source: [Implementation plan](../24-implementation-plan.md) §4 IN-05; `FR-301`–`FR-303`; doc 06 §3; doc 14 §4 wizard.
Edge cases owned (doc 19 §3): only a photo/vague description (assisted intake path); CAD/2D conflict flagged at intake review; (doc 19 §9) two users edit same draft.
Use cases: UC-01 (card discovery from IN-04), UC-02, UC-04, UC-21.
Comparable-platform note: Xometry's configuration page validates our wizard fields (process, material, tolerance, quantity, inspection needs at intake); Fictiv's reorder validates the copy-enquiry path.

## F-05.1 Sourcing migrations (enquiry slice)

| File | Action | Contents |
|---|---|---|
| `database/migrations/0006_enquiry.sql` | new | `enquiry` (org, status, aggregate_version), `enquiry_item` (process, material, quantity breakpoints, tolerance class, target dates), `requirement` (frozen intake revision snapshots, jsonb schema-validated), `clarification` (question/answer versions, status), `enquiry_document` links to dms document versions |
| `database/tests/enquiry-constraints.db.spec.ts` | new | Reference withheld from drafts; close needs a reason; requirement revisions immutable and uniquely numbered; one governing document per enquiry; answered clarification carries an answer; tolerance validated as value+unit |

**Deviation (2026-09-06):** `iam.organization_site` was listed in doc 05 §4 but never built in IN-01, and `FR-301` needs delivery destinations. It is created in `0006_enquiry.sql` — the migration that first depends on it — with a per-item `delivery_site_id` override for the plural-destinations case.

## F-05.2 Enquiry domain and draft autosave

Covers: `FR-302`; doc 06 §3 states; `ES-08` closed unions.

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/sourcing/domain/enquiry.ts` | new | State machine draft→submitted→under_review→clarification_required→approved_for_sourcing/closed/cancelled; `validateForSubmission` category-dependent mandatory fields returning field paths; `EnquiryVersionConflict` |
| `apps/api/src/modules/sourcing/domain/enquiry-policy.ts` | new | Author roles (`org_admin`, `customer_requester`) vs intake reviewer roles (`jobwork_sourcing`, `jobwork_engineering`); the two never overlap |
| `packages/contracts/src/sourcing.ts` | new | Enquiry, item, document-link, clarification and curated-projection schemas |
| `apps/api/src/modules/sourcing/infrastructure/enquiry.repository.ts` | new | Draft replace under row lock, reference allocation, revision freeze with content hash, clarification append/answer, document usability + logical types |
| `apps/api/src/modules/sourcing/application/{save-draft,submit-enquiry,cancel-enquiry}.command.ts` | new | Autosave upsert with expectedVersion (conflict → reload per doc 14 §14); submit freezes intake revision and allocates `ENQ-YYYY-NNNN` |
| `apps/api/src/modules/sourcing/application/copy-enquiry.command.ts` | new | Copy path (UC-02): lands as draft, drops dates and unusable documents, keeps lineage |

Tests (`apps/api/test/enquiry-intake.api.spec.ts`): submit without mandatory category fields → field-path errors and nothing frozen; concurrent draft edits → one VERSION_CONFLICT with a reload instruction; submitted requirement snapshot immutable; assisted path accepts a photo alone but still needs part and quantity; copy lands as a draft without dates or reference; another organization's enquiry is indistinguishable from a missing one; foreign document refused.

## F-05.3 Enquiry wizard (customer portal)

Covers: doc 14 §4 seven steps; doc 21 §7 patterns.

| File | Action | Contents |
|---|---|---|
| `apps/portal-web/app/enquiries/new/page.tsx` | new | Seven-step stepper with debounced autosave, conflict reload, and 422 field paths routed back to the owning step |
| `packages/ui/src/forms/MeasurementInput.tsx` (with `UnitSelect`), `packages/ui/src/forms/MoneyInput.tsx` | new | Doc 21 §7 inputs (minor units; value+unit, no silent conversion) |
| `apps/portal-web/app/enquiries/page.tsx`, `apps/portal-web/app/enquiries/[enquiryId]/page.tsx` | new | List with curated status chips and action-needed cards; detail with the clarification thread |

**Defect fix (2026-09-06):** the Documents step was a dead end. It listed nothing (see the F-03.2/F-03.5 fix above), offered no upload of its own, and its only affordance was a link to `/documents` that left the wizard for good — the draft id lived in React state alone, so coming back started a *new* blank draft and orphaned the old one. Three changes, all in `app/enquiries/new/page.tsx` unless noted:

- **The URL is the wizard's memory.** `?draft=<enquiryId>&step=<n>`, written with `window.history.replaceState` (Next's documented way to sync search params without re-navigating) and read on mount behind a `Suspense` boundary, as `useSearchParams` requires. Leaving and returning — reload, closed tab, the documents library — resumes the same draft on the same step.
- **Uploading happens inside the flow.** The step hosts its own `FileUpload` (its own resume key) and attaches the version to the draft the moment the scan clears, so the wizard is never a place you have to leave to finish it.
- **The detour, if taken, comes back.** The library link carries `returnTo`, and `app/documents/page.tsx` renders it as a breadcrumb (`lib/return-to.ts` rejects anything not a same-origin absolute path, so the link cannot be pointed off-origin).

Documents whose current version is still scanning, quarantined or withdrawn are listed but not attachable, each with the reason — the same rule `documentsUsable` enforces at save. Verified in Chrome against the running stack: upload inside the wizard → scanned clean → auto-attached → draft saved; library detour and back with both attachments and the step intact.

**Deviation (2026-09-06):** no `(customer)` route group — portal-web has no route groups anywhere, so the paths are plain `app/enquiries/*` to match. Autosave interruption/resume and the assisted path are asserted at the API level (`enquiry-intake.api.spec.ts`) rather than by a browser E2E; the wizard's own resume path is the same `save-draft` call those tests cover.

## F-05.4 Triage and clarifications (operations)

Covers: `FR-303`; doc 14 §6 intake workspace; doc 06 §3.

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/sourcing/application/{start-triage,request-clarification,submit-clarification,approve-for-sourcing,decline-enquiry}.command.ts` | new | Structured Q&A rounds; answering and approval each freeze a reviewed revision |
| `apps/api/src/modules/sourcing/domain/completeness.ts` | new | Computed reviewer checklist; `blocking` flags refuse approve-for-sourcing (incl. CAD/2D conflict) |
| `apps/operations-web/app/intake/page.tsx`, `apps/operations-web/app/intake/[enquiryId]/page.tsx` | new | Queue; two-pane requirement + documents + revision history, checklist, clarification builder, approve/decline |

Tests: two clarification rounds leave the intake revision's hash unchanged; decline requires a reason; a customer cannot triage; CAD/2D conflict blocks approve until a governing document is declared.

## F-05.5 Customer status projection v1

Covers: doc 06 §13 table rows 1–2.

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/sourcing/presentation/enquiry-projection.ts` | new | Curated status + action-needed reason, built by construction rather than by stripping fields; wording from doc 06 §13 |
| `packages/ui/src/status/StatusChip.tsx` (with `ActionNeededCard`) | new | Doc 21 components, semantic status tokens; renders the projection's own label rather than mapping a state |

Tests: the serialized customer payload contains none of `approved_for_sourcing`, `under_review`, `clarification_required`, `supplier`, `bid`, `cost`, `margin`, `decidedBy`, `reviewerNote`; a non-draft returns no editable draft body.

## Increment exit

- [x] Doc 19 §10 scenario 2 E2E (incomplete enquiry, two clarifications) green — asserted end to end including the audit and outbox rows each step writes.
- [x] Intake revision provably frozen at submit (content hash unchanged across both clarification rounds, immutability enforced by trigger); copy-enquiry lands as a draft that must be reviewed and submitted again.
- [x] Customer sees only curated statuses; operations sees full state + guards.

**Closed 2026-09-06.** Verified with `pnpm -r build && pnpm typecheck && pnpm lint && pnpm test` — 131 tests green (api 71, worker 30, database 28, observability 2).
