# Build plan — file-level execution plan

This directory decomposes the [Implementation plan](../24-implementation-plan.md) increments into individually buildable **functionalities** (`F-<increment>.<n>`), each with its file manifest, commands, migrations, named tests, and the doc 19 edge cases it owns. It exists so implementation can proceed autonomously: the plan is the pre-approval.

## Execution protocol

1. **One functionality at a time**, in listed order within an increment; increments in dependency order (doc 24 §2). No broad parallel edits across functionalities.
2. **Tests are part of the functionality.** The listed test cases go green before the functionality is called done; the increment exit checklist goes green before the next increment starts.
3. **No mid-build approvals.** Reversible, in-plan work proceeds without asking. A needed deviation from this plan is made as an edit to the plan file in the same change, with a one-line reason.
4. **Research before guessing.** Uncertain domain flows, library APIs, or version behaviors are checked against official docs/web first (context7 / web search), then implemented. Never invent provider or framework behavior.
5. **Standards apply throughout**: doc 22 (`ES-*`) conventions, doc 21 UI contracts, doc 20 auth rules, doc 23 pipeline gates.
6. **Status** is tracked in the index below (increment granularity) and via each file's exit checklist.
7. **Branches, commits and publishing** follow [Delivery workflow](delivery-workflow.md) (from IN-12): one branch per unit of work, small commits by area, a pull request with green CI before anything reaches `main`, merged with its history intact.

## Increment index

| Increment | Functionalities | Status |
|---|---|---|
| [IN-00 Walking skeleton](in-00-walking-skeleton.md) | F-00.1–F-00.8 | **done** (2026-09-02) |
| [IN-01 Identity & organizations](in-01-identity-organizations.md) | F-01.1–F-01.8 | **done** (2026-09-02) |
| [IN-02 Platform spine](in-02-platform-spine.md) | F-02.1–F-02.6 | **done** (2026-09-02) — roadmap foundation exit |
| [IN-03 Document core](in-03-document-core.md) | F-03.1–F-03.5 | **done** (2026-09-05) |
| [IN-04 Supplier network](in-04-supplier-network.md) | F-04.1–F-04.4 | **done** (2026-09-05) |
| [IN-05 Enquiry intake](in-05-enquiry-intake.md) | F-05.1–F-05.5 | **done** (2026-09-06) |
| [F-DS Design system build-out](f-ds-design-system.md) | F-DS.1–F-DS.8 | **done** (2026-09-06) |
| [F-SO Supplier onboarding & portal](f-so-supplier-onboarding.md) | F-SO.1–F-SO.8 | **done** (2026-09-06) |
| [F-OPS Operations console](f-ops-operations-console.md) | F-OPS.1–F-OPS.5 | **done** (2026-09-06) |
| [F-CX Customer flow](f-cx-customer-experience.md) | F-CX.1–F-CX.5 | **done** (2026-09-06) |
| [F-SN Supplier network life](f-sn-supplier-network-life.md) | F-SN.1–F-SN.3 | **done** (2026-09-06) |
| [F-MX Mobile experience & job types](f-mx-mobile-experience.md) | F-MX.1–F-MX.9 | **done** (2026-10-01) |
| [IN-06 RFQ & bids](in-06-rfq-bids.md) | F-06.1–F-06.7 | **done** (verified 2026-10-01) |
| [IN-07 Award, cost, quote](in-07-award-cost-quote.md) | F-07.1–F-07.6 | **done** (2026-10-01) |
| [IN-08 Acceptance & payment](in-08-acceptance-contracts-payment.md) | F-08.1–F-08.6 | **done** (verified 2026-10-04) |
| [IN-09 Baseline & production](in-09-production-baseline.md) | F-09.1–F-09.5 | **done** (verified 2026-10-04) |
| [F-FE Frontend hardening](f-fe-frontend-hardening.md) | F-FE.1–F-FE.7 | **done** (2026-10-04) |
| [IN-10 Communication](in-10-communication.md) | F-10.1–F-10.4 | **done** (2026-10-04) |
| [IN-11 Operations hardening](in-11-operations-hardening.md) | F-11.1–F-11.6 | **done** (2026-10-04) |
| [IN-12 Pilot readiness](in-12-pilot-readiness.md) | F-12.1–F-12.5 | build **done** 2026-10-05; Phase 1 exit gate open on owner items (UAT, legal/tax, pen test) |
| [IN-13 Engineering change](in-13-engineering-change.md) | F-13.1–F-13.4 | build **done** 2026-10-05; UAT scenario 6 with the owner's UAT; defaults for owner review |
| [IN-14 Quality & inspections](in-14-quality-plans-inspections.md) | F-14.1–F-14.5 | build **done** 2026-10-05; UAT scenario 7 with the owner's UAT; `D-06` default for owner review |
| [IN-15 NCR, deviation, release](in-15-ncr-deviation-release.md) | F-15.1–F-15.6 | build **done** 2026-10-05; UAT scenarios 7–8 with the owner's UAT; defaults for owner review |
| [IN-16 Logistics leg 1 & receiving](in-16-logistics-leg1-receiving.md) | F-16.1–F-16.6 | build **done** 2026-10-05; UAT scenario 10 with the owner's UAT; defaults for owner review |
| [IN-17 Dispatch & delivery](in-17-dispatch-delivery.md) | F-17.1–F-17.6 | **done** 2026-10-07 (PRs #44–#50); tested in the test pass, 2026-10-10 |
| [IN-18 Settlement & support](in-18-settlement-support.md) | F-18.1–F-18.4 | **done** 2026-10-07 (PRs #52–#56); tested in the test pass, 2026-10-10 |
| [TP Phase 2 test pass](tp-phase2-test-pass.md) | TP.1–TP.6 | **done** 2026-10-10 (PRs #57–#63 and TP.6): IN-17/IN-18 specs, scenarios 11–12, browser walk, Phase 2 exit; D1–D13 fixed; owner items carried |
| [F-FP Fixed-price path](f-fp-fixed-price-path.md) | F-FP.1–F-FP.7 | **planned** 2026-10-10 (owner request): customer target price, JobWork-set supplier and customer prices, neutral filenames and reviewed supplier copies |

**F-CX** closes the customer-side dead ends the same audit found on the internal side: a draft nobody could reopen, an enquiry nobody could withdraw or repeat, and an enquiry that never said where it ships. **F-OPS** builds the console the queue screens were hanging off: a command center with real counts, and the organization/user administration that existed only as API routes. **F-SO** is likewise cross-cutting: IN-04 built the supplier domain but neither surface that admits a supplier or lets it describe itself, and IN-06 cannot invite a supplier that was never admitted.

**F-MX** (2026-09-30) builds the phone-first surface the sixteen-screen prototype shows — tab bar, hero home, card lists, three-stage wizard, registration, profile — on the corrected transaction model, and adds the three job types (job work, new model, correction/ECN) the client named. Prototype tiles for quotations, orders, invoices, payments and tracking land inside IN-07/08/09 as already planned.

**F-FE** (2026-10-04) fixes what every screen inherited from shared frontend code before IN-10 copies it further: failed requests that spun forever, Zod and every contract schema shipped to every route, no response security headers, full page loads on every internal link, buttons nested in links, and no error boundaries. It adds `@jobwork/web-kit` and moves the PWA work F-DS deferred into IN-11 as F-11.6.

**F-DS** is a cross-cutting increment, not a doc 24 roadmap step: it builds the doc 21 component inventory that IN-00–IN-05 deferred and retrofits every screen onto it, so later increments stop re-declaring inline styles. It sits before IN-06 because each further increment would otherwise add to the retrofit.

## Use-case coverage matrix (doc 19 §1)

| UC | Covered by | UC | Covered by |
|---|---|---|---|
| UC-01 | F-04.4, F-05.3 | UC-21 | F-05.4 |
| UC-02 | F-05.2, F-05.3 | UC-22 | F-06.2, F-06.3 |
| UC-03 | F-03.2, F-03.3, F-03.5 | UC-23 | F-07.2 |
| UC-04 | F-05.4, F-10.2 | UC-24 | F-07.3 |
| UC-05 | F-07.6, F-08.2 | UC-25 | F-07.5 |
| UC-06 | F-13.3, F-15.2 | UC-26 | F-05.4, F-09.2 |
| UC-07 | F-08.4, F-08.5 | UC-27 | F-13.2 |
| UC-08 | F-09.5, F-17.4 | UC-28 | F-14.3 |
| UC-09 | F-17.3 | UC-29 | F-15.2, F-15.3 |
| UC-10 | F-01.3, F-04.2 | UC-30 | F-08.5 |
| UC-11 | F-04.3 | UC-31 | F-18.1 |
| UC-12 | F-06.4 | UC-32 | F-16.3 |
| UC-13 | F-06.4, F-10.2 | UC-33 | F-17.2 |
| UC-14 | F-06.5 | UC-34 | F-18.2 |
| UC-15 | F-06.5 | UC-35 | F-07.3, F-11.1, F-14.1 (see note) |
| UC-16 | F-08.3, F-09.2 | UC-36 | F-01.5 |
| UC-17 | F-09.4 | UC-37 | F-02.6 (see note) |
| UC-18 | F-14.3 | UC-38 | F-02.3, F-11.1 |
| UC-19 | F-15.2 | UC-39 | Phase 3 (see note) |
| UC-20 | F-16.2 | UC-40 | F-03.3, F-10.4 |

Notes on deliberate partials:

- **UC-35** (platform configuration): approval-policy, SLA/calendar, and quality-template storage are built where listed; a consolidated configuration console is intentionally thin for MVP — taxonomy/reference data is seeded under the `D-21` governance decision and edited by audited commands, with a full authoring UI added when operations volume demands it.
- **UC-37** (auditor export): read/explore ships in F-02.6; watermarked scoped export packages are a Phase 2+ extension of the same surface, tracked in IN-11 backlog.
- **UC-39** (supplier score recomputation): deferred to Phase 3 by the roadmap (doc 15 §6); eligibility freshness (F-04.4) covers the MVP need. Closed-loop facts accumulate from IN-16/IN-18 events so scores can be computed later without data loss.

Edge-case ownership: every table row in doc 19 §§3–9 appears in exactly one increment file's "Edge cases owned" line (a few appear twice where two layers must both defend, e.g. rollback-notification). The pilot scenarios (doc 19 §10) are asserted end-to-end in F-12.1 and completed by IN-18.

## External references consulted

Comparable-platform research validating flow decisions (fetched 2026-09-02): [Zetwerk — how it works](https://www.zetwerk.com/en-us/manufacturing-services/how-zetwerk/) and [Zetwerk OS](https://www.zetwerk.com/technology/) (contractual-supplier model, checkpoint tracking, stage photos, supplier dashboards); [Xometry — how it works](https://www.xometry.com/how-xometry-works/) (configuration-page fields, inspection options at quote time, capability/capacity matching); [Fictiv — platform](https://www.fictiv.com/our-platform) and [radical transparency](https://www.fictiv.com/articles/introducing-fictiv-radical-transparency-an-industry-first-solution-for-production-visibility) (DFM feedback loop, pre-ship inspection photos, order document archive, reorder). Patterns adopted: inspection requirements captured at enquiry (F-05.3), released inspection photos before dispatch (F-17.3), reorder/copy-enquiry (F-05.2).
