# IN-13 — Engineering change control (Phase 2)

Scope source: [Implementation plan](../24-implementation-plan.md) §5; doc 06 §9 state machine; doc 09 §§7–8; `FR-604`–`FR-605`; `BR-ENG-05`.
Edge cases owned (doc 19 §3/§5): new revision after quote; new revision after production start; customer urgent change (interim stop/continue); (doc 19 §10) pilot scenarios 5–6.
Use cases: UC-06, UC-27.

## F-13.1 Change migrations and domain

| File | Action | Contents |
|---|---|---|
| `database/migrations/0013_change.sql` | new | `change_request` (origin, classification, urgency, status), `change_impact` (doc 09 §8 matrix areas as structured rows), `change_decision`, interim `containment_decision` (stop/continue scope) |
| `apps/api/src/modules/dms/domain/change.ts` | new | Doc 06 §9 machine: proposed→triage→clarification→impact_analysis→commercial_approval→approved/rejected→released→implemented→verified→closed |

## F-13.2 Change commands

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/dms/application/{propose-change,classify-change,record-impact,decide-change,release-new-baseline,verify-change}.command.ts` | new | Impact requires all doc 09 §8 areas answered or n/a-with-reason; approval uses policy engine (customer approval required flag per contract); release creates superseding baseline + transmittal, WIP disposition recorded |
| Interim authority: `issue-containment.command.ts` | new | Scoped stop/continue with expiry; formalization required (emergency cannot bypass, doc 06 §9) |

Tests: post-baseline revision auto-opens change (`BR-ENG-05`); silent baseline replacement impossible; price/date deltas route through commercial approval (re-quote path to IN-07); WIP/scrap captured into cost-object journals (doc 05 §8).

## F-13.3 Change UX

| File | Action | Contents |
|---|---|---|
| `apps/operations-web/app/(shell)/changes/*` | new | Impact matrix editor, decision panel, baseline diff (old vs candidate manifests) |
| `apps/portal-web/app/(customer)/orders/[id]/changes/*` | new | Customer decision card: impact summary, price/date effect, approve/reject with authority (doc 14 §4) |
| `apps/portal-web/app/(supplier)/changes/*` | new | Acknowledgment + feasibility/impact input |

## Increment exit

- [ ] Pilot scenarios 5 and 6 (revision after bid; change after production start with scrap/requote) green end to end.
- [ ] Old baseline evidence untouched; every affected work package shows which baseline it actually used.
