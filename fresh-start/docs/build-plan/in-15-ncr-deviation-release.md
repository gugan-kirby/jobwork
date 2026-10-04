# IN-15 — NCR, deviation, quality release (Phase 2)

Scope source: [Implementation plan](../24-implementation-plan.md) §5; `FR-703`–`FR-706`; `BR-QLT-01`–`06`; doc 06 §10; doc 09 §§11–14.
Edge cases owned (doc 19 §6): verbal deviation not authoritative; deviation scoped to some quantity/lot only; rework creates new defect (branch lineage); NCR cannot close circularly.
Use cases: UC-19, UC-29; pilot scenarios 7–8.

## F-15.1 NCR migrations and domain

| File | Action | Contents |
|---|---|---|
| `database/migrations/0015_ncr.sql` | new | `ncr` (scope: item/operation/baseline/lot/serial/quantity), `defect`, `containment`, `deviation` (scoped: characteristic, quantity/serial/lot, expiry, warranty effect), `corrective_action` (occurrence/escape causes, effectiveness check), `quality_release` (computed checklist snapshot + hash) |
| `apps/api/src/modules/quality/domain/ncr.ts` | new | Doc 06 §10 machine incl. rework→reinspection loop and branch lineage on repeat failure |

## F-15.2 NCR and deviation commands

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/quality/application/{open-ncr,record-containment,approve-rework,request-deviation,approve-deviation,close-ncr}.command.ts` | new | Deviation approval scoped + expiring, customer approval when contract requires (policy engine); original failed result stays failed (`BR-QLT-02` — result rows untouched, `status-special` projection); closure requires independent verification of all dispositions (`BR-QLT-06`) |
| Ops + supplier NCR screens | new | Containment board, disposition panel (ApprovalPanel), rework plan + reinspection linkage |

Tests: deviation beyond scoped quantity denied (edge); supplier self-release denied (`BR-QLT-03`); circular closure blocked; branch lineage on rework-new-defect (edge).

## F-15.3 Quality release

Covers: doc 09 §14 checklist; `FR-706`.

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/quality/domain/release-checklist.ts` | new | Computed: baseline correctness, verified operations, certificates validity, FAI/final complete, calibrations dispositioned, NCRs closed/deviated in scope, quantity/traceability match (stock lots), packaging evidence |
| `apps/api/src/modules/quality/application/authorize-quality-release.command.ts` | new | Independent releaser (SoD vs evidence creators), immutable release snapshot + hash; scoped quantity release (lot-level via doc 05 §17 ledger) |
| Ops release screen | new | Checklist matrix with evidence links; scoped-quantity selector |

Tests: any checklist item red blocks; scoped release moves only scoped lots to releasable; post-release new defect opens new hold, release history untouched (doc 09 §14).

## Increment exit

- [ ] Pilot scenarios 7 (fail→NCR→rework→reinspect) and 8 (scoped deviation) green.
- [ ] Release snapshot reproducible; dispatch gate (IN-16/17) consumes release facts, not flags.
