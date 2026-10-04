# F-MX — Mobile experience from the 16-screen prototype, and job types

Scope source: `../JobWork_UI_Prototype.png` (sixteen screens, read tile by tile 2026-09-30); doc 00 §8 screen analysis; doc 14 §§2, 4, 12, 15 (prototype disposition); doc 21 (tokens/components); user instruction 2026-09-30: *"there are three job types like job work, new model, and correction/ECN."*
Edge cases owned (doc 19 §3): correction referencing an enquiry that is not the customer's; job-work enquiry with customer-supplied material; guest reaching a transactional route; self-registered account before verification; duplicate registration email.
Use cases: UC-01, UC-02 (job type), UC-10 (customer self-registration variant), UC-36 (profile/security), UC-11 (supplier application).

## Why this increment exists

The prototype is the client's picture of the product; the docs already decided which of its ideas survive (doc 14 §15) and which are corrected (doc 00 §8). What was missing was the *surface*: the portal is a desktop-first set of tables and description lists in a header-nav shell, while the prototype is a phone app with a bottom tab bar, a hero home, card lists, filter chips and a three-stage enquiry wizard. F-MX builds that surface on the corrected model — every screen below states which prototype tile it comes from and which correction it carries.

Corrections applied without exception (doc 00 §8, doc 14 §2, `D-03`, `D-04`, `D-17`):

| Prototype | Built as |
|---|---|
| "Vendor" everywhere | "Supplier"; never shown to a customer |
| Quotes Received listing named suppliers with prices | JobWork quotation options (IN-07 `F-07.6`); no supplier name, city, rating or bid |
| Quote details "Chat" / order "Message Vendor" | "Contact JobWork" → conversation (IN-10); until then a support link |
| Payments wallet + "Add Money" | Payments to JobWork against invoices; no stored value (IN-08 `F-08.4`) |
| "Payment to MechPro Engineers" transactions | "Payment to JobWork — INV-…" |
| Order tracking "Vendor: MechPro" | Curated timeline with no supplier line (IN-09 `F-09.5`) |
| Vendor Dashboard "Total Earnings" | Supplier home: RFQs, bids, POs, settlements (own data only) |
| Register → Vendor tab creates an account | Supplier *application* reviewed by JobWork; admission stays an explicit decision (F-SO) |
| "Continue as Guest" | Public category education only (`D-17`) |

## Job types (product rule, added 2026-09-30)

Every enquiry declares one `jobType`. It is the first question of the wizard because it changes what else is mandatory, what the reviewer checks, and (later) how material custody and GST paperwork run.

| `jobType` | Meaning | Intake consequences |
|---|---|---|
| `job_work` | Treatment or process on goods the customer owns — the CGST Act s.2(68) sense: the customer is the *principal*, sends inputs under a delivery challan (s.143) and files ITC-04. JobWork/supplier add process, not material. | `materialSupply` defaults to `customer_supplied`; reviewer sees a `customer_material_custody` advisory flag (custody/receiving arrives with IN-16; `D-15` is resolved as *supported at intake, custody accounting in IN-16*). |
| `new_model` | A part JobWork has not made for this customer before — new part development from drawings; material sourced by JobWork. | `materialSupply` defaults to `to_be_sourced`; wizard suggests `first_article` inspection; engineering document mandatory (already `missing_documents`). |
| `correction_ecn` | A correction or engineering change to a part already enquired/ordered. Carries the ECN reference and what changed; the new drawing revision governs. | `changeReference` and `changeDescription` mandatory at submit (`missing_change_reference`, blocking); `relatedEnquiryId` optional but must be the customer's own (`RELATED_ENQUIRY_NOT_USABLE`, 422); reviewer sees `change_without_related_enquiry` advisory when nothing on file is referenced. Full ECN control on a live order remains IN-13. |

Terminology (doc 18): **job work** (as above), **new model**, **correction/ECN** (Engineering Change Notice — the communicated, approved change; the request/approval workflow itself is IN-13).

References consulted 2026-09-30: [CBIC circular 38/2018 on job work](https://gstcouncil.gov.in/sites/default/files/2024-06/jobwork_circular_38_of_2018.pdf); [Masters India — job work and supply chain](https://www.mastersindia.co/books/indian-gst-a-comprehensive-guide/job-work-and-supply-chain/); [PTC — what is an ECN](https://www.ptc.com/en/blogs/plm/what-is-an-engineering-change-notification); [Jiga — engineering change orders](https://jiga.io/articles/engineering-change-orders/).

## F-MX.1 Job types

Docs changed in the same change: 01 (`FR-307`), 02 (`BR-REQ-06`), 05 §6 enquiry columns, 14 §4 step 1, 16 (`D-15` disposition), 18 glossary, 19 §3 rows.

| File | Action | Contents |
|---|---|---|
| `database/migrations/0010_job_types.sql` | new | `sourcing.enquiry`: `job_type` (`job_work` default, CHECK), `material_supply` (`customer_supplied`/`to_be_sourced`), `change_reference`, `change_description`, `related_enquiry_id` (self FK). `supplier.capability`: family parents (`machining`, `sheet_metal`, `fabrication`, `casting`) inserted and `parent_id` set on the seeded leaves, so the wizard's Category → Sub category is data, not a client-side map |
| `database/tests/enquiry-constraints.db.spec.ts` | edit | Unknown `job_type` rejected; `related_enquiry_id` must exist |
| `packages/contracts/src/sourcing.ts` | edit | `jobTypeSchema`, `materialSupplySchema`; fields on `saveDraftRequestSchema`, `enquirySchema`, `customerEnquirySchema` (`jobType`, `jobTypeLabel`); new completeness codes |
| `packages/contracts/src/supplier.ts` | edit | `capabilityRefSchema.parentId` |
| `apps/api/src/modules/sourcing/infrastructure/enquiry.repository.ts` | edit | Row/replace/hydrate for the five columns; `enquiryBelongsTo` for the related-enquiry guard |
| `apps/api/src/modules/sourcing/application/save-draft.command.ts` | edit | `relatedEnquiryId` must be the organization's own — same shape as the delivery-site rule |
| `apps/api/src/modules/sourcing/application/copy-enquiry.command.ts` | edit | Copy carries `jobType`/`materialSupply`; a copy of a correction becomes a `correction_ecn` with the *source* as `relatedEnquiryId` and an empty change reference |
| `apps/api/src/modules/sourcing/application/enquiry-snapshot.ts` | edit | Five fields in the frozen revision (they are what was asked for) |
| `apps/api/src/modules/sourcing/domain/enquiry.ts` | edit | `validateForSubmission`: correction needs reference + description |
| `apps/api/src/modules/sourcing/domain/completeness.ts` | edit | `missing_change_reference` (blocking), `change_without_related_enquiry` (advisory), `customer_material_custody` (advisory) |
| `apps/api/src/modules/sourcing/presentation/enquiry-projection.ts` | edit | `jobType` + label in the customer projection |
| `apps/api/src/modules/supplier/infrastructure/*.repository.ts` | edit | Taxonomy returns `parent_id` |
| `apps/api/test/enquiry-intake.api.spec.ts` | edit | Default `job_work`; correction without reference → 422 with `changeReference` path; related enquiry of another org → 422 `RELATED_ENQUIRY_NOT_USABLE`; projection carries `jobType`; copy-of-correction rule; flags on the ops checklist |
| `apps/operations-web/app/intake/[enquiryId]/page.tsx` | edit | Job type, material supply, change reference/description in the requirement pane |

## F-MX.2 Mobile shell

Prototype: bottom bar on tiles 4, 8, 11, 13–16; top bar with back/bell on every inner tile.

| File | Action | Contents |
|---|---|---|
| `packages/ui/src/primitives/Icon.tsx` | new | Closed set of inline stroke icons (home, enquiries, plus, orders, profile, bell, menu, search, chevron, back, upload, document, invoice, payment, quote, location, shield, bolt, check, logout, help, info, edit); `aria-hidden`, sized by `em` |
| `packages/ui/src/layout/TabBar.tsx` | new | Five-slot bottom navigation with a raised centre action; `nav[aria-label]`, `aria-current`, 44 px targets, safe-area padding; hidden ≥ `md` |
| `packages/ui/src/layout/AppShell.tsx` | edit | `tabs` + `primaryAction` props; below `md` the header shrinks to title/back/bell and the tab bar carries navigation; the "Menu" disclosure remains for overflow items |
| `packages/ui/src/layout/Page.tsx` | edit | `back` prop (icon link), `bare` title mode for hero pages, bottom padding for the tab bar |
| `packages/ui/src/tokens.css`, `base.css` | edit | `--tabbar-height`, `--safe-bottom`, brand gradient tokens (`--brand-hero-bg`, `--brand-hero-fg`), `.jw-tabbar*`, `.jw-hero`, `.jw-chips` |
| `packages/ui/src/index.ts` | edit | exports |
| `packages/ui/test/a11y.spec.tsx`, `domain.spec.tsx` | edit | TabBar landmark/current/targets; icons hidden from the tree; QuickAction grid |

## F-MX.3 Public entry — splash, welcome, login, guest explore

Prototype tiles 1, 2. Correction: no "trusted/quality" claim beyond `D-10` (copy says what JobWork does, not guarantees).

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/supplier/presentation/public-categories.controller.ts` | new | `GET /public/categories` — process families and leaves, labels only; no supplier counts, ids or availability (`D-17`) |
| `apps/api/test/public.api.spec.ts` | new | Anonymous 200; payload has no supplier field names; enumeration of `/suppliers/*` unauthenticated still 401 |
| `apps/portal-web/app/welcome/page.tsx` | new | Tile 1 hero (mark, name, tagline, Get started → `/start`, Login / Register) |
| `apps/portal-web/app/start/page.tsx` | new | Tile 2: Login, Register, Continue as guest → `/explore`, Secure/Reliable/Fast trio |
| `apps/portal-web/app/explore/page.tsx` | new | Guest categories from `/public/categories`; any action → sign in |
| `apps/portal-web/app/login/page.tsx` | edit | Prototype styling; unchanged auth flow (MFA step-up intact) |
| `apps/portal-web/app/page.tsx` | edit | Anonymous → `/welcome` |
| `apps/portal-web/app/shell.tsx` | edit | Unshelled routes: `/welcome`, `/start`, `/register`, `/verify-email`; `/explore` gets a minimal public shell |

## F-MX.4 Registration

Prototype tile 3. Customer tab = self-registration (doc 20 §2 "where policy allows" — policy: allowed, verified email before login, no MFA requirement for customers). Supplier tab = application, not an account (F-SO admission).

| File | Action | Contents |
|---|---|---|
| `database/migrations/0011_registration.sql` | new | `iam.email_verification` (user, token hash, expiry, used_at); `iam.user_account.phone`; `supplier.network_application` (company, contact, phone, email, city, process codes, note, status `received`/`admitted`/`declined`, decided_by/at/reason, `admitted_organization_id`) |
| `packages/contracts/src/auth.ts` | edit | `registerCustomerRequestSchema` (fullName, mobile, email, password, organizationName?, acceptTerms literal true), `verifyEmailRequestSchema`, `updateProfileRequestSchema` |
| `packages/contracts/src/supplier.ts` | edit | `supplierApplicationRequestSchema`, `supplierApplicationSchema` |
| `apps/api/src/modules/iam/application/registration.service.ts` | new | `registerCustomer`: user `pending_verification` + customer organization + membership (`org_admin`, `customer_requester`, `customer_approver`) + verification token, in one transaction with audit + outbox `iam.email_verification_issued`; duplicate email → 409 `EMAIL_ALREADY_REGISTERED` *after* the same argon2 cost (AUTH-11 timing); `verifyEmail` consumes the token atomically and activates the user |
| `apps/api/src/modules/iam/presentation/auth.controller.ts` | edit | `POST /auth/register`, `POST /auth/verify-email` (anonymous, CSRF-exempt like login); dev returns `verifyUrl` until SMTP (same posture as invitations) |
| `apps/api/src/modules/iam/presentation/account.controller.ts` | edit | `POST /account/profile` (display name, phone) |
| `apps/api/src/modules/supplier/application/apply-to-network.command.ts` | new | Anonymous application; ops list/decline; **admit** reuses `admitSupplier` and links `admitted_organization_id` |
| `apps/api/src/modules/supplier/presentation/{public-applications,applications}.controller.ts` | new | `POST /public/supplier-applications`; `GET /supplier-applications`, `POST /supplier-applications/:id/{admit,decline}` (jobwork_sourcing) |
| `apps/worker/src/outbox/handlers/email-verification.ts` | new | Mail file with verify link (mailer stub) |
| `apps/api/test/registration.api.spec.ts` | new | Register → cannot log in until verified → verify → login OK with three roles; duplicate email 409; weak password 422; terms not accepted 422; supplier application anonymous 201, listing needs sourcing role, admit creates org + invitation and marks application |
| `apps/portal-web/app/register/page.tsx` | new | Tile 3: Customer / Supplier tabs, the five fields, terms checkbox, "Already have an account? Login"; supplier tab collects company/city/processes and says what happens next |
| `apps/portal-web/app/verify-email/page.tsx` | new | Token consumption + sign-in link |
| `apps/operations-web/app/suppliers/applications/page.tsx` | new | Queue of applications with admit (prefilled admit form) / decline with reason |
| `apps/operations-web/app/suppliers/new/page.tsx` | edit | Accepts `?application=` prefill |
| `apps/api/src/modules/operations/presentation/summary.controller.ts` | edit | `supplier_applications_received` queue |

## F-MX.5 Customer home and notifications

Prototype tile 4.

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/operations/presentation/portal-summary.controller.ts` | edit | Queues gain `quotations_awaiting_decision`, `orders_in_progress`, `invoices_unpaid` (0 until their increments; keys fixed now so the home never changes shape) |
| `packages/ui/src/status/QuickAction.tsx` | new | Icon tile with label and optional count (tile 4 grid) |
| `packages/ui/src/layout/Hero.tsx` | new | Brand gradient banner with headline/subline slot |
| `apps/portal-web/app/page.tsx` | rewrite | Hero, Quick actions (New enquiry, My enquiries, Quotations, Orders, Invoices, Payments), Top categories (families from `/public/categories`), action-needed list; supplier redirect kept |
| `apps/portal-web/app/notifications/page.tsx` | new | Bell target: action-needed items derived from the summary until IN-10's centre |

## F-MX.6 Enquiry wizard in three stages

Prototype tiles 5–7. Doc 14 §4's seven concerns are kept as *sections* inside three *stages*; the plan edit to doc 14 records this. Autosave, conflict handling and 422 → step mapping from IN-05 are preserved unchanged.

| File | Action | Contents |
|---|---|---|
| `apps/portal-web/app/enquiries/new/page.tsx` | rewrite | Stage 1 **Details**: job type (three cards), part/job name, category → sub category (families), material, quantity + unit, delivery location (+ add in place); correction fields when `correction_ecn`; material supply when `job_work`. Stage 2 **Requirements**: upload drawing (accept list per `D-19`), specifications/comments, surface finish, tolerance class + critical tolerance, heat treatment/coating (disclosure), inspection level, required-by date, confidentiality/partial delivery/packaging (disclosure). Stage 3 **Review**: description list as tile 7, file row, Submit. "Add another part" keeps multi-item intake |
| `apps/portal-web/app/enquiries/new/wizard/*.tsx` | new | `DetailsStage`, `RequirementsStage`, `ReviewStage`, `JobTypePicker`, `useDraft` (autosave/version/conflict — extracted from the current page) |
| `packages/ui/src/forms/ChoiceCards.tsx` | new | Radio group rendered as cards (job type, inspection level) |

## F-MX.7 Enquiry list and detail

Prototype tile 8.

| File | Action | Contents |
|---|---|---|
| `packages/ui/src/data/FilterChips.tsx` | new | Single-select chip row (`radiogroup`), scrolls horizontally on phones |
| `packages/ui/src/data/RecordCard.tsx` | new | Reference / title / caption / status / chevron row used by every list in the app |
| `apps/portal-web/app/enquiries/page.tsx` | rewrite | Chips: All · In review · Info needed · Sourcing · Closed; `RecordCard` list; search; drafts and action-needed retained |
| `apps/portal-web/app/enquiries/[enquiryId]/page.tsx` | edit | Job-type line, sectioned layout, back icon |

## F-MX.8 Profile

Prototype tile 16.

| File | Action | Contents |
|---|---|---|
| `apps/portal-web/app/profile/page.tsx` | new | Avatar initials, name, organization, role; Edit profile; menu: My addresses, My documents, Team, Notifications, Security, Help & support, About, Terms; Logout (`POST /auth/logout`) |
| `apps/portal-web/app/profile/edit/page.tsx` | new | Display name + phone → `/account/profile` |
| `apps/portal-web/app/{help,about,terms}/page.tsx` | new | Static content; terms is the versioned text placeholder for `T-*` legal review |

## F-MX.9 Supplier home

Prototype tile 15, rebuilt as the permission-scoped work queue (doc 14 §15).

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/supplier/presentation/*` | edit | `GET /suppliers/me/summary` gains `rfqsOpen`, `bidsSubmitted`, `purchaseOrders` (0 until IN-08), `settlementsPending` (0 until IN-18) |
| `apps/portal-web/app/supplier/page.tsx` | edit | Company card (name, city, network state chip), four overview tiles, quick actions (RFQs, Bids, Purchase orders, Company profile), existing checklist/availability below |
| `apps/portal-web/app/shell.tsx` | edit | Supplier tabs: Home, RFQs, Capabilities (centre), Orders, Profile |

## Following increments (already planned) that complete the prototype

| Prototype tiles | Increment | Screens |
|---|---|---|
| 9 Quotes received, 10 Quote details | [IN-07](in-07-award-cost-quote.md) `F-07.6` | `/quotations`, `/quotations/[id]` — JobWork options, validity countdown, lines/tax/terms, request revision / reject / accept (IN-08) |
| 11 My orders, 13 Invoices, 14 Payments | [IN-08](in-08-acceptance-contracts-payment.md) `F-08.2/4/6` | `/orders`, `/invoices`, `/payments` — payments to JobWork; no wallet |
| 12 Order tracking | [IN-09](in-09-production-baseline.md) `F-09.5` | `/orders/[id]` curated timeline |

IN-06's exit checklist is verified first (its code and tests exist; the checklist was never ticked).

## Status (2026-10-01)

| Functionality | State | Evidence |
|---|---|---|
| F-MX.1 Job types | built | migration 0010; `enquiry-intake.api.spec.ts` +5 cases (16/16); `enquiry-constraints.db.spec.ts` +3; docs 01/02/05/14/16/18/19 updated |
| F-MX.2 Mobile shell | built | `Icon`, `TabBar`, `AppShell` tabs/bell, `Page.back`; `packages/ui/test/mobile.spec.tsx` (44) + axe cases; hero contrast asserted |
| F-MX.3 Public entry | built | `/welcome`, `/start`, `/explore`, login restyle; `GET /public/categories`; `public.api.spec.ts` (3/3) |
| F-MX.4 Registration | built | migration 0011; `POST /auth/register`, `/auth/verify-email`, `/account/profile`; supplier applications (anonymous apply, ops queue, decline, admit-closes-application); `registration.api.spec.ts` (6/6); portal `/register`, `/verify-email`; ops `/suppliers/applications` + admit prefill |
| F-MX.5 Home | built | hero, quick actions with counts, top categories, waiting-on-you; `/notifications`; portal summary gains three fixed zero queues |
| F-MX.6 Wizard | built | `enquiries/new/wizard/{types,useDraft,DetailsStage,RequirementsStage,ReviewStage}`; three stages; job type first; category → sub category from families |
| F-MX.7 List & detail | built | `FilterChips` + `RecordCard` list with search; detail shows job type |
| F-MX.8 Profile | built | `/profile`, `/profile/edit`, `/help`, `/about`, `/terms`; logout |
| F-MX.9 Supplier home | built | company card, overview tiles (RFQs/bids from `/rfqs`; POs and settlements fixed 0), quick actions |

Deviations recorded: schema-level refusals are `400` (`parseBody` → `ValidationFailed`) and domain refusals `422`, so the tests assert that split rather than the 422 the plan text implied. `/suppliers/new` admits with `applicationId` instead of a separate admit command, so the application closes inside the admission transaction (no two-transaction window). Supplier overview counts come from the supplier's own `/rfqs` list rather than a cross-module query in the supplier summary (ES-03 module boundary).

## Increment exit

- [x] Job types: every path above tested; docs 01/02/05/14/16/18/19 updated in the same change.
- [x] Phone-width walkthrough (Chrome, 390 px) of tiles 1–8, 15, 16 against the prototype, defects fixed before close. (2026-10-01: scripted sweep, customer and supplier; four defects found and fixed — bell counted informational queues, notifications listed "With JobWork" as an action, back chevron mis-aligned beside a description, review printed a raw inspection code.)
- [x] `DS-01` grep green (no raw hex/px in `apps/**`); axe clean on every new component. (`tokens.spec.ts`, `a11y.spec.tsx`)
- [x] Guest and unverified accounts cannot reach any transactional route; supplier application cannot create an account. (`public.api.spec.ts`, `registration.api.spec.ts`)
- [x] `pnpm -r build && pnpm typecheck && pnpm lint && pnpm test` green. (2026-10-01: api 131, ui 127, worker 30, database 43, observability 2)
