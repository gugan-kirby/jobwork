# IN-14 — Quality plans, inspections, instruments (Phase 2)

Scope source: [Implementation plan](../24-implementation-plan.md) §5; `FR-701`–`FR-702`; doc 09 §§9–10, §16; doc 07 §14 (measurement evaluation); doc 06 §10 inspection states; doc 05 §§4, 9, 18; `BR-QLT-03`, `BR-QLT-05` (and the evidence side of `BR-QLT-01`, `BR-QLT-04`).
Edge cases owned (doc 19 §6): unit mismatch, so cannot evaluate; a value exactly on a boundary (inclusive/exclusive); expired calibration; corrected inspection data supersedes.
Use cases: UC-18, UC-28. Tests: doc 13 §§3, 9.

**Refresh (2026-10-05, before build).** Written at inception. IN-09 has since built work packages, milestones with evidence and verification, release gates and containment. IN-13 has built baseline lineage under change control. The refresh reads that code and the spec sections above. Changes, each with its reason:

| Original | Now | Why |
|---|---|---|
| `0014_quality.sql` | `0022_quality.sql` | 0014 is taken; 0021 is the latest |
| Decimal evaluation (library implied) | Exact rational arithmetic over `BigInt` in the engine. The stored normalized value is a decimal rounded only for display | No decimal library is in the repo. °F→°C (×5/9) has no finite decimal, so any decimal type would round before comparing, which doc 07 §14 forbids |
| Plan "from category template snapshot" | F-14.1 adds versioned quality templates (doc 09 §16) and seeds one launch template | No template infrastructure exists. `D-06` (launch category) is open, so the default is recorded below |
| Compliance gate unchanged | The gate's "quality plan" check reads an **approved plan bound to the work package's current baseline**. The planning checkbox `qualityPlanPresent` is retired | Today it is a checkbox anyone planning can tick, which proves nothing |
| Property tests unspecified | `fast-check` 4.10.2 (devDependency of `apps/api`) | Doc 13 §3 asks for determinism and bounds properties; nothing in the repo generates cases |
| `apps/portal-web/app/(supplier)/quality/*` | `apps/portal-web/app/supplier/inspections/*`, `.../quality/*`, plus a panel on the PO page | Matches the routes as built |
| Three functionalities | Five: UX and the FAI demonstration are split out | Each is verifiable on its own, and the exit criterion (an FAI cycle on the pilot template) needs its own proof |
| Unspecified in the spec | Rollup, permissions and sampling are taken as owner defaults (table below) | Doc 06 §10 gives states, not guards. Doc 03 gives authority, not a command matrix |

**Out of scope (named so nothing is silently dropped):**

- NCRs, deviations, rework, release blocking on a failed inspection, certificate validity, and shipment release all belong to IN-15. IN-14 emits `quality.inspection_failed.v1` with criticality, mandatory flags and quantities for IN-15 to consume.
- Re-assessment of past results against a new rule or baseline (doc 09 §10 "explicit later assessment") lands with IN-15 deviations. IN-14 keeps every result immutable with its rule and conversion versions, so a later assessment can be added beside it.
- Measurement uncertainty and guard bands: the decision rule is simple acceptance (owner default).

## F-14.1 Quality schema and reference data

| File | Action | Contents |
|---|---|---|
| `database/migrations/0022_quality.sql` | new | Schema `quality`, in the parts below |
| `database/tests/quality.db.spec.ts` | new | Every immutability trigger and CHECK; illegal inspection transitions refused; one approved plan per work package; the seeded conversions round-trip |

What `0022_quality.sql` creates:

- **Units (doc 05 §§9, 18).**
  - `unit`: code, UCUM code, dimension (length, angle, temperature, mass, torque, hardness_hrc, count), label, whether it is the normalized unit for its dimension.
  - `unit_conversion_version`: immutable, with effective date, source citation and status.
  - `unit_conversion`: version, from, to, `factor_num/den`, `offset_num/den`, all as exact integers.
  - Seed v1 from NIST SP 811 / SI exact definitions: inch→mm 25.4; µm→mm 1/1000; m→mm 1000; g→kg 1/1000; °F→°C ×5/9 −160/9; K→°C +(−273.15).
  - No conversion is seeded for HRC or for count.
- **Templates (doc 09 §16).**
  - `plan_template` (code, label, capability codes).
  - `plan_template_version`: immutable, holding stages, default sampling per stage, template characteristics and `requires_drawing_characteristic`.
  - Seed `cnc_machined_part` v1 (owner default `D-06`).
- **Plans (doc 09 §9; `FR-701`).**
  - `quality_plan`: work package, version_no, status (draft, approved, superseded), template version, baseline, approved_by/at, supersedes.
  - `characteristic` belongs to a plan version:
    - balloon/drawing reference, name, kind (variable or attribute), criticality (critical, major, minor), mandatory;
    - unit and nominal; lower and upper limits with per-bound `inclusive`;
    - accepted values (attribute);
    - stages, sample size per stage, method, instrument kind, reaction plan.
  - Characteristics are frozen with the approved plan by trigger.
- **Instruments.**
  - `instrument`: owner organization, asset tag, kind, range, resolution, unit, status (in_service, retired).
  - `calibration`: append-only; performed_at, due_at, outcome (pass, out_of_tolerance), certificate document version and hash, recorded_by.
- **Inspections.**
  - `inspection`: work package, plan version, baseline, stage, lot/quantity, status with transition trigger (doc 06 §10), inspected_at, submitted_by, reviewer, decision reason, `reinspection_of`, milestone (optional).
  - `inspection_sample`: sample_no, serial/lot/cavity.
  - `inspection_result`, immutable:
    - sample and characteristic; original value string, unit and declared precision;
    - normalized value and unit; outcome (pass, fail, cannot_evaluate) with reason;
    - engine rule version and conversion version;
    - instrument, calibration and calibration status at use (valid, expired, uncalibrated);
    - `supersedes_result_id` with a correction reason.
  - `result_disposition`: one per expired or uncalibrated result; accept or reinspect, with reason and by.
  - `inspection_attachment`: document version and sha256.
- **Platform.**
  - Queue `inspections_awaiting_review` with an SLA policy version.
  - Templates `supplier.inspection_planned` and `supplier.inspection_decided`, each in_app + email.

**Verification (2026-10-05, F-14.1).** `quality.db.spec.ts` (6) covers:

- the six seeded conversions, exact and cited;
- hardness has no conversion and cannot gain one;
- conversions and template versions are never rewritten, only retired;
- characteristic shape: limits each with an inclusivity, or accepted values;
- an approved plan and its characteristics are frozen, with one approved and one draft plan per work package;
- the inspection machine refuses shortcuts and keeps what it was planned against;
- the reviewer is never the submitter;
- results are immutable and superseded once, with a reason;
- calibrations are facts; instruments only retire.

Database suite 85 green.

## F-14.2 Measurement engine

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/quality/domain/rational.ts` | new | Exact `Rational` over `BigInt`: parse a decimal string, add, multiply, compare, round half-even to *n* places for display only |
| `apps/api/src/modules/quality/domain/measurement.ts` | new | `evaluate(measurement, characteristic, conversions)`, described below |
| `packages/test-kit/src/golden/measurements.ts` | new | Hand-computed cases (doc 13 §9), listed below, each with the arithmetic in a comment |
| `apps/api/test/measurement.spec.ts` | new | The golden suite, plus fast-check properties |

How `evaluate` works (doc 07 §14):

- It converts the value **and** both limits as absolute values through the same affine map to the dimension's normalized unit, and never converts a span.
- It compares exactly, using the per-bound inclusivity the characteristic stores.
- It refuses a value with more decimals than its declared precision.
- It returns `cannot_evaluate` when a unit is unknown, the dimensions differ, no validated factor exists (HRC↔anything), or a count is non-integer.
- It returns outcome, normalized value (display-rounded to 6 places), rule version `MEAS-1` and conversion version.
- Attribute characteristics pass only on an accepted value.

The golden cases:

- on each bound, inclusive and exclusive;
- one least-significant digit inside and outside;
- negative limits;
- 12.7000 mm against 0.5 inch;
- 100 °F against a 37.5–38.0 °C band (exactly 37.7̅);
- Kelvin;
- µm surface finish against a mm limit;
- one-sided limits;
- an unknown unit, mixed dimensions, and HRC against HRB;
- an attribute pass and an attribute fail;
- a precision violation.

The fast-check properties:

- the same input gives the same output;
- evaluating in the characteristic's own unit agrees with evaluating after an exact conversion;
- the outcome is monotone in the value between the bounds;
- no input passes when it lies outside a bound by any rational amount.

**Verification (2026-10-05, F-14.2).** `measurement.spec.ts` (43):

- **Golden suite: 36 hand-computed cases**, each with its working in `@jobwork/test-kit`. They include 0.1 inch against a 2.54 mm inclusive limit, which passes exactly where binary floating point (2.5400000000000005) would fail, and a °F span trap.
- **Five fast-check properties:**
  - determinism;
  - inch and its exact mm equivalent agree;
  - no hole between two passing values;
  - nothing outside a bound by any amount passes;
  - exact decimal round-trip.
- **Display rounding** is half-even and never used for judging.

The suite was mutation-checked: ignoring exclusive bounds, and dropping the affine offset, each turned it red.

## F-14.3 Plans, instruments, inspections (API)

| File | Action | Contents |
|---|---|---|
| `packages/contracts/src/quality.ts` | new | Requests and views for plans, characteristics, instruments, calibrations, inspections and results; measurement wire format `{ value: "3.2", unit: "um", declaredPrecision: 1 }` (doc 08 §2) |
| `apps/api/src/modules/quality/infrastructure/quality.repository.ts` | new | All SQL; parallel reads only through `parallelReads` |
| `apps/api/src/modules/quality/application/quality-plan.command.ts` | new | Plan commands, described below |
| `apps/api/src/modules/quality/application/instrument.command.ts` | new | Register an instrument; record a calibration (owner org's quality role, a clean certificate it owns); retire |
| `apps/api/src/modules/quality/application/inspection.command.ts` | new | Inspection commands, described below |
| `apps/api/src/modules/quality/presentation/*.controller.ts` | new | `/quality-plans`, `/inspections`, `/instruments` (doc 08 §5) internal; `/supplier/inspections`, `/supplier/instruments` external |
| `apps/api/src/modules/orders/application/production.command.ts` | edit | The compliance gate reads `QualityPlans.approvedFor(workPackageId, baselineId)`. `qualityPlanPresent` is dropped from the plan request and column use |
| communication rules, worker subscriptions, audit inventory | edit | New events notified or acknowledged; the inventory snapshot is updated |

The plan commands:

- `createFromTemplate` (draft bound to the work package's acknowledged baseline);
- `saveDraft` (replaces the characteristic set, `expectedVersion`);
- `approve` (jobwork_quality; refuses `PLAN_NEEDS_DRAWING_CHARACTERISTIC` and incomplete characteristics);
- `revise` (new draft version copied from the approved one, bound to the current baseline; the old plan is superseded on approval).

The inspection commands:

- **`plan`** (jobwork_quality). Needs an approved plan on the current baseline; the stage must be in the plan. Notifies the supplier.
- **`start`** (supplier quality or org_admin; or jobwork_quality for `jobwork_incoming`).
- **`submitResults`.** The full sample × characteristic set at once:
  - each result is evaluated server-side;
  - each instrument must belong to the submitting organization and be in service, and its calibration status is snapshotted at `inspectedAt`;
  - attachments must be the submitter's own clean files.
- **`correctResult`.** A new row that supersedes the old with a reason. The original is retained. The submitter may do this before review starts; jobwork_quality may during review.
- **`startReview`** (jobwork_quality, not the submitter).
- **`dispositionCalibration`** (jobwork_quality: accept with reason, or reinspect).
- **`decide`.**
  - `passed` is refused while any mandatory characteristic failed, any result cannot be evaluated, any sample count falls short, or any expired calibration is undispositioned.
  - `failed` always needs a reason.
  - Separation: the decider is never the submitter (`BR-QLT-03`).
- **`invalidate`** (jobwork_quality, reason, from under_review, passed or failed). Reinspection is a new inspection naming the old (`BR-QLT-04`).

Tests: `apps/api/test/quality.api.spec.ts` covers:

- a plan from the template; approval refused without a drawing characteristic;
- the compliance gate red until approval, and red again after a baseline change until the plan is revised;
- results in inches against a mm characteristic;
- a boundary value under inclusive and exclusive limits;
- an unknown unit giving cannot-evaluate, which blocks `passed`;
- an expired calibration that blocks until dispositioned;
- a correction that supersedes, with the original kept and the audit showing both;
- a plan revision after the results that never rewrites them;
- the supplier unable to review, and each supplier seeing only its own inspections and instruments;
- every illegal transition refused.

**Deviations (2026-10-05, F-14.3):**

- **Migration `0023_quality_unknown_units.sql`.** The quality API test found that `inspection_result.original_unit` was a foreign key to the known units, so a reading in an undefined unit (microinch) could not be stored. Doc 07 §14 and doc 19 §6 require it to be kept as entered and judged "cannot evaluate". It is now a shape check; the normalized unit stays a foreign key.
- **Compliance gate.** "Quality plan present" is derived in the work-package query: an approved plan whose baseline is released. The planning request no longer takes `qualityPlanPresent`, and the operations checkbox is gone. The old column `orders.work_package.quality_plan_present` is left unused rather than dropped mid-increment.
- **Submission is all at once.** Every sample against every characteristic of the stage in one command, so results are complete before review. A variable characteristic must name its instrument (FR-702); an attribute may not need one (`not_required`). A calibration found out of tolerance counts as "uncalibrated" for the results that used it.
- **A draft follows the baseline in force** each time it is saved. Approval refuses a draft bound to a superseded baseline (`PLAN_BASELINE_STALE`), and so does inspection planning against such a plan.
- **Routes.**
  - `GET /quality-templates` was added.
  - Instruments use one controller on `/instruments` and `/supplier/instruments`, scoped by the actor: JobWork quality manages JobWork's and reads everyone's; a supplier manages its own.
  - Inspections are numbered `QI-YYYY-NNNN`.
- **Notifications** go to the supplier only for inspections it carries out (planned; passed or failed). JobWork's own `jobwork_incoming` inspection notifies nobody outside.
- **`quality.inspection_failed.v1`** carries the failed characteristics with criticality, mandatory flag, drawing reference and sample numbers, for IN-15.

**Verification (2026-10-05, F-14.3).** `quality.api.spec.ts` (8) covers:

- instruments kept to their owner;
- an FAI with inch input, an inclusive boundary, an expired caliper and a 32/3.2 µm transcription corrected by JobWork quality with the original kept;
- a pass refused until the caliper is dispositioned;
- a cannot-evaluate (microinch) and a failed critical bore, with the event payload checked;
- reinspection rules;
- JobWork's own inspection reviewed only by a second quality user;
- every state shortcut refused.

In addition:

- `change.api.spec.ts`: a released change makes the plan stale (gate red, planning refused) until it is revised and approved.
- `production.api.spec.ts`: compliance is red until a real plan is approved.
- The pilot driver approves a launch-template plan in `intoProduction`.

747 tests green.

## F-14.4 Quality UX

| File | Action | Contents |
|---|---|---|
| `packages/ui/src/quality/MeasurementGrid.tsx` | new | Doc 21 §6, described below |
| `packages/ui/src/quality/MeasurementGrid.spec.tsx` | new | Rendering, cannot-evaluate distinct from fail, axe |
| `apps/operations-web/app/quality/*` | new | Plan editor, inspections, review screen and instruments, described below |
| `apps/operations-web/app/sales-orders/[salesOrderId]/production/page.tsx` | edit | Each work package links its quality plan and inspections; the compliance gate explains a missing plan |
| `apps/portal-web/app/supplier/inspections/[inspectionId]/page.tsx` | new | Result entry (MeasurementInput per cell; a unit change never converts), instrument choice, attachments, submit; then the read-only grid with corrections |
| `apps/portal-web/app/supplier/quality/page.tsx` + PO page panel | new | The supplier's instruments and calibrations; inspections planned on this PO |

How `MeasurementGrid` presents results:

- characteristics × samples;
- original value with its unit, and the normalized value beside it;
- the outcome as glyph and label;
- cannot-evaluate in `status-attention`, never `status-blocked`;
- tabular numerals (`DS-08`) and keyboard navigation (`DS-12`).

The operations quality screens:

- the plan editor (characteristics table, from template, approve, revise);
- `/quality` inspections with a review-queue filter;
- `/quality/inspections/[id]`, the review: grid, calibration dispositions, decide, invalidate;
- `/quality/instruments`.

Browser walk on the dev stack at desktop width and at 390 px.

**Deviations (2026-10-05, F-14.4):**

- `GET /quality-units` was added. Entry screens offer the units in the database's reference data, never a copy in the browser, and a characteristic offers only units of its own dimension.
- The supplier's result entry is a plain table, with labelled inputs per cell (`aria-label`) and serials per piece. Declared precision is the decimal places as typed, so "12.010" declares 3, and nothing is rounded.
- Inspection stage names come from shared label maps in both apps.
- `INSPECTION_STAGES` moved to `@jobwork/contracts/constants`, so browser code keeps zod out of its bundle (F-FE.3 boundary test).
- Operations gained `lib/upload-api.ts`, the portal's narrow `FileUpload` surface, for JobWork's own calibration certificates.

**Verification (2026-10-05, F-14.4).**

- `MeasurementGrid` tests (3, including axe).
- Browser walk on the dev stack (SO-2026-0002, WP-2026-0001):
  1. JobWork quality writes a plan from `cnc_machined_part`; approval is refused without a drawing characteristic; the bore (balloon 7) is added, saved and approved.
  2. QI-2026-0001 (FAI) is planned from the plan.
  3. The supplier registers BG-01 and records its calibration with an uploaded certificate (scanned by the worker), then submits Ra 3.2 µm and the bore as 0.4724 inch (shown as 11.99896 mm).
  4. JobWork quality, badge "1 waiting", reviews and passes.
  5. QI-2026-0002 is measured with VC-02, whose calibration expired, and a 32 µm transcription. Review shows both blockers; the Ra correction keeps the original under "Corrections on record"; accepting the caliper with a reason clears the last blocker; it passes.
- At 390 px the grid scrolls inside its card and the page does not overflow.
- Fixed during the walk: raw stage codes ("fai") on supplier screens, and the reviewer's note marked "(required)" when it is needed only to fail.
- 751 tests green.

## F-14.5 FAI cycle on the launch template

| File | Action | Contents |
|---|---|---|
| `apps/api/test/pilot/scenario-07-fai-cycle.api.spec.ts` | new | The FAI cycle, described below |
| `apps/api/test/pilot/driver.ts` | edit | `approvedQualityPlan(deal)`, used by `intoProduction`, because the compliance gate now needs a real plan |
| `docs/build-plan/uat-checklist.md` | edit | FAI steps per role |

The FAI cycle the scenario runs:

1. An order in production gets a `cnc_machined_part` plan with two drawing dimensions (one critical), surface finish and visual.
2. JobWork quality approves the plan, and the work package releases.
3. An FAI inspection is planned. The supplier records results with a calibrated micrometer and one expired gauge, and submits.
4. JobWork quality dispositions the gauge and corrects one transcription error, with the original retained.
5. JobWork quality passes the inspection.
6. A second FAI with a failed critical dimension is failed, and `quality.inspection_failed.v1` carries what IN-15 needs.

**Verification (2026-10-05, F-14.5).** `scenario-07-fai-cycle.api.spec.ts` (4):

- The work package's release snapshot records the compliance gate passing on an approved `cnc_machined_part` v1 plan: two drawing dimensions (critical bore, major length) plus the template's Ra and visual.
- The first article passes after a 32/3.2 µm correction (five result rows; the 32 µm stays a fail on record) and an accepted out-of-calibration caliper, with a seven-step audit trail.
- A second first article with a 12.031 mm bore cannot pass. Its caliper reading is sent for reinspection, it fails with a note, and `quality.inspection_failed.v1` names the critical bore, balloon 7 and sample 1. The supplier is told of both decisions.
- The customer's order view and the other supplier see nothing.

UAT steps 7.1–7.10 are in `uat-checklist.md`. Doc 19 §10 defines scenario 7 as the whole chain through NCR, rework and reinspection; IN-15 F-15.6 extends this file to it.

## Decisions taken on the owner's behalf

Taken as safe defaults so the build can proceed; each is reversible and recorded here for review.

| Decision | Default | Why it is safe |
|---|---|---|
| Launch category (`D-06`) | Template `cnc_machined_part` v1 for CNC milling, turning and VMC. Stages FAI (1 piece, every characteristic) and final (5 pieces). Visual and surface-finish characteristics are pre-filled. At least one drawing characteristic is required | The pilot deals are machined brackets. The template is narrow (`A-08`) and versioned, so the owner's template becomes v2 without touching jobs already planned |
| Sampling (doc 09 §9 "sampling scheme") | Fixed sample size per stage with acceptance number 0: every sampled piece must conform | No AQL table is specified. c=0 is the strictest common plan and never accepts a lot a looser plan would reject |
| Decision rule | Simple acceptance: the measured value against the limit, no guard band | Uncertainty handling is "where required" (doc 07 §14) and nothing requires it yet; the rule version `MEAS-1` names it |
| Normalized display precision | 6 decimal places, half-even, display only | Evaluation is exact; the stored decimal is for reading |
| Who submits supplier results | `supplier_quality` or `org_admin`; not `supplier_production` | Doc 03 gives inspection to supplier quality. `org_admin` covers one-person shops |
| Inspection rollup | `passed` only with no failed mandatory characteristic, no cannot-evaluate, full samples and dispositioned calibrations. A failed non-mandatory characteristic may pass with a reason | `BR-QLT-01` names mandatory characteristics; a cannot-evaluate is never a pass by guess (doc 07 §14) |
| Expired or missing calibration | The result is kept, flagged, and blocks `passed` until JobWork quality accepts with a reason or orders reinspection | `BR-QLT-05`; doc 19 §6 "invalid/pending quality disposition" |
| Plan approval | jobwork_quality; no second approver | Doc 09 §9 demands independence for results, not plans; the inspection decision is already independent |
| Customer visibility | None in IN-14. The customer sees verified milestones as today | Doc 03 §3: customers see curated or released quality records, which come with IN-15 release |
| Re-assessment against a new rule | Deferred to IN-15 | Results are immutable and carry rule and conversion versions, so the later assessment can be added beside them |

## Increment exit

- [x] Golden measurement suite green, with cannot-evaluate paths proven (unknown unit, mixed dimensions, no factor): `measurement.spec.ts` (43), mutation-checked; microinch end to end in `quality.api.spec.ts`.
- [x] An FAI plan → inspection → results → review cycle demonstrated on the launch template: scenario 7, and the F-14.4 browser walk.
- [x] The compliance gate needs an approved plan on the current baseline (`production.api.spec.ts`, `change.api.spec.ts`). No inspection result is ever rewritten: the database refuses it and corrections supersede (`quality.db.spec.ts`, scenario 7).

**IN-14 build closed 2026-10-05** (PRs #23–#28). Owner items carried: the defaults above for review (`D-06` launch template above all); UAT scenario 7 runs with the owner's UAT on staging.
