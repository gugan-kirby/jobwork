# IN-15 — NCR, deviation, quality release (Phase 2)

Scope source: [Implementation plan](../24-implementation-plan.md) §5; `FR-703`–`FR-706`; `BR-QLT-01`–`06`; doc 06 §10; doc 09 §§11–14; doc 03 §4 (deviation and quality release rows).
Edge cases owned (doc 19 §6): verbal deviation not authoritative; deviation scoped to some quantity or lot only; rework creates a new defect (branch lineage); an NCR cannot close circularly.
Use cases: UC-19, UC-29, UC-06 (customer deviation decision). Pilot scenarios 7 and 8 (doc 19 §10).

**Refresh (2026-10-05, before build).** Written at inception. IN-14 has since built quality plans, instruments and independently reviewed inspections (`quality.inspection_failed.v1` already carries failures with criticality, mandatory flag, balloon and sample numbers). IN-13 has built the customer-decision pattern for changes, and the approval rail takes effects through `ApprovalEffectRegistry`. The refresh reads that code and the spec. Changes, each with its reason:

| Original | Now | Why |
|---|---|---|
| `0015_ncr.sql` | `0024_ncr_deviation_release.sql` | 0015 is taken; 0023 is the latest |
| Release scope "lot-level via doc 05 §17 ledger" | Scope by quantity plus the lot and serial text inspections record. IN-16 attaches its `stock_lot`s to release facts | The stock ledger (`logistics.stock_lot`, `stock_movement`) is IN-16's. A supplier-side release precedes the first leg and JobWork receiving, where lots are created (doc 05 §17) |
| Events `ncr.opened`, `deviation.approved` (doc 08 §7) | `quality.ncr_opened.v1`, `quality.deviation_approved.v1`, `quality.release_authorized.v1` | The code's convention (`<module>.<fact>.v1`); the meaning is unchanged |
| Disposition list implicit | Mapped onto doc 06 §10's three branches, below | Doc 09 §11 lists six dispositions; the diagram has three paths |
| Three functionalities | Six: schema; NCR and corrective action; deviation; release; UX; pilot scenarios | Each is verifiable on its own. The deviation needs the approval rail and a customer decision, the release a computed checklist |
| Pilot scenario 7 | IN-14's `scenario-07-fai-cycle` covers the failed-measurement half; F-15.6 extends it through NCR, rework, reinspection and closure | Doc 19 §10 defines 7 as the whole chain |
| Order status `quality_hold` / `quality_released` | Not set by IN-15. Release facts and open blocking NCRs are exposed as a query, and IN-16's dispatch gate turns them into order status | One owner per transition. Dispatch is where a hold stops goods moving (doc 10 §12) |

**Disposition mapping (doc 09 §11 onto doc 06 §10):**

| Disposition | Branch | Then |
|---|---|---|
| Rework, remake, sort | `approveRework` (an approved plan) → `rework` → reinspection | `passes` → `verified`; `stillNonconforming` → `disposition_pending` as attempt n+1 |
| Use-as-is | `requestDeviation` → `deviation_pending` | `approveDeviation` → `accepted_under_deviation`; `rejectDeviation` → `disposition_pending` |
| Return, scrap | `rejectLot` → `rejected` | Cost responsibility recorded; physical return is IN-16's custody leg |

## F-15.1 Schema

| File | Action | Contents |
|---|---|---|
| `database/migrations/0024_ncr_deviation_release.sql` | new | In `quality`, the tables below; approval kind `deviation` with policy v1; queue `ncrs_open` with SLA; templates `supplier.ncr_opened`, `supplier.ncr_disposition`, `customer.deviation_decision_needed` |
| `database/tests/ncr.db.spec.ts` | new | Transitions, immutability, scope checks, one release snapshot per hash |

The tables:

- **`ncr`** (number `NCR-YYYY-NNNN`):
  - work package, failing inspection, baseline;
  - severity (critical, major, minor), detection stage;
  - affected quantity, lots and serials;
  - status, enforced by a trigger to doc 06 §10;
  - attempt number, `parent_ncr_id` (branch lineage);
  - owner, due date, cost responsibility (supplier, jobwork, customer, undetermined);
  - suspected cause, closure fields.
- **`ncr_defect`**: the failing results it covers, one row per result, never moved.
- **`ncr_containment`**: append-only actions with custody and location text.
- **`ncr_disposition`**: an append-only decision per attempt (rework, remake, sort, use_as_is, return, scrap), with the rework plan text and its reinspection.
- **`corrective_action`**: required by severity. The supplier's problem definition, occurrence cause, escape cause and actions with owners and dates. JobWork's acceptance, then effectiveness verification.
- **`deviation`**: versioned and immutable once requested.
  - Scope: characteristics, quantity, lots and serials, expiry.
  - Assessment: rationale, risk and fit/function/safety.
  - Effects: price, warranty, traceability and labelling.
  - Decisions: the approval request, the customer decision (mirroring `change.customer_decision` with an authority snapshot), and status.
- **`quality_release`**: work package; quantity; lots and serials; the deviations relied on; checklist snapshot (jsonb); `snapshot_sha256`; released by and at. Immutable.

**Verification (2026-10-05, F-15.1).** `ncr.db.spec.ts` (6) covers:

- the doc 06 §10 NCR machine, with scope and attempts that never shrink;
- closure that needs a note and refuses the disposition decider (`BR-QLT-06`), plus branch lineage;
- defects and containment immutable, and the failed result untouched;
- a disposition decided once, its rework, reinspection and outcome each recorded once;
- a corrective action that needs occurrence and escape causes and is verified last;
- a deviation decided exactly as requested, within 180 days, with an immutable customer decision;
- the `deviation` approval policy;
- an immutable release with a SHA-256.

Database suite 91 green; the template pin moved to 29 and the policy pin gains `deviation`.

## F-15.2 NCR and corrective action

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/quality/domain/ncr.ts` | new | The doc 06 §10 machine, attempt lineage, closure rules (below) |
| `apps/api/src/modules/quality/application/ncr.command.ts` | new | The commands below |
| `packages/contracts/src/quality.ts` | edit | NCR, containment, disposition, corrective action requests and views (internal and supplier) |
| `apps/api/test/ncr.api.spec.ts` | new | Tests below |

What `ncr.ts` holds:

- the doc 06 §10 machine and attempt lineage;
- `closable()`: terminal path reached; rework verified by a *passed reinspection planned after the rework approval* whose `reinspection_of` chain reaches the failing inspection; corrective action verified when required; the closer is JobWork quality and not whoever decided the disposition (`BR-QLT-06`, `FR-705`).

The commands in `ncr.command.ts`:

- `open` (jobwork_quality, from a failed inspection's results; scope ≤ inspected quantity), `contain`, `toDisposition`;
- `approveRework` (plan text, supplier sees it), `recordRework` (supplier), then `planReinspection` (IN-14 inspection with `reinspection_of`);
- `passes` and `stillNonconforming`, taken from the reinspection's decision;
- `rejectLot` (return or scrap, cost responsibility);
- `openBranch` (a new defect found during rework → child NCR);
- corrective action: `requestCorrectiveAction`, `respond` (supplier), `accept`, `verifyEffectiveness`;
- `close`.

What `ncr.api.spec.ts` covers:

- fail → NCR → containment → rework plan → supplier rework → reinspection passes → verified;
- closure refused for the disposition approver, for an unverified corrective action, and against the original failing inspection (circular);
- a second failure → attempt 2, with attempt 1 kept;
- a new defect during rework → branched NCR with lineage;
- the supplier sees its own NCRs, responds and cannot close or disposition them;
- the customer sees nothing.

**Deviations (2026-10-05, F-15.2):**

- **One command class, `ncr.command.ts`**, holds the NCR and corrective-action commands (the plan listed separate files). Reads are by audience: JobWork's readers see every NCR, a supplier only its own, a customer none.
- **A reinspection carries its NCR automatically.** The inspection's own decision (or invalidation) moves the NCR in the same transaction: passed → `verified`; failed or invalidated → `disposition_pending`, with the attempt recorded `still_nonconforming`. There is no separate "conclude" command.
- **A branched NCR blocks its parent's closure** until it closes. The plan named branch lineage, not this rule; it is the safe reading of "cannot circularly close".
- **Corrective-action causes.** A cause that is only "operator/human mistake" (or under 15 characters) is refused (`CA_CAUSE_TOO_THIN`), per doc 09 §13.
- **Who records rework.** Supplier quality, org admin or production; JobWork cannot record it for the supplier. Containment can come from either side.
- **Audit inventory.** The scan also recognises the `correctiveCommand` helper, as it does `move`.

**Verification (2026-10-05, F-15.2).** `ncr.api.spec.ts` (5):

- an NCR opens only on standing failed results of a failed inspection, and only that supplier is told;
- supplier containment, isolated from the other supplier and the customer;
- rework judged by new inspections: the first fails (attempt 1 kept as still nonconforming), the second passes with its `reinspection_of` chain intact, and the original result stays `fail`;
- a corrective action refuses "Operator mistake", then is accepted and verified by a second quality member;
- a branched child NCR is scrapped and closed independently;
- the parent's closure is refused for its disposition decider and while the child is open, then closed by the other member, with a fifteen-step audit trail.

757 tests green.

## F-15.3 Deviation

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/quality/application/deviation.command.ts` | new | The commands below |
| commercial approval rail | edit | Unknown kinds route to `ApprovalEffectRegistry`; `deviation` gets a link and label in views |
| `apps/api/test/deviation.api.spec.ts` | new | Tests below |

The commands in `deviation.command.ts`:

- **`request`** (jobwork_quality, from `disposition_pending`): scope within the NCR's scope, expiry ≤ 180 days, rationale and assessments.
- **Approval.** An approval request of kind `deviation` (another quality or engineering member); then, when required, the customer's decision (`customer_approver`, limit type `deviation_acceptance`, authority snapshot).
- **`approve` effect** → NCR `accepted_under_deviation`; **reject** at either step → `disposition_pending`.
- **Results are never touched** (`BR-QLT-02`). Views show results covered by an active deviation as `status-special` ("accepted under deviation").

What `deviation.api.spec.ts` covers:

- a "verbal" path does not exist: no state reaches `accepted_under_deviation` without both approvals;
- the requester cannot approve;
- the customer requester cannot decide;
- a deviation beyond the NCR's scope is refused;
- an expired deviation stops counting for release;
- results remain `fail` in the database.

**Deviations (2026-10-05, F-15.3):**

- **Rail routing.** The approval rail now applies its own kinds (award, cost sheet, quote) and hands every other kind to the module that registered it, instead of listing allocation and change. `deviation` needed no further special case.
- **A request is a disposition attempt.** Requesting a deviation is a `use_as_is` disposition; an internal or customer rejection, or a withdrawal, returns the NCR to `disposition_pending` with the attempt recorded (`deviation_rejected`).
- **The deciders.** The internal approver is recorded as the NCR's disposition decider, so the same person cannot close it (`BR-QLT-06`). A customer decision does not displace that.
- **When the customer sees it.** Only once JobWork has approved it internally and the customer must decide. A deviation withdrawn before that never reaches the customer (found by the test).
- **No customer approval limit.** A deviation carries no amount; the `customer_approver` role, read in the transaction, is the authority, with the approver's acknowledgment of scope in the snapshot. A deviation-specific limit is for the owner (`D-07`).
- **Coverage on results.** Inspection results show `coveredByDeviation` when an approved deviation covers them; the stored outcome stays `fail` (`BR-QLT-02`).

**Verification (2026-10-05, F-15.3).** `deviation.api.spec.ts` (4):

- scope refusals (characteristic, quantity, lot, expiry beyond 180 days);
- no informal path: closing a pending NCR "on the phone" is refused, and a withdrawal returns the NCR;
- the requester cannot approve; engineering does;
- the customer approver decides on its own requirement and actual value with no supplier trace; the requester cannot;
- the NCR is accepted under deviation and the supplier told;
- the failed result stays `fail`, shown as covered;
- a minor, effect-free deviation stays internal: rejected once, approved on the second attempt, and closed by someone other than its approver.

761 tests green.

## F-15.4 Quality release

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/quality/domain/release-checklist.ts` | new | The doc 09 §14 checklist, computed from records, each item pass or fail with its evidence (below) |
| `apps/api/src/modules/quality/application/quality-release.command.ts` | new | `authorize`, plus the release-facts query (both below) |
| `apps/api/test/quality-release.api.spec.ts` | new | Tests below |

The checklist items in `release-checklist.ts`:

1. The baseline in force is acknowledged by the supplier (no pending change).
2. Every milestone is verified or waived.
3. Every certificate attached to a counted inspection is clean and available.
4. The latest inspection of each plan stage is `passed`, or `failed` with every failing result inside an active deviation's scope.
5. Calibrations are valid or accepted.
6. Every NCR on the work package is `closed`, or `accepted_under_deviation` with an active deviation covering the released scope.
7. Released quantity ≤ ordered quantity − already released, and covered lots ⊆ deviation lots where a deviation is relied on.
8. The packing milestone is verified when present.
9. The releaser is jobwork_quality and submitted none of the counted results.

`quality-release.command.ts`:

- `authorize` (jobwork_quality): every item green; scope by quantity, lots and serials; an immutable snapshot with a SHA-256 of its canonical JSON.
- `releaseFacts(workPackageId)`: released quantity and lots, the deviations relied on, and NCRs opened after the last release. This is what IN-16/17's dispatch gate consumes, never a flag.

What `quality-release.api.spec.ts` covers:

- any red item blocks;
- a scoped deviation releases only its lots and the rest stays held;
- an NCR opened after release leaves the release untouched but appears in the facts;
- the snapshot hash reproduces from the stored snapshot;
- the supplier cannot release (`BR-QLT-03`).

**Deviations (2026-10-05, F-15.4):**

- **Lot rules.** Lots under a deviation release on their own, never mixed with other lots in one release, and at most the deviation's quantity less what earlier releases took under it. Without IN-16's per-lot quantities this is the exact reading of "release only scoped items".
- **Which lots are held.** A rejected NCR holds its lots for good. A reworked one holds nothing once verified or closed. A deviated one holds whatever its active deviations do not cover. When any NCR is scoped by lot, a release must name its lots.
- **Inspections counted.** The latest non-invalidated inspection of each plan stage. A later failed inspection therefore turns that stage red again, and a release then waits for its NCR's resolution.
- **Routes.** `POST /quality-releases/checklist` (a preview for a proposed scope; nothing written), `POST /quality-releases`, `GET /quality-releases?workPackageId=`, `GET /work-packages/:id/release-facts`. `quality.release_authorized.v1` is acknowledged until IN-16 consumes it.
- **Snapshot hash.** The snapshot is canonical JSON with keys sorted at every level; `snapshotHash` is exported for anyone to recompute it.

**Verification (2026-10-05, F-15.4).** `quality-release.api.spec.ts` (3):

- the nine items in doc 09 §14's order, red while milestones, inspections and packing are open;
- the supplier is refused and engineering is not a releaser;
- over-quantity is refused;
- a 5-piece LOT-A release once green, its hash recomputed from the stored snapshot;
- a later final inspection fails LOT-B: the NCR shows in the facts as open and after the last release, LOT-B is held with the reason named, and the release history and hash are unchanged.

764 tests green.

## F-15.5 UX

| File | Action | Contents |
|---|---|---|
| `apps/operations-web/app/quality/ncrs/*` | new | The NCR desk, described below |
| `apps/operations-web/app/quality/releases/[workPackageId]` | new | Checklist matrix (GateMatrix), scope selector, authorize, release history with hashes |
| `apps/portal-web/app/supplier/ncrs/[ncrId]` | new | The supplier's NCR: containment, rework record, corrective-action response; read-only dispositions |
| `apps/portal-web/app/orders/[orderId]` | edit | The customer's deviation decision card, beside change decisions: scope, effects (price, warranty, labelling), approve or reject with authority |
| `packages/ui` | edit | `MeasurementGrid` shows a result covered by an active deviation as `status-special`, never pass-green (`DS-04`) |

What the NCR desk shows:

- the list (queue `ncrs_open`);
- each NCR's detail: scope, defects with the measurement grid, containment log, disposition panel (rework plan, deviation request, reject), attempts and branch lineage, corrective action, close.

Browser walk at desktop width and at 390 px.

## F-15.6 Pilot scenarios 7 and 8

| File | Action | Contents |
|---|---|---|
| `apps/api/test/pilot/scenario-07-fai-cycle.api.spec.ts` | edit | Continues from the failed second first article: NCR, containment, rework plan, supplier rework, reinspection passes, corrective action verified, independent closure; then the work package is released |
| `apps/api/test/pilot/scenario-08-scoped-deviation.api.spec.ts` | new | Scenario 8, described below |
| `docs/build-plan/uat-checklist.md` | edit | Scenario 7 continuation, scenario 8 |

Scenario 8:

1. A final inspection fails a minor surface finish on one of two lots.
2. A deviation is scoped to that lot with an expiry, approved internally and by the customer approver.
3. A release covering both lots is refused; the deviated lot and the conforming lot release; the failed results stay `fail`.
4. A release after expiry is refused.

## Decisions taken on the owner's behalf

Taken as safe defaults so the build can proceed; each is reversible and recorded here for review.

| Decision | Default | Why it is safe |
|---|---|---|
| Who opens an NCR | JobWork quality, from a failed inspection or by hand; a supplier responds but does not open | UC-29 gives opening to JobWork quality; doc 03 gives the supplier "NCR response" |
| When the customer must approve a deviation | Always for a critical or major characteristic, and whenever price, warranty or labelling is affected | "When contract requires" is not yet a contract field (doc 03 §4); this errs towards asking |
| Internal deviation approver | Another member of JobWork quality or engineering; never the requester | Doc 03 §4 "internal quality"; the rail already refuses self-approval |
| Deviation expiry | Required, at most 180 days | Doc 09 §12 makes a deviation temporary; a ceiling stops a permanent concession by default |
| Corrective action | Required for critical and major NCRs; optional for minor | Doc 09 §13 applies it "for category/severity where required" |
| NCR closer | JobWork quality, not the member who decided the disposition | `BR-QLT-06` independent verification; the pilot cast has two quality members |
| Releaser | JobWork quality who submitted none of the counted results | Doc 03 §4: the creator of evidence cannot be the sole releaser |
| Certificates on the checklist | Every attached certificate clean and available; a certificate validity model (issuer, standard, expiry) is not built | Doc 09 §14 names validity without a model; the launch template requires no certificate |
| Cost responsibility | Recorded on the NCR; no journal or supplier recovery is posted | Supplier recovery is a settlement hold in IN-18 (doc 10 §5); IN-13's journals are costs owed *to* the supplier |
| Order status `quality_hold` / `quality_released` | Left to IN-16 | The dispatch gate owns the hold (doc 10 §12) |

## Increment exit

- [ ] Pilot scenarios 7 (fail → NCR → rework → reinspection → closure) and 8 (scoped customer-approved deviation) green.
- [ ] The release snapshot is reproducible from its stored checklist (hash check), and `releaseFacts` is the only input the IN-16/17 dispatch gate needs.
- [ ] No path turns a failed result into a pass; no NCR closes on its own evidence or by the person who decided its disposition.
