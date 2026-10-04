# F-SO — Supplier onboarding and the supplier portal

Scope source: `FR-105`, `FR-201`–`FR-203`; doc 03 §§1–2 roles; doc 06 §14 verification lifecycle; doc 14 §5 supplier portal IA and §6 operations IA (supplier 360); doc 20 §§4–6 invitations and audience.
Use cases: UC-10 (organization and user administration), UC-11 (supplier maintains capabilities), plus the two admissions journeys below.
Edge cases owned: doc 19 §9 conflicting roles inside a supplier organization; a supplier organization that exists but has never signed in; approval attempted while mandatory evidence is missing or expired; the same legal entity offered twice.

**Why this increment exists.** IN-04 built the supplier *domain* — profile, capabilities, verification items, eligibility — and one internal review queue. It never built the two surfaces that put suppliers into the network: JobWork admitting a supplier, and the supplier describing itself. Today a supplier organization can only be created by an API call, and a signed-in supplier user sees the customer's navigation with a lone Capabilities page. This increment closes both, and is cross-cutting like F-DS rather than a doc 24 roadmap step; IN-06 needs an admitted, described supplier to invite to an RFQ.

## Admissions model (the two ways a supplier enters)

| # | Entry | Who acts | What it creates |
|---|---|---|---|
| 1 | **JobWork admits the supplier** | Internal `platform_admin` | Supplier organization + supplier profile + the first user invitation, in one transaction |
| 2 | **The supplier describes itself** | Supplier's own users (`org_admin`, `supplier_*`) | Company profile, works site, capabilities/machines/capacity, KYC evidence, certifications — then submits for approval |

Only path 1 creates a supplier: there is no public self-registration, matching the product decision that admission is JobWork's. The onboarding aggregate is shaped so a future public application would be one more entry command writing the same `onboarding` state, not a redesign.

`A-SO-01` (assumption, recorded here for doc 16): admission is restricted to `platform_admin`, the same guard that already governs `createOrganization`. If sourcing should admit suppliers directly, that is one constant in `supplier-policy.ts`.

**Comparable-platform note (R&D, 2026-09-06).** Xometry's partner network registers the partner first, then vets over 3–15 business days, collecting tax forms and certifications, with capability-specific extra steps; Fictiv starts with a questionnaire and adds commercial and quality audits and a test part, qualifying the partner *provisionally* before full ramp. SAP Ariba SLP separates registration from qualification and insists on supplier self-service data entry with internal approval gates. Indian vendor-master practice adds a concrete document set — PAN, GSTIN (verified against the source, not the copy), Udyam/MSME certificate (which triggers the 45-day payment SLA), cancelled cheque plus penny-drop bank validation, address proof — and cross-references PAN across GSTIN/Udyam/CIN, because a mismatch is a fraud signal. Three things follow for us: (a) admission and qualification are separate states, so a supplier can exist and be described before it is eligible; (b) the evidence set is per item with its own expiry and reviewer, which doc 06 §14 already models; (c) duplicate entities must be caught at the identity number, not the name.

Sources: [Xometry partner network](https://www.xometry.com/manufacturing-partner-network-overview/), [Xometry partner FAQs](https://community.xometry.com/kb/articles/840-partner-network-faqs), [Fictiv network vetting](https://www.fictiv.com/our-network), [SAP Ariba SLP](https://www.sap.com/products/spend-management/supplier-lifecycle.html), [Ariba SLP onboarding practice](https://community.sap.com/t5/spend-management-blog-posts-by-sap/streamline-supplier-onboarding-in-ariba-slp-reduce-friction-cut-cycle-time/ba-p/14272958), [Indian vendor onboarding checklist](https://open.money/blog/vendor-onboarding-checklist/), [GST/PAN/MSME vendor master](https://www.kleeto.in/blogs/vendor-onboarding-checklist-india-finance-teams.php).

## Network state (organization level)

`supplier_profile.status` is the network membership state; it is *not* eligibility, which stays a computed projection over verification items (`FR-202`).

```text
onboarding -> submitted -> active          (approve)
onboarding -> submitted -> onboarding      (return with reason)
           \-> rejected                    (reject, terminal until re-opened)
active     -> paused -> active             (suspend / reinstate)
active|paused|onboarding -> exited         (leave the network)
```

Approval is refused while the computed checklist has a blocking row, so "active" can never mean less than the evidence says. A decision records who made it, when, and why; the audit event is the history, not a status column.

## F-SO.1 Onboarding migration and state rules

| File | Action | Contents |
|---|---|---|
| `database/migrations/0007_supplier_onboarding.sql` | new | `supplier_profile`: add `trade_name`, `website`, `year_established`, `employee_band`, `primary_contact_name/email/phone`, `works_site_id` (FK `iam.organization_site`), `submitted_for_approval_at`, `submitted_by`, `decided_by`, `decided_at`, `decision_reason`; extend `status` with `submitted` and `rejected`; transition trigger for the state machine above; `chk_supplier_decided` (an `active`/`rejected` profile names its decider); `chk_supplier_self_decision` (decider is never the submitter) |
| `database/tests/supplier-onboarding.db.spec.ts` | new | 5 cases: every legal transition accepted and every illegal one refused; an `active` profile without a decider refused; decider = submitter refused; works site must belong to the same organization; re-opening a rejected profile keeps the earlier decision fields until a new decision replaces them |

## F-SO.2 Admission — JobWork adds a supplier

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/supplier/application/admit-supplier.command.ts` | new | One transaction: `iam.organization` (type `supplier`) + `supplier_profile` (status `onboarding`) + first `iam.invitation`, one audit event chain and one outbox event; duplicate guard against a verified GST/PAN reference value already held by another supplier |
| `apps/api/src/modules/supplier/presentation/suppliers.controller.ts` | new | `POST /suppliers` (admit), `GET /suppliers` (internal directory with stage, eligibility verdict and exclusion codes), `GET /suppliers/:supplierProfileId` (360 payload) |
| `packages/contracts/src/supplier.ts` | changed | `admitSupplierRequestSchema`, `supplierDirectoryRowSchema`, `supplierDetailSchema` |
| `apps/api/test/supplier-onboarding.api.spec.ts` | new | Cases in the test list below |

## F-SO.3 The supplier describes itself

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/supplier/application/update-profile.command.ts` | new | `updateSupplierProfile` (identity, contact, region class, summary) and `declareWorksSite` (creates/updates the organization's `works` site and points the profile at it), both under `expectedVersion` on `aggregate_version` |
| `apps/api/src/modules/supplier/presentation/profile.controller.ts` | new | `GET /suppliers/me` (profile + checklist + verification + eligibility, supplier audience), `POST /suppliers/me/profile`, `POST /suppliers/me/site` |
| `packages/contracts/src/supplier.ts` | changed | `updateSupplierProfileRequestSchema`, `declareWorksSiteRequestSchema`, `supplierProfileSchema` |

## F-SO.4 Onboarding checklist projection

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/supplier/domain/onboarding-checklist.ts` | new | Pure function over profile + sites + capabilities + verification items + certifications → ordered rows `{ key, label, state: complete/incomplete/blocked, blocking, detail }`; mandatory set is doc 06 §14's (`gst`, `pan`, `bank_account`) plus a works site, one published capability, and a reachable primary contact |
| `apps/api/src/modules/supplier/application/supplier-view.ts` | new | Assembles the checklist with the eligibility projection for both audiences, so the supplier and the reviewer read the same facts |

The checklist is computed, never stored — the F-05.4 precedent. A stored copy would drift the moment an item expired.

## F-SO.5 Submission and decision

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/supplier/application/onboarding-decision.command.ts` | new | `submitSupplierForApproval` (supplier side; refuses while a blocking row stands), `approveSupplier`, `returnSupplierForChanges`, `rejectSupplier`, `suspendSupplier`, `reinstateSupplier` (internal; reason mandatory on every negative outcome; decider ≠ submitter; approval re-checks the checklist at decision time) |
| `apps/api/src/modules/supplier/presentation/suppliers.controller.ts` | changed | `POST /suppliers/:id/{approve,return,reject,suspend,reinstate}`, `POST /suppliers/me/submit` |

## F-SO.6 Certifications, declared and verified

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/supplier/application/declare-certification.command.ts` | new | Supplier declares a certification with type, number, issuer, dates and scan-clean evidence; raises the matching `certification` verification item so the existing review path decides it; expiry feeds the eligibility projection already reading this table |
| `apps/api/src/modules/supplier/presentation/capabilities.controller.ts` | changed | `POST /suppliers/me/certifications`, `GET /suppliers/me/certifications` |

Deviation from IN-04 note 9: certification *declaration* moves here because onboarding is where certificates are collected; certificate review at inspection time stays with IN-14.

## F-SO.7 Supplier portal surfaces (`apps/portal-web`)

| File | Action | Contents |
|---|---|---|
| `apps/portal-web/app/shell.tsx` | changed | Audience navigation: a supplier organization gets Home, Company, Compliance, Capabilities, Documents, Team, Account — and never the customer's Enquiries |
| `apps/portal-web/app/supplier/page.tsx` | new | Supplier home: network status, the checklist with a working link per row, and the submit-for-approval command with its refusal reason shown in place |
| `apps/portal-web/app/supplier/company/page.tsx` | new | Company identity, primary contact, region class, works site — autosaved under `expectedVersion` with the conflict conversation F-05.3 established |
| `apps/portal-web/app/supplier/compliance/page.tsx` | new | KYC items (GST, PAN, bank, Udyam, address proof) and certifications: upload evidence **in place** via `FileUpload` and `lib/upload-api`, submit, see reviewer outcome and expiry; no step may leave the flow to reach an upload |
| `apps/portal-web/app/supplier/team/page.tsx` | new | Invite colleagues into supplier roles and see pending invitations |
| `apps/portal-web/app/page.tsx` | changed | Signed-in supplier lands on its own home rather than the customer's |

## F-SO.8 Operations supplier directory and 360 (`apps/operations-web`)

| File | Action | Contents |
|---|---|---|
| `apps/operations-web/app/suppliers/page.tsx` | new | Directory: stage, eligibility verdict, exclusion codes, last activity; filter by stage and by excluded-only; "Add supplier" opens the admission form |
| `apps/operations-web/app/suppliers/new/page.tsx` | new | Admission form: legal name, display name, region, first user's email and role, optional GSTIN/PAN — refusing a duplicate identity with the existing supplier named |
| `apps/operations-web/app/suppliers/[supplierProfileId]/page.tsx` | new | Supplier 360: identity and contact, checklist, verification items with review actions, capabilities/machines/capacity, eligibility verdict with exclusions, users, and the decision commands with mandatory reasons |
| `apps/operations-web/app/shell.tsx` | changed | Suppliers section points at the directory; the verification queue becomes a tab of it |

## Tests

`apps/api/test/supplier-onboarding.api.spec.ts` (new):

1. Admission creates organization, profile and invitation atomically, writes one audit chain, and the invited user can accept and reach `GET /suppliers/me`.
2. A customer, a supplier and an internal non-admin are each refused admission; only `platform_admin` succeeds.
3. Admitting a legal entity whose GSTIN is already verified against another supplier is refused with the existing supplier's identifier and no partial writes.
4. `submitSupplierForApproval` is refused while any blocking checklist row stands, and the response names the rows.
5. Approval is refused for the user who submitted, and refused again if a mandatory item expired between submission and decision; a distinct reviewer succeeds and the profile becomes `active`.
6. Return-for-changes and reject each demand a reason; return puts the profile back to `onboarding` with its evidence intact; reject is terminal until re-opened.
7. Suspend removes the supplier from capability cards immediately and reinstate restores it, without touching any verification item's version, status or reviewer.
8. A supplier cannot read another supplier's profile, directory or 360, and no customer-facing payload in this increment carries a supplier's name, contact or site (`FR-203`).
9. Checklist correctness: the same facts produce the same rows; an expired mandatory item turns a complete row blocking without any sweep running.

`database/tests/supplier-onboarding.db.spec.ts` (new): the five cases in F-SO.1.

Existing suites must stay green, in particular `supplier-verification.api.spec.ts` and `supplier-capabilities.api.spec.ts`.

## Exit checklist

- [x] Both journeys driven live in the browser (2026-09-06): `platform_admin` admitted *Sri Balaji Precision* from `/suppliers/new` → the invitation was accepted in the portal → the supplier described itself, declared its works address and published `cnc_turning` → uploaded GST, PAN and bank evidence **inside** `/supplier/compliance`, each scanned clean by the real worker → an MFA-enrolled `jobwork_sourcing` reviewer verified all three and returned the empty Udyam item with a reason → the supplier submitted → the reviewer approved → the profile went `active` and `matchable`, and the customer account saw exactly one anonymized card (`cardId`, region, capability, `verified: true` — no name, id, address or contact).
- [x] Approval provably impossible while a mandatory item is missing or expired: refused with `ONBOARDING_INCOMPLETE` naming the rows, in the API spec and again in the UI, where the approve button is unavailable while a blocking row stands. Every negative decision carries a reason (400 without one) and writes an audit event.
- [x] A supplier user never sees a customer surface (navigation is audience-split, `/` redirects a supplier to its own home) and no customer-facing payload carries supplier identity — asserted against the serialized card payload.
- [x] `pnpm -r build && pnpm typecheck && pnpm lint && pnpm test` green: **219 automated tests** (api 81, ui 71, worker 30, database 35, observability 2).

### Deviations recorded during build (protocol rule 3)

1. **Verifying the last mandatory item no longer admits a supplier.** IN-04's `review-verification` command flipped the profile to `active` as a side effect of the final tick; F-SO's state machine makes `onboarding → active` illegal, and admission is now an explicit decision by a person who is not the submitter. `supplier-capabilities.api.spec.ts` was updated to complete the file and go through submit/approve, which is what "so it is eligible" now means.
2. **`chk_supplier_decided` is `NOT VALID`.** Suppliers admitted before this model existed have no decider to name, and inventing one would be worse than grandfathering them; Postgres still enforces the check on every write from here on.
3. **A composite foreign key, not a trigger, keeps a works site inside its own organization** — `iam.organization_site (id, organization_id)` gained a unique constraint so `supplier_profile` can reference the pair.
4. **`GET /organizations/me/members`** (IAM) was added for the supplier's own team page; the member and pending-invitation queries live in `IamRepository`, since membership is an IAM fact the supplier module reads rather than owns.
5. **The dev seed gained `sourcing@jobwork.local`** (`jobwork_sourcing`): evidence review forbids self-review, so a one-account dev environment could not exercise admission at all.
6. **`FileUpload` now generates its input id with `useId`.** The compliance page mounts six uploaders of the same purpose; the old `upload-${purpose}` id repeated six times, so every label pointed at the first input. Found by driving the page, not by a test.
7. **Sending evidence requires evidence.** The first browser pass submitted an empty Udyam item, which reached the reviewer as something they could only return; the send button is now disabled until a scanned-clean document is staged.
8. **The identity numbers captured at admission become `draft` verification items** rather than being stored on the profile: they are claims about the company that still need a document and a reviewer, and the duplicate-admission guard reads them at any status.
