# IN-07 — Evaluation, award, cost sheet, customer quote

Scope source: [Implementation plan](../24-implementation-plan.md) §4 IN-07; `FR-402`–`FR-406`; doc 06 §6; doc 07 §4; doc 03 §4 approval policy.
Edge cases owned (doc 19 §4): split suppliers/operations (data model + simple route); negative margin blocks; approver limit too low routes; (doc 19 §9) admin cannot open cost data ambient.
Use cases: UC-23, UC-24, UC-25.

## F-07.1 Commercial migrations

| File | Action | Contents |
|---|---|---|
| `database/migrations/0008_commercial.sql` | new | `evaluation` (normalized scenario rows, rate snapshots), `award`/`award_line` (exact bid_version refs — `BR-COM-07`), `cost_sheet`/`cost_sheet_version`/`cost_component` (lineage to bid versions), `customer_quote`/`quote_offer_set`/`quote_version`/`quote_line` (frozen/disposition split, content_hash), `terms_document`/`terms_version`, `approval_policy`/`approval_policy_version`, `approval_request`/`approval_decision` (authority snapshot per doc 03 §5) |
| `database/tests/quote-immutability.db.spec.ts` | new | Frozen columns trigger; one accepted per offer-set context (partial unique) |

## F-07.2 Bid normalization and comparison

Covers: `FR-402`; doc 07 §4 (originals untouched; NRE largest-remainder allocation).

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/commercial/domain/normalization.ts` | new | Landed-cost build: currency snapshot, tax treatment, freight scenario, NRE allocation policies with deterministic remainder + stable tie-break |
| `apps/api/src/modules/commercial/application/create-evaluation.command.ts` | new | Scenario persisted with every input/rate/version |
| `apps/operations-web/app/(shell)/evaluations/[id]/page.tsx` | new | Doc 21 ComparisonTable: original columns visually distinct from normalized scenario |

Property tests (doc 13 §9): allocation conserves minor units for 0/2/3-decimal currencies; same inputs+config → identical scenario hash.

## F-07.3 Award with approval policy

Covers: `FR-403`, `FR-405`, `BR-AUTH-04`; single-source approval (IN-06 flag).

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/commercial/domain/approval-policy.ts` | new | Policy-version evaluation (amount/margin/category scope precedence per doc 03 §4); decision records with authority snapshot |
| `apps/api/src/modules/commercial/application/{propose-award,approve-award}.command.ts` | new | Exact bid-line selection, split routing validation (quantity conservation check), SoD: proposer ≠ sole approver |
| `apps/operations-web/app/(shell)/awards/*` | new | Award builder + ApprovalPanel (doc 21) |

Tests: award referencing superseded bid version fails; split award quantities must sum to requirement (edge); proposer self-approval denied; policy version recorded on decision.

## F-07.4 Cost sheet versions

Covers: `FR-404`.

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/commercial/application/{save-cost-sheet,request-approval,approve-cost-sheet}.command.ts` | new | Versioned scenarios with source-bid lineage; components (freight/quality/finance/risk/margin) from configurable set; floor checks vs policy |
| `apps/operations-web/app/(shell)/cost-sheets/*` | new | Component grid, margin sensitivity, approval state |

Tests: negative-margin scenario blocks quote build without approved exception (edge); cost data invisible to platform-admin role (`BR-AUTH-03` negative).

## F-07.5 Customer quote versions and internal approval

Covers: `FR-406`; doc 06 §6 state machine; offer sets (`D-12`, doc 05 §6).

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/commercial/domain/quote.ts` | new | Quote/offer-set lifecycle; frozen content hash build (canonical per doc 07 §13 style) |
| `apps/api/src/modules/commercial/application/{draft-quote,request-quote-approval,approve-quote-version,send-quote,supersede-quote}.command.ts` | new | Approval via F-07.3 policy engine; send grants customer audience to quote PDF/version |
| `apps/worker/src/outbox/handlers/quote-sent.ts` | new | Notification + generated immutable PDF artifact (hash-linked) via renderer stub |

Tests: sent version immutable; supersede chains correctly; offer-set siblings created/linked.

## F-07.6 Customer quotation view

Covers: doc 14 §4 customer quotation; strict sell-side projection (`ES-11`).

| File | Action | Contents |
|---|---|---|
| `packages/contracts/src/customer/quote.ts` | new | Customer-safe DTO (the type is the leak barrier) |
| `apps/portal-web/app/(customer)/quotations/*` | new | Revision/validity countdown, lines/tax/terms, assumptions, revision diff, request-revision/reject actions (accept lands IN-08) |

Snapshot tests (doc 13 §7 DLP style): serialized customer quote contains no supplier/cost/margin field names or values, including expansions and error payloads.

## Build notes (2026-10-01)

| Functionality | State | Evidence |
|---|---|---|
| F-07.1 | built | `0012_commercial.sql` (schema `commercial`: policies, approval request/decision with SoD trigger, evaluation, award, cost sheet versions, terms, offer set, customer quote versions with immutability triggers, one-accepted-per-set index); `quote-immutability.db.spec.ts` (6) |
| F-07.2 | built | `domain/normalization.ts` + `money.ts` (largest-remainder allocation, ex-tax comparison, deterministic rank/hash); `normalization.spec.ts` (9 property/unit cases); `POST /rfqs/:id/evaluations`; `/evaluations/[id]` comparison table |
| F-07.3 | built | `propose-award` (exact live bid versions, quantity conservation, every line covered, single-source fallback); `decide-approval` (role from request, SoD in command and trigger, authority snapshot, policy version); approval applies: bid versions selected/rejected, RFQ awarded; `/awards/[id]`, `/approvals` |
| F-07.4 | built | `cost-sheet.command` (figures computed from award lines + components, margin on sell, sell lines by largest remainder, frozen from approval request; negative/below-floor margin routes to finance exception); platform admin 403 asserted |
| F-07.5 | built | `quote.command` draft/request-approval/send/replace/withdraw/expire; reference `QUO-YYYY-NNNN` minted at send; terms cited by version + hash; `commercial.quote_sent.v1`; document rendered deterministically from frozen columns with the content hash (`quote-document.ts`) |
| F-07.6 | built | `customer-quote.ts` contract + `customer-quote.projection.ts` (visible = sent versions only; status wording per doc 06 §13; diff of previous sent versions; sibling options); `/quotations` list + detail (prototype tiles 9–10 corrected); leak suite walks every key of the serialized payload |

Deviations: migration is `0012_commercial.sql` (0008 was taken). Module is `modules/commercial` (name `commercial`, not split per aggregate). Quote supersession is a **version** fact: a replacement is a new draft version on the same quote and the sent one becomes `superseded` when the replacement is sent (doc 05 §6); the aggregate never enters a `superseded` state (doc 06 §6 figure) — doc 06 to be aligned in the IN-08 doc pass. The immutable "PDF" is an HTML document rendered on demand from frozen columns and hash-stamped; a stored binary artifact is deferred until a renderer is chosen (`T-04`). Approval policy rules are seeded data (launch policy) edited by migration until a policy console exists (`UC-35`). Fixed on the way: `@ServiceOnly` routes had no actor (every service route, including the IN-06 deadline sweep, answered 401 to the worker) — `CurrentActor` now synthesizes a service actor from the verified principal; regression asserted.

## Increment exit

- [x] Doc 19 §10 scenario 1 chain: two bids → normalized comparison → award → cost sheet → approved quote → sent to customer. (`commercial.api.spec.ts`, 7 cases, incl. revision → replacement → rejection and expiry sweep)
- [x] Every approval decision carries policy version + authority snapshot; SoD negatives green. (command + `trg_approval_separation`; `APPROVAL_SEPARATION`, `APPROVAL_AUTHORITY_MISSING`, `APPROVAL_NOT_PENDING` asserted)
- [x] Sell-side projection leak suite green. (every key of the customer payload checked against supplier/bid/cost/margin/landed/award/evaluation/buy; supplier names, bid ids and cost sheet ids absent from the serialized body and the document)
- [x] Operations and portal walkthrough in the browser (2026-10-01: dev chain seeded through the real commands — round, two bids, close, comparison, 60/40 split award, sales approval, cost sheet at 15 % with finance approval, standard + fast quotations approved by a second sales user and sent as `QUO-2026-0001/0002`; screenshots of portal tiles 9–10 and the operations control room, award, approvals, quote and comparison pages). Defects found and fixed on the way: service-only routes had no actor (401 for the worker); the control room showed "No bids yet" after award because selected versions are no longer live; the ops app had no `icon.svg`.
