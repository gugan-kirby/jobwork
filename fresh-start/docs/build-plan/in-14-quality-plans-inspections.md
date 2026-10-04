# IN-14 — Quality plans, inspections, instruments (Phase 2)

Scope source: [Implementation plan](../24-implementation-plan.md) §5; `FR-701`–`FR-702`; doc 09 §§9–10; doc 07 §14 (corrected evaluation); doc 06 §10 inspection states.
Edge cases owned (doc 19 §6): unit mismatch → cannot evaluate; boundary value inclusive/exclusive; expired calibration; corrected inspection data supersedes.
Use cases: UC-18, UC-28.

## F-14.1 Quality migrations

| File | Action | Contents |
|---|---|---|
| `database/migrations/0014_quality.sql` | new | `quality_plan` (baseline-bound, template version), `characteristic` (nominal/limits + per-bound inclusivity rule + unit + method + sampling + criticality), `inspection`/`inspection_sample`/`inspection_result` (original + normalized value/unit, rule version, cannot-evaluate state), `instrument`/`calibration`, unit-conversion reference tables (doc 05 §18) |

## F-14.2 Measurement engine

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/quality/domain/measurement.ts` | new | Decimal evaluation per doc 07 §14: affine conversion of absolute values, per-bound comparison rule, declared precision, cannot-evaluate on unknown unit |
| `packages/test-kit/src/golden/measurements.ts` | new | Hand-computed golden cases incl. °C/°F offsets, boundary hits, precision extremes (doc 13 §9) |

Property tests: determinism, no premature rounding, conversion round-trip within declared precision.

## F-14.3 Plans, inspections, results

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/quality/application/{create-plan,plan-inspection,submit-results,review-results,invalidate-result}.command.ts` | new | Plan from category template snapshot (doc 09 §16); results retain instrument+calibration status; correction = supersession with reason, original retained |
| `packages/ui/src/quality/MeasurementGrid.tsx` | new | Doc 21 grid: original+normalized, cannot-evaluate distinct from fail, tabular numerals |
| `apps/portal-web/app/(supplier)/quality/*` + ops review screens | new | Submission forms, certificate uploads (dms), review queue |

Tests: expired calibration invalidates evidence pending disposition (edge); spec change never rewrites past results (doc 09 §10); failed mandatory characteristic feeds release blocker (IN-15).

## Increment exit

- [ ] Golden measurement suite green; cannot-evaluate paths proven.
- [ ] FAI-style plan → inspection → results → review cycle demonstrated on pilot category template.
