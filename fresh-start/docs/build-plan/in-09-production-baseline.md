# IN-09 — Baseline, production release, milestones

Scope source: [Implementation plan](../24-implementation-plan.md) §4 IN-09; `FR-503`–`FR-506`; `BR-ENG-03/07`, `BR-OPS-*`; doc 06 §§7–8; doc 09 §§5–6; roadmap Phase 1 slice 10 (baseline moved into Phase 1).
Edge cases owned (doc 19 §5): supplier starts without release; baseline acknowledgment missing blocks start; milestone backdated; reused/fake photo flag; machine breakdown forecast append.
Use cases: UC-16 (baseline half), UC-17, UC-08, UC-26 (minimal release path).
Comparable-platform note: Fictiv's per-stage photos and Zetwerk's checkpoint tracking validate evidence-per-milestone; we add baseline binding they don't expose.

## F-09.1 Orders/DMS migrations (production slice)

| File | Action | Contents |
|---|---|---|
| `database/migrations/0010_production.sql` | new | `work_package` (PO/sales-order refs, status, gates snapshot), `operation_route` (simple sequential v1), `milestone_plan`/`milestone` (evidence policy, verifier role, planned/actual/forecast revisions), `progress_update`, `hold` (typed, scoped), `baseline`/`baseline_item` (exact version pins + hash per doc 07 §13), `transmittal`/`transmittal_item`/`acknowledgment`, `stock_lot`/`stock_movement`/`custody_location` (doc 05 §17 — planted now for receiving in Phase 2) |

## F-09.2 Baseline and transmittal

Covers: `BR-ENG-02/03/07`; doc 09 §§5–6.

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/dms/application/{assemble-baseline,release-baseline,release-transmittal,acknowledge-transmittal}.command.ts` | new | Manifest from clean, leakage-reviewed versions; canonical baseline hash; immutability after release; acknowledgment per recipient with deadline |
| `apps/operations-web/app/(shell)/baselines/*` | new | Assembly UI (governing flags, conflict blocker), release + acknowledgment tracking |
| `apps/portal-web/app/(supplier)/baselines/[id]/page.tsx` | new | Immutable manifest view + acknowledge action |

Tests: released baseline rejects any item change; conflicting governing docs block release (`BR-ENG-06`); hash reproducible from manifest (property).

## F-09.3 Production release gate

Covers: doc 06 §7 guard list; `FR-504`; `BR-OPS-01`.

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/orders/domain/release-gates.ts` | new | Computed gate matrix: commercial (IN-08 credit/installment), technical (baseline released + acknowledged), planning (route+dates), compliance (quality-plan present flag v1); each gate → evidence refs + reason codes |
| `apps/api/src/modules/orders/application/release-work-package.command.ts` | new | All-green check inside transaction; release snapshot persisted (doc 06 §7 last para) |
| `packages/ui/src/gates/GateMatrix.tsx` + ops order page | new | Doc 21 gate matrix component; role-specific action buttons, no status dropdowns |

Tests: every single-gate-red combination blocks (combinatorial); release snapshot explains later why release was valid; unauthorized-start recorded as containment event, never auto-advance (edge).

## F-09.4 Milestones and evidence

Covers: doc 06 §8; `BR-OPS-02/03/04`; `FR-505/506`.

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/orders/application/{start-milestone,submit-evidence,verify-milestone,report-delay}.command.ts` | new | Evidence tied to milestone+baseline; verify requires role separation; delay appends forecast revision preserving original plan; backdate needs enhanced permission + reason |
| `apps/worker/src/outbox/handlers/evidence-image.ts` | new | Hash + duplicate-similarity flag (doc 09 §15), EXIF retained privately |
| `apps/portal-web/app/(supplier)/production/*` | new | Work queue, milestone checklist, in-app capture upload (PWA camera), blocker reporting |

Tests: evidence-submitted ≠ verified; verifier = submitter denied; duplicate image flagged for review not auto-rejected (edge); backdate without permission denied (edge).

## F-09.5 Customer curated timeline

Covers: doc 06 §13 rows 4–6; UC-08; doc 21 CuratedTimeline.

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/orders/presentation/customer-timeline.projection.ts` | new | Released milestones only; lane grouping; ETA text rules (no supplier hints, no unsupported promises) |
| `apps/portal-web/app/(customer)/orders/*` | new | Order overview, timeline, released documents/baseline, next-commitment header (doc 14 §8 six questions) |

Snapshot tests: timeline strings/urls/tooltips carry no supplier identity or internal state names; internal issue shows curated "schedule review" wording (doc 06 §13).

## Build notes (2026-10-04) — design at build start

Recorded as plan edits per the protocol:

- Migration is `0014_production.sql` (numbers 0009/0010 were taken). Baseline and transmittal live in `dms` (document control); work package, milestones, forecasts, evidence and containment events in `orders`. `stock_lot`/`stock_movement`/`custody_location` are **not** planted now: no IN-09 command writes them and an unused table is an untested contract; they land with receiving (IN-17).
- Baseline items are chosen from the order's enquiry documents (the customer's released files) plus JobWork internal documents; a version must be `available` and scan-`clean`. `BR-ENG-06` conflict v1: two `governing` items of the same logical type with the same priority block release. Hash is doc 07 §13 verbatim: SHA-256 over canonical JSON of `{documentId, versionId, fileSha256, purpose, governingPriority}` sorted by priority, then document id.
- A transmittal is per purchase order (one recipient organization), cites the baseline and its hash, and creates an `organization` audience grant on each exact version (`BR-ENG-02`) — the supplier never sees a mutable document pointer. A newer baseline supersedes the old transmittal; acknowledgment is per transmittal, with a deadline.
- Work package = one per purchase order (`FR-503` v1: one supplier, sequential milestones). Planning sets dates, the quality-plan flag and the milestone list (default template of five when omitted). Planning is editable until release, frozen after.
- Gate matrix (`release-gates.ts`, pure): commercial (order commercially released, no active credit hold), technical (released baseline, this PO's transmittal acknowledged, PO acknowledged), planning (dates and ≥1 milestone), compliance (supplier profile active, quality-plan flag). Release writes a snapshot of the matrix and the hashes it relied on.
- Supplier starting a milestone on an unreleased package is refused **and** recorded as a containment event in its own transaction (doc 19 §5: record, never auto-advance).
- Evidence is a DMS document version the supplier uploaded (purpose `image`/`certificate`/`specification`); submitting evidence never verifies. A file hash already used as evidence elsewhere is flagged for review, not rejected. Verification needs every evidence file scan-clean, a verifier who is not the submitter, and `jobwork_quality` (or the milestone's verifier role). A backdated actual date (earlier than evidence submission) requires `jobwork_quality` plus a reason; submitted and observed timestamps are both kept.
- When every work package's last milestone is verified the sales order moves to `ready_supplier_dispatch` (customer: "Final checks"); logistics lanes are IN-17.
- Customer timeline shows only verified, customer-visible milestones with their curated labels; a forecast later than plan shows "Schedule under review by JobWork" with no reason text (doc 06 §13).

## Build notes (2026-10-04) — as built

| Plan item | Built as | Deviation / reason |
|---|---|---|
| F-09.1 | `0014_production.sql`; `database/tests/production-constraints.db.spec.ts` (3 tests) | No `transmittal_item` table: a transmittal cites one released baseline and its hash, and baseline items are frozen, so the delivered versions are already immutable. No `operation_route` table: v1 routes are the sequential milestone list. Stock/custody tables deferred to IN-17 (see design notes). |
| F-09.2 | `ProductionCommand.assembleBaseline/releaseBaseline/issueTransmittals/acknowledgeTransmittal`; ops `sales-orders/[id]/production`; supplier drawing pack on `supplier/orders/[id]` | Commands live in the `orders` module (they need sales and purchase orders), not `dms`; the tables are in `dms`. Release re-checks every item is still available and scan-clean at the moment of release. |
| F-09.3 | `domain/production.ts` (`computeReleaseGates`, pure), `ProductionCommand.releaseWorkPackage`, `packages/ui/src/gates/GateMatrix.tsx` (+ axe test) | Gate combination suite is the pure-function table in `apps/api/test/production-domain.spec.ts` (every single-gate-red case). |
| F-09.4 | `ProductionCommand.startMilestone/submitEvidence/verifyMilestone/waiveMilestone/reportDelay`, ops `production` queue | No separate `evidence-image.ts` worker handler: the duplicate check is exact-hash reuse at submission (doc 09 §15 "file hash … flag"), done in the command where the flag is recorded; perceptual similarity and EXIF handling are later work. Evidence must be scan-clean before verification, so the existing scan pipeline is the gate. |
| F-09.5 | `OrdersView.customerOrder` + `ProductionRepository.customerProgress`; portal order page "Verified checkpoints" | Projection added to the existing customer order rather than a separate `customer-timeline.projection.ts`. |
| — | Found by the walkthrough | (1) The production page loaded the full sales order, which `jobwork_quality` may not read, so quality could not open the page it verifies from. Fixed by giving the production view its own order header and PO summary (least privilege) and asserting quality is still refused the commercial order. (2) A supplier's PO kept saying "do not start" after release; it now shows the released state. Found by the API test: an order moved to final checks when one supplier finished while the other's work was not yet planned — completion now requires a completed package for every live PO. |

## Increment exit

- [x] Release impossible with any gate red; gate-combination suite green — 12 single-gate-red cases in `production-domain.spec.ts`; `RELEASE_GATE_RED` asserted through the API (2026-10-04).
- [x] Full Phase 1 chain demo: enquiry → … → acceptance → PO → baseline ack → release → milestone evidence → verified → customer timeline shows released progress — `production.api.spec.ts` end to end, and the browser walkthrough on the dev database (engineering releases and transmits, supplier acknowledges at 390 px, sourcing releases through the gate matrix, supplier uploads a real file that the worker scans, quality verifies, customer sees "Material received").
- [x] Doc 19 §5 edges behave as specified — early start refused and recorded as containment; release blocked while the transmittal is unacknowledged even though files are granted; supplier backdating refused, quality backdating needs a reason and keeps both timestamps; reused photo flagged, not rejected; delay appends a forecast and keeps the plan.
- [x] Full verification (2026-10-04): `pnpm -r build` ok; `pnpm typecheck` ok; `npx eslint .` clean; tests api 186, database 57, ui 129, worker 30, observability 2.
