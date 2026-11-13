# FW — Full portal walk (every screen and command, three portals, on video)

Scope source: the owner's request of 2026-10-31 to test every function and tool of the three portals — operations (`apps/operations-web`), customer and supplier (`apps/portal-web`) — and to attach a video of the run to the pull request's checks. Doc 13 test strategy, doc 21 §9 (axe and keyboard rules), doc 19 §10 scenarios as the storyline.

**Why a new pass.** The suites prove the API (900+ specs, pilot scenarios 1–12) but drive only 14 browser journeys over a handful of the 98 routes. TP.5 showed that defects survive green API suites and appear only when a screen is driven (D7–D9). No run has driven every screen, and none was recorded.

**Baseline.** `main` at ab435a2 plus the unpublished header-navigation commits (675d494, a495f22) this branch is cut from, so the walk covers the grouped navigation that is about to ship.

## FW.0 Harness

| File | Action | Contents |
|---|---|---|
| `e2e/scripts/prepare-db.mjs` | edit | Cast adds `admin@` (platform_admin, security_admin, auditor), `sourcing2@`, `finance2@`, `quality@`, `quality2@`, `logistics@`. They are needed for reviewer separation, finance second approval, quality review, logistics and administration. The existing journeys are unaffected. |
| `e2e/playwright.walk.config.ts` | new | Projects `walk-setup` (world) → `walk` (serial, one worker). `video: 'on'` at 1280×800, trace on failure. Web servers: API (prepared DB), **worker** (scan pipeline, outbox, notifications; readiness on its metrics port), portal 3002, operations 3001. |
| `e2e/walk/support/walk.ts` | new | `as(page, portal, email)` sign-in with TOTP from the world. Every page gets `guard(page)`, which fails the test on any uncaught page error, any `console.error`, any API response ≥ 500 or any error boundary text. Also `noSideways`, `axe`, and `chapter(page, title)`, an on-screen caption so the video says what is being tested. |
| `e2e/walk/*.spec.ts` | new | Specs below. They run in file order and share one storyline, so records made by earlier chapters feed later ones. |
| `e2e/scripts/stitch-videos.mjs` | new | ffmpeg concatenates each portal's webm clips, in run order, into `e2e/videos/{01-operations,02-customer,03-supplier,00-full-walk}.mp4`. It also writes `videos/index.md` mapping each chapter to its start time. |
| `.github/workflows/ci.yml` | edit | New job `portal-walk` on pull requests: build → migrate → walk → stitch → `upload-artifact` **portal-walk-videos** (mp4s, Playwright HTML report, traces). The job always uploads, so a failed check still carries its video. |
| `e2e/package.json` | edit | Scripts `walk` and `walk:videos`. |

## FW.1 Public and account (portal, anonymous)

`/welcome`, `/start`, `/explore`, `/about`, `/terms`, `/help`, `/offline`. Customer registration: the toggle, the password mismatch error and the terms gate, then verify through the dev `verifyUrl` on `/verify-email` and sign in. A bad verify token shows the refusal. Supplier application on `/register` (categories from `/public/categories`). Login failure message.

## FW.2 Supplier admission (operations ↔ supplier)

- Ops `/suppliers/applications` admits the FW.1 application through `/suppliers/new?application=`. A second application is declined with a reason.
- Invitation accepted on `/accept-invitation`.
- Supplier fills `/supplier/company`, the works address and `/supplier/compliance` (GST, PAN and bank, each with a certificate upload scanned by the worker), plus a certification. It publishes a capability, a machine and a capacity window on `/capabilities`, then sends for review on `/supplier`.
- Sourcing verifies the evidence on `/suppliers/verification`. A second reviewer approves and admits on `/suppliers/[id]`.
- Supplier pauses and resumes work. Ops suspends and reinstates the supplier.

## FW.3 Enquiry to award (customer → operations → supplier)

- Customer runs the `/enquiries/new` wizard through all three steps: parts, quantity breakpoints, a new delivery address in place, a drawing upload, requirements, then submit.
- Draft resume and discard. Withdraw and "Order this again" on a second enquiry.
- Engineering on `/intake/[id]`: start triage, then send a question. The customer answers on `/enquiries/[id]`. Engineering approves.
- Supplier copy: engineering uploads, a second person confirms.
- Thread messages both ways on the enquiry.
- Sourcing `/rfqs/new`: pick candidates, set the deadline and instructions, release.
- Supplier A on `/rfqs/[id]`: "Yes, we are looking", a draft bid, then submit. Supplier B submits, then sends a revised bid with a reason.
- A supplier question in the RFQ thread is answered and shared with every invited supplier.
- Sourcing closes the round, runs the comparison, proposes the award. `/evaluations/[id]` is read.

## FW.4 Approvals, cost sheet, quote, acceptance, payment

- Sales approves the award on `/approvals`.
- On `/awards/[id]`: cost sheet with components → request approval. Finance approves.
- Draft the Standard quotation. On `/quotes/[id]`: preview the document, request approval, sales2 approves, send.
- Customer on `/quotations/[id]`: download. Requests a revision on a second option, which sales replaces with version 2.
- Approver accepts on `/quotations/[id]/accept` (terms checkbox gate).
- Customer pays the advance: `/orders/[id]` "Pay" → `/pay/[intent]` simulated success. The declined path runs on a second invoice.
- `/invoices`, `/invoices/[id]` and `/payments` show the receipt.
- Finance on `/finance`: reconciliation, record a bank credit, propose an allocation. Approve credit terms, then place and release a credit hold on `/sales-orders/[id]`.

## FW.5 Purchase order to production

- Sourcing issues the purchase orders on `/sales-orders/[id]`. Supplier acknowledges on `/supplier/orders/[id]`.
- Engineering on `/sales-orders/[id]/production`: assemble and release the baseline, transmit, plan the work package with standard checkpoints, release to production.
- Supplier acknowledges the drawing pack, starts a checkpoint, uploads photo evidence, submits it, and reports a delay.
- Quality verifies one checkpoint and rejects another's evidence on the production page; `/production` shows the queue.

## FW.6 Quality

- Quality writes the plan from a template on `/quality/plans/[id]`: stages, a measured and an attribute characteristic, save, approve, plan the FAI inspection.
- Ops registers and calibrates an instrument. Supplier registers and calibrates its gauge on `/supplier/quality`.
- Supplier on `/supplier/inspections/[id]`: start, fill the grid, submit, then save a correction.
- quality2 reviews on `/quality/inspections/[id]`: start review, fail with a note, open an NCR.
- Ops NCR on `/quality/ncrs/[id]`: containment → disposition → approve rework.
- Supplier NCR on `/supplier/ncrs/[id]`: containment, rework done, corrective action.
- Quality plans and passes the reinspection, reviews and verifies the corrective action, closes the NCR.
- A second NCR goes to a use-as-is deviation. The customer approver decides it on `/orders/[id]` ("Quality decisions").
- Quality release on `/quality/releases/[wp]`: check → authorize.

## FW.7 Logistics, both legs

- Supplier `/supplier/shipments/new`: packages and lots → save → submit for release.
- Logistics on `/logistics/shipments/[id]`: release. Supplier marks it picked up. Logistics records a carrier update, then receives it (seal, counts, photo).
- Customer material: record and receive on `/sales-orders/[id]`, then issue to the supplier, who acknowledges receipt.
- `/logistics/work-packages/[id]` read.
- Dispatch to the customer on `/logistics/dispatch/new`: lots, packing checklist, deliver-to, tax invoice → plan → address confirmation → submit → release → picked up → carrier update → POD with photo.
- Customer on `/orders/[id]/deliveries/[shipment]`: confirm the address, accept the delivery, and download the delivery note, the conformance certificate and the POD. A second delivery is reported with a problem and resolved by logistics.
- `/orders/[id]/documents` open.

## FW.8 Changes

- Engineering proposes a change on the production page. The customer requests one on `/orders/[id]`.
- `/changes/[id]`: triage → ask for information → customer answers → classify → impact editor (areas, money, PO lines, WIP line, candidate baseline) → interim decision issued and lifted → complete impact.
- Approve on `/approvals`. The customer approver approves on the order. Supplier sends the impact estimate and acknowledges the amendment.
- Release, verify and close the change.
- A second change is withdrawn.

## FW.9 Settlement and support

- Finance issues the balance invoice and the customer pays it.
- Supplier submits a bill on `/supplier/bills`.
- Finance on `/finance/bills`: run the match → schedule → mark paid.
- A mismatched bill takes the exception route, and finance2 approves it.
- `/finance/margin` read.
- Customer raises a case on `/support`, adds information, and withdraws a second one.
- Support on `/support/[id]`: triage → investigate → propose a credit note. Finance approves, carries it out against the invoice, and verifies it. Support closes the case with a customer note.

## FW.10 Console, administration and accounts

- `/queues`: filters, take, hand back, reassign with a reason. `/notifications` on all three portals: mark all read.
- `/leakage-reviews`: a customer message carrying a phone number is held, and a second person releases an edited copy.
- `/audit`: filter by correlation id, load more.
- `/ops-health`: refresh. Dead letters are listed for the admin.
- `/organizations`: add a customer, invite a member, suspend and reinstate a member and the organization, resend and revoke an invitation.
- Customer `/team` and supplier `/supplier/team` invitations.
- `/account/addresses`: add, edit and archive.
- `/profile/edit`.
- `/account/security` on all three portals: enrol MFA with a code, revoke another session, sign out everywhere.
- `/documents` upload and download.
- Logout.

## FW.11 Route sweep and access matrix

Every one of the 98 routes, opened as its owning role at 1280 and at 390, using the storyline's record ids. Each must show its h1 and no error, pass `guard`, not scroll sideways, and have no serious or critical axe finding. Every navigation link and every nav group of all three shells must resolve.

The access checks:

- A customer gets refusal states, not data, on the supplier routes, and the reverse.
- An anonymous visitor to a signed-in route is sent to sign in.
- A JobWork user without the role sees the "not your authority" state rather than a 500.
- No customer-facing screen in the walk contains a supplier name, and no supplier screen contains the customer's name (`BR` identity shielding, checked on every page the storyline opened).

## FW.12 The other branches (2026-11-13)

Scope source: the owner's request of 2026-11-13 to test every page and every action. A read of both apps against the walk counted 101 routes and 248 state-changing actions. One route (`/mail`) was never opened, 60 actions were never performed, and 5 ran only when their button happened to show; all were reject, return, withdraw, cancel, replan or administration branches. Six chapters run after the sweep, so their destructive steps (offboarding, leaving the network, signing out everywhere) touch only the records and users they create.

| Chapter | Covers |
|---|---|
| `13-commercial-alternatives` | Intake decline and frozen revision; release with an eligibility override; "Send anyway", revoke, leakage release and reject; supplier decline; My Quotes; award reject and cost-sheet return; quote withdraw; the requester's quotation (W20) and the approver's rejection; commercial release; the PO conversation |
| `14-supplier-network-alternatives` | Invitation resend, application reject, file return and reject, evidence return, offboard, leave the network, stop offering, a supplier's upload, account restore |
| `15-production-quality-alternatives` | Replan, returned evidence, plan revision, certificate attached to results, accept and reinspect dispositions, a reviewer's correction, invalidation (W16), deviation withdrawal (W17), lot rejection, corrective-action return (W18), supplier containment |
| `16-logistics-alternatives` | Supplier replan and cancel, receiving shortage resolved, delivery edited, override asked, address confirmed and changed, refusal (W19), exception withdrawn |
| `17-changes-settlement-conversations` | Change and deviation rejected by the customer, rating, Pay Now from `/invoices` and `/payments`, bill reject, case reject and action cancel, the three conversations |
| `18-accounts-and-operations` | Notifications opened and marked read on both portals, a new staff member's MFA, session revoke, sign out everywhere, a staff sign-out on the portal, dead letters replayed and dismissed, `/mail` |

## Candidate defects found while reading the screens for this plan

| # | Where | Suspected defect |
|---|---|---|
| W1 | Portal `/supplier` home | Loads the internal-only `GET /rfqs`. The refusal is swallowed, so "Open RFQs" and "Bids sent" always read 0. "Purchase orders" and "Settlements due" are hard-coded to 0. |
| W2 | Ops `/quotes/[id]` | The "Cost sheet lineage" link goes to `/awards`, which has no index page (404). |
| W3 | Portal `/team` invitation | The dev `acceptUrl` is dropped, so a local tester cannot accept without reading the API. Recorded only; the dev mailer file has the link. |

Each confirmed defect becomes a failing walk step first and is fixed on its own `fix/` branch, as in TP.

## Exit

- The walk is green locally and on the pull request.
- The `portal-walk-videos` artifact is attached to the pull request's check: one mp4 per portal plus the whole run, with a chapter index.
- Defects are listed in the Deviations section below with their fixes.
- Servers are stopped after every local run.

## Deviations

**Status (2026-11-01).** All twelve chapters are written. One clean run from a fresh database passed 118 of 118 tests in 10.7 minutes. Stitched, it is 16 minutes of video: the full walk, plus operations, customer and supplier cuts. The fixes ride in this branch as their own `fix(...)` commits rather than separate `fix/` branches, so the walk's video proves each one. The sweep found W14 and W15.

| # | Where | Defect | Fix |
|---|---|---|---|
| W1 | Portal `/supplier` home | The tiles read the internal `/rfqs` (refused) and two hard-coded zeros. | Read `/supplier/rfqs`, `/supplier/purchase-orders`, `/supplier/bills`. |
| W2 | Ops `/quotes/[id]` | "Cost sheet lineage" went to `/awards`, which is a 404. | Link to the round, which holds the award and its cost sheet. |
| W3 | Portal `/team` | The dev `acceptUrl` is not shown. | Recorded only. |
| W4 | `ErrorState` | The support code failed AA contrast on the tint. | On-tint muted token. |
| W5 | API `listMachines` | `c.label` overwrote the machine's own label, so machines showed unnamed. | Alias it; return the joined row after publish. |
| W6 | Thread captions | Own messages and internal notes failed AA contrast. | On-tint muted token. |
| W7 | Portal bid form plus `MoneyInput` | After any reload, prices reset to ₹0 while the old figures still showed, so a revised bid went out at ₹0. Save draft also dropped the prices. | Keep typed lines, start from the live bid or the draft, and save prices with the draft. `MoneyInput` re-syncs when its value changes from outside. |
| W8 | Approvals row for a cost sheet | Linked to `/cost-sheets/:id`, which is a 404. | Link to the award. |
| W9 | Baseline candidates | Offered every JobWork document, including other customers' supplier copies. | Exclude supplier copies and files another order has baselined. |
| W10 | `/approvals` | Admitted only commercial roles, so quality could not see the deviations it must decide. | Other JobWork roles see the requests they may decide, filtered in SQL. |
| W11 | Supplier shipment plan | With no hub address it returned a 500 from the two-parties check. | Refuse `HUB_MISSING` before inserting. |
| W12 | `CommandButton` | A screen's own check ("Say why…") was labelled UNEXPECTED. | A plain `Error` shows its message without a code. |
| W13 | Unread notifications | Body and time failed AA contrast. | On-tint muted token. |
| W14 | Portal `/welcome` | The page had no heading for assistive technology: the `Hero` headline was a paragraph. | A splash Hero renders its headline as the h1. |
| W15 | Operations, signed out | Every screen rendered "Authentication required" beside "Nothing waiting", with no way to sign in. | The shell sends a 401 to `/login`. |
| W16 | `MeasurementGrid` | A decided grid has no controls, so its sideways scroll could not be reached by keyboard (axe `scrollable-region-focusable`). | A named region with `tabIndex=0`. |
| W17 | Deviation withdrawal | Withdrawn before JobWork decided, its approval request stayed pending; deciding it could only be refused (`DEVIATION_NOT_PENDING`), and the queue kept it. | The withdrawal supersedes the request in the same transaction. |
| W18 | Ops NCR, corrective action | Return needed a note the page showed only at closure, so it could not be enabled while the NCR waited for a disposition. | Return has its own "What is missing" field. |
| W19 | Ops delivery, refused | The "Open the return" link sat in the handover card, which a refused delivery (no POD) never shows. | The card shows whenever there is a return leg. |
| W20 | Customer quotation | Accept and Reject were offered to a requester, whom the API refuses (only `customer_approver` decides). | The projection's actions follow the reader's roles; Reject and Request a revision honour them. |
| W21 | `/approvals` decided filters | Ordered oldest first under a limit of 100, so a long history hid every recent decision. | Waiting requests oldest first, decided ones newest first. |

**Plan edits (2026-11-01):**

- Captions are two-second title cards that Playwright's browser renders, not ffmpeg `drawtext` (Homebrew's ffmpeg has no freetype). The cards work with any ffmpeg build.
- The `chapter()` on-screen caption was dropped: the cards name each chapter, and nothing is injected into the page under test, where axe would see it.
- The CI job creates the two object-store buckets with the runner's AWS CLI, because the walk uploads real files and nothing in the stack creates buckets.
- `02-customer.mp4` also carries the public chapters. A test can record several pages, because axe opens a blank helper page for every check, so the stitcher takes the largest recording.

**Harness lessons** (also in the walk's comments):

- `command()` waits for its own API response; the load state is already reached.
- Next's route announcer has `role=alert`; exclude it.
- `datetime-local` takes browser-local time; use `localStamp` and `freshMinute`.
- The e2e database needs JobWork's hub site.
- API-built rounds invite only Anand and Balaji.
- Test phone numbers must not collide with the Kovai contact (the identity guard flags them).
