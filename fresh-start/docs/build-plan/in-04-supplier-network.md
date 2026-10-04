# IN-04 — Supplier network and verification

Scope source: [Implementation plan](../24-implementation-plan.md) §4 IN-04; `FR-105`, `FR-201`–`FR-203`; doc 06 §14 verification lifecycle.
Edge cases owned (doc 19 §4 partial): supplier certification expires after bid (recheck hooks planted); (doc 19 §9) conflicting roles inside supplier org.
Use cases: UC-10, UC-11.
Comparable-platform note: Zetwerk/Xometry both gate network entry on capability vetting; our verification-item model matches that practice.

## F-04.1 Supplier migrations — **done** (2026-09-05)

| File | Action | Contents |
|---|---|---|
| `database/migrations/0005_supplier.sql` | new | `supplier_profile` (1:1 org), `capability` (taxonomy ref, seeded with the 18 launch codes), `supplier_capability` (version chain, validity, evidence doc ref), `machine` (envelope jsonb-validated), `capacity_window`, `certification`, `service_area`, `verification_item` (kind, status, evidence, expiry, reviewer, versioned per doc 06 §14), the `supplier.eligibility` view, a verification-transition trigger and an immutability trigger for settled versions |
| `database/tests/supplier-constraints.db.spec.ts` | new | 6 cases: taxonomy seed + uniqueness; one live declaration per capability with superseded versions readable and un-editable; structural envelope validation; lifecycle transitions and illegal jumps; reviewer required and never the submitter; eligibility projecting from live capabilities and current verification only |

## F-04.2 Verification workflow — **done** (2026-09-05)

Covers: doc 06 §14 states exactly.

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/supplier/domain/verification.ts` | new | State machine, mandatory-kind set, exclusion codes, `computeExclusions` |
| `apps/api/src/modules/supplier/domain/supplier-policy.ts` | new | Who maintains a profile, who may review; the two lists never overlap |
| `apps/api/src/modules/supplier/application/{submit,review,revoke}-verification.command.ts` | new | Reviewer separation, scan-clean evidence, append-on-resubmit |
| `apps/api/src/modules/supplier/application/expire-verifications.command.ts` | new | Service-principal sweep: due → `expired`, approaching → `expiring` |
| `apps/api/src/modules/supplier/presentation/{verification,internal-verification}.controller.ts` | new | Supplier submit/history, reviewer queue/review/revoke, internal sweep route |
| `apps/worker/src/outbox/handlers/verification-expiry.ts` + `main.ts` timer | new | Scheduled scan calling the internal command every `VERIFICATION_SWEEP_MS` |
| `apps/operations-web/app/suppliers/verification/page.tsx` | new | Review queue with evidence link, expiry entry, verify / return-with-reason |
| `apps/api/test/supplier-verification.api.spec.ts` | new | 7 cases (below) |

Tests (green 2026-09-05): submission → queue → verified, creating the profile on the way and auditing both steps; self-review, supplier-side review and account-administrator review all refused; return demands a reason and a resubmission appends version 2 while version 1 keeps its returned state; evidence that is still processing, quarantined, or another organization's is refused, and the same document is accepted once the scan clears it; expiry by stored date drops the mandatory count without altering the item's reviewer or version, and a second sweep settles nothing further; the warning state does not withdraw evidence while revocation bites immediately and is idempotent; `computeExclusions` returns the same codes for the same facts and distinguishes missing, expired and revoked.

## F-04.3 Capability and capacity management (supplier portal) — **done** (2026-09-05)

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/supplier/application/publish-capability.command.ts` | new | `publishCapability`, `registerMachine`, `declareCapacity` — one command class, three named commands, each appending a version and superseding the previous |
| `apps/api/src/modules/supplier/presentation/capabilities.controller.ts` | new | Taxonomy, publish/list for capabilities, machines and capacity, with `?history=true` |
| `apps/portal-web/app/capabilities/page.tsx` | new | Verification status, processes/materials, machines and capacity windows, stating plainly that an edit publishes a new version |
| `apps/api/test/supplier-capabilities.api.spec.ts` | shared with F-04.4 | 7 cases (below) |

Tests (green 2026-09-05): a capability publishes against the taxonomy and an invented code is refused `CAPABILITY_UNKNOWN`; editing publishes v2 while v1 keeps its attributes, turns `superseded`, and cannot be edited even directly in SQL — the live list shows one row, `?history=true` shows both; machines and capacity version identically, with a malformed envelope and a backwards window rejected at the edge.

## F-04.4 Eligibility projection + anonymized capability cards — **done** (2026-09-05)

Covers: `FR-202`/`FR-203`; hard-filter foundation for IN-06 matching (doc 07 §2.1).

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/supplier/infrastructure/eligibility.projection.ts` | new | One query over live capabilities, live certifications, newest verification per kind and published machine envelopes; `computeExclusions` turns it into a verdict plus reason codes, and the same row becomes the anonymized card |
| `apps/api/src/modules/supplier/presentation/capability-cards.controller.ts` | new | `GET /capability-cards` (customer-safe, eligible only) and `GET /capability-cards/eligibility` (internal, with exclusions) |

Tests (green 2026-09-05): a customer's card payload contains no organization id, name, email or profile id — asserted against the serialized payload and its exact key set — and carries only capability, region class, certification types, envelope and a verified flag; the internal eligibility view is refused to a customer and returns reason codes to sourcing; mandatory evidence expiring drops the card at the stored instant, before any sweep runs, and the sweep changes the status without changing the verdict; capability, region and certification filters each exclude before anything is ranked; a suspended organization disappears from cards and reads `organization_suspended` internally.

## Increment exit

- [x] Full chain demonstrated live against the running stack (2026-09-05): internal admin created a supplier organization and invited its estimator (IN-01) → the estimator accepted, uploaded a GST certificate which the real worker scanned to `available`/`clean` (IN-03) → submitted GST/PAN/bank evidence, each verified by an MFA-enrolled sourcing reviewer → published a capability and a machine → appeared as `eligible=true, exclusions=[]` in the projection, with a customer-facing card carrying no trace of the organization's id or name.
- [x] Verification history immutable and audited; eligibility recomputation deterministic (2026-09-05): expiring the GST item in the same demo flipped the verdict to `eligible=false, exclusions=["verification_expired"]` while every item kept its version, status and reviewer; `computeExclusions` is a pure function over the same inputs, and settled capability versions are read-only by database trigger.

Totals at close: 114 automated tests (60 API, 30 worker, 22 database, 2 observability), build/typecheck/lint clean.

### Deviations recorded during build (protocol rule 3)

1. **A constraints test accompanies the migration** (`database/tests/supplier-constraints.db.spec.ts`), matching the F-03.1 precedent; the plan listed the migration alone.
2. **The three capability commands live in one file** (`publish-capability.command.ts`) rather than three, because they share the supplier-profile guard and the supersede-then-append shape; each is still a separately named command with its own operation id and audit action.
3. **Pages follow the existing app layout** — `apps/operations-web/app/suppliers/verification/page.tsx` and `apps/portal-web/app/capabilities/page.tsx` — since neither app has a `(shell)`/`(supplier)` route group yet (same deviation as F-03.5).
4. **`supplier.eligibility` is a view plus a projection class.** The view gives SQL-level consumers the same live-capability filter; the class computes the verdict and reason codes, because doc 07 §2.1 wants exclusions explained, not merely applied.
5. **A second internal route, the verification sweep**, reachable only by the scan-worker principal. The plan implied a worker-side scheduled scan; the state change itself stays an audited named command in the API, as doc 20 §9 requires.
6. **The launch taxonomy is seeded in the migration** (18 codes), which the build-plan README already contemplates: reference data is seeded under `D-21` governance and edited afterwards by audited commands, never ad-hoc SQL.
7. **`expiring` counts as live evidence.** Caught by the tests: the first implementation treated the warning state as a withdrawal, which would have excluded suppliers thirty days early. It warns; only the stored date withdraws.
8. **The reviewer constraint is an implication, not an equality.** The first version said only decided items may carry a reviewer, which made expiry impossible — an expired item keeps the reviewer who verified it, because that is history.
9. **Superseded by F-SO (2026-09-06):** verifying the last mandatory item no longer activates the profile. Admission became an explicit decision (`approveSupplier`), and `onboarding → active` is refused by the database. The eligibility verdict is unchanged: it still reads live evidence plus an `active` profile.
10. **Certifications and service areas have tables and projection support but no commands yet.** They are populated for eligibility filtering; a supplier-facing certification workflow rides with the quality increments (IN-14), which is where certificate evidence is actually reviewed.
