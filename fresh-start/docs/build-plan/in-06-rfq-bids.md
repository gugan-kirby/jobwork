# IN-06 — RFQ release and immutable bids

Scope source: [Implementation plan](../24-implementation-plan.md) §4 IN-06; `FR-304`–`FR-306`, `FR-401`; doc 06 §§4–5; doc 09 §6 RFQ baseline; doc 03 §1 agreements.
Edge cases owned (doc 19 §4): no eligible supplier; all decline/no response; one response only; late bid; price change after validity; (doc 19 §3) supplier downloaded before revocation.
Use cases: UC-12–UC-15, UC-22 (release half), UC-13.

## F-06.1 RFQ migrations

| File | Action | Contents |
|---|---|---|
| `database/migrations/0007_rfq.sql` | new | `rfq` (enquiry ref, round no, status, deadline, late-bid policy), `rfq_item` (requirement snapshot refs), `rfq_supplier` (invitation states per doc 06 §4), `rfq_release` (baseline manifest: exact document_version ids + hashes), `supplier_bid`, `supplier_bid_version` (immutable content cols + disposition cols per doc 05 §6 split), `bid_line`, `bid_term`, `agreement`/`agreement_version`/`agreement_acceptance` (doc 03 §1) |
| `database/tests/bid-immutability.db.spec.ts` | new | Trigger denies UPDATE on frozen bid-version content columns; disposition column updates allowed |

## F-06.2 Matching v1: hard filters and shortlist

Covers: doc 07 §2.1 hard filter only (scoring soft-ranked later, `FR-204` recorded inputs from day one); `FR-205`.

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/sourcing/application/match-suppliers.query.ts` | new | Intersect eligibility projection (IN-04) with requirement hard needs; every exclusion carries reason code; result recorded as `match_snapshot` (inputs, config version, shortlist) |
| `apps/operations-web/app/(shell)/rfqs/matcher/page.tsx` | new | Doc 14 §6 matcher: exclusion counts, shortlist build, manual add with override reason |

Tests: ineligible supplier can never be shortlisted without recorded override; empty result explains exclusions (edge: no eligible supplier).

## F-06.3 RFQ release with sanitized baseline

Covers: `FR-305`; `releaseRfq` guards (doc 06 §4) incl. NDA gate; `BR-ENG-02`.

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/sourcing/application/{create-rfq,release-rfq,revoke-invitation,close-for-evaluation}.command.ts` | new | Release: approved enquiry snapshot + sanitized manifest (scan-clean, leakage-reviewed versions only) + eligibility recheck + agreement acceptance check + deadline; grants audience per invited supplier via IN-03 |
| `apps/api/src/modules/sourcing/domain/rfq.ts` | new | RFQ + per-supplier invitation state machines |

Tests: release with unscanned/unreviewed document blocked; revoked invitation loses document grants (downloaded-before is logged fact); recheck fails on expired verification.

## F-06.4 Supplier RFQ workspace

Covers: doc 14 §5; UC-12/13.

| File | Action | Contents |
|---|---|---|
| `apps/portal-web/app/(supplier)/rfqs/page.tsx` + detail | new | Countdown, acknowledge/decline (structured reason), baseline manifest with acknowledgment, clarification thread (audience-safe: asker anonymous on common publish) |

Snapshot tests: workspace payload has zero customer identity/sell-side fields (`BR-COM-06`).

## F-06.5 Bid builder and immutable versions

Covers: `FR-306`, `FR-401`, `BR-COM-03`; doc 06 §5.

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/sourcing/application/{save-bid-draft,submit-bid-version,withdraw-bid}.command.ts` | new | Submit validates lines/units/currency/tax/validity vs exact RFQ snapshot; version insert immutable; revision starts from copy, submits as new version with reason + diff |
| `apps/api/src/modules/sourcing/domain/bid.ts` | new | Version lifecycle (submitted→superseded/selected/rejected/withdrawn/expired) |
| `apps/portal-web/app/(supplier)/rfqs/[id]/bid/page.tsx` | new | Bid lines, NRE, terms, validity; own-revision side-by-side diff (doc 21 DiffView) |

Tests: submitted version content immutable (DB + API); late submit follows policy (edge: late bid preserved with receipt time, accept/reject per policy flag); expired validity → old version stays as expired evidence (edge).

## F-06.6 Deadline handling and evaluation close

| File | Action | Contents |
|---|---|---|
| `apps/worker/src/outbox/handlers/rfq-deadline.ts` | new | Deadline tick → invitation no_response transitions, close-for-evaluation eligibility |
| `apps/operations-web/app/(shell)/rfqs/[id]/page.tsx` | new | Control room: invitation states, responses, single-source risk banner (edge: one response only → approval flag for IN-07 award) |

## F-06.7 Cross-party negative suite for sourcing

The doc 03 §7 tests that become executable now:

| File | Action | Contents |
|---|---|---|
| `apps/api/test/sourcing-negative.api.spec.ts` | new | Supplier A ↛ supplier B's bid/attachment; supplier ↛ customer identity via filenames/notifications/headers; customer ↛ any bid; enumeration returns safe 404-shape |

## Increment exit

- [x] Two suppliers invited → both bid → one revises → close for evaluation, all with immutable versions and diffs. (`rfq-bids.api.spec.ts`: "takes a bid, a revision, and refuses to let either be rewritten", "closes for evaluation…"; `bid-immutability.db.spec.ts`)
- [x] Leak suite green; revocation propagation to document grants proven. (`sourcing-negative.api.spec.ts` 6 cases; "revokes an invitation and the document access that came with it")
- [x] Single-source and no-bid paths produce explicit dispositions, not dead ends. (`closingStatus` → `no_bid`; `singleSourceRisk` asserted and shown in the control room)

Verified 2026-10-01 against the full suite (api 131, database 43). Migration numbering deviates from the table above: the RFQ schema landed as `0009_rfq.sql` because F-SO/F-SN took 0007/0008.
