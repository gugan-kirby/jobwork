# VF — Visual fidelity to the sixteen high-fidelity references

Scope source: `../../image/*.png` (sixteen phone screens, received 2026-11-03), user instruction 2026-11-03: *"analyse these reference images and implement the complete application … pixel-accurate … work on one screen at a time."*
Prior art: F-MX built every one of these screens on 2026-10-01 from the low-fidelity `JobWork_UI_Prototype.png`. VF changes the surface only — layout, type, colour, spacing, iconography, illustration — screen by screen. Every command, guard, projection and route stays as built.

## Rules for every screen

1. Open the reference and the current screen side by side at 390 × 844 (phone, DPR 2); list the deltas before editing.
2. F-MX's correction table applies without exception. Where a reference shows something the model forbids, the layout is kept and the content is corrected:

| Reference shows | Built as | Rule |
|---|---|---|
| "Find Trusted Machines. Get Quality Work Done." (01) | What JobWork does, two lines | `D-10` |
| Customer / **Vendor** registration (03) | Customer account / supplier *application* | F-SO, doc 18 |
| Quotes Received: three named vendors with city, rating, price (09) | JobWork quotation options; no supplier name, city, rating or bid | `BR-*` identity shield, `F-07.6` |
| Quote Details vendor block, "Chat" (10) | JobWork as counterpart; "Contact JobWork" → conversation | IN-10 |
| Orders / tracking "Vendor: …", "Contact Vendor" (11, 12) | No supplier line; "Contact JobWork" | `F-09.5` |
| Wallet balance, "Add Money" (14) | Payments to JobWork against invoices; no stored value | `F-08.4` |
| Vendor Dashboard "Total Earnings" (15) | Supplier home: RFQs, bids, POs, settlements — own data only | F-MX.9 |
| "Continue as Guest" (02) | Public category education only | `D-17` |

3. New colours, sizes and radii become tokens or `base.css` classes (`DS-01`; the token specs fail on a raw hex or `px` in an app screen).
4. Accessibility is not traded for fidelity: one h1, 44 px targets, visible focus, the walk's axe scan stays clean.
5. Done = the listed tests green, an after-screenshot that matches the reference, and one commit per screen.

## Screens

| ID | Reference | Route | Status |
|---|---|---|---|
| VF-01 | `JobWork_Screen_01_Splash.png` | `/welcome` | **done** 2026-11-03 |
| VF-02 | `JobWork Industrial Welcome Screen.png` | `/start` | **done** 2026-11-03 |
| VF-03 | `Mobile Register Screen UI.png` | `/register` | **done** 2026-11-03 |
| VF-04 | `JobWork Precision Dashboard.png` | `/` | **done** 2026-11-03 |
| VF-05 | `JobWork New Enquiry Form.png` | `/enquiries/new` stage 1 | **done** 2026-11-03 |
| VF-06 | `New Enquiry Requirements Form.png` | `/enquiries/new` stage 2 | **done** 2026-11-03 |
| VF-07 | `Mobile Review Enquiry Form UI.png` | `/enquiries/new` stage 3 | **done** 2026-11-03 |
| VF-08 | `JobWork Enquiry Dashboard.png` | `/enquiries` | **done** 2026-11-03 |
| VF-09 | `JobWork Quotes Received Screen.png` | `/quotations` | **done** 2026-11-03 |
| VF-10 | `Precision Metals Quote Details.png` | `/quotations/[quotationId]` | |
| VF-11 | `JobWork My Orders Dashboard.png` | `/orders` | |
| VF-12 | `Order Tracking Dashboard UI.png` | `/orders/[orderId]` | |
| VF-13 | `JobWork Invoice Management Dashboard.png` | `/invoices` | |
| VF-14 | `JobWork Payments Dashboard.png` | `/payments` | |
| VF-15 | `Modern JobWork Vendor Dashboard.png` | `/supplier` | |
| VF-16 | `JobWork Profile Settings Screen.png` | `/profile` | |

## VF-01 Splash

Deltas found: navy radial field (was the bright diagonal gradient); a gear-and-wrench mark (was a wrench in a white disc); 48 px name; two-line tagline; actions pinned to the bottom edge with a 60 px white button (was centred under the copy); un-underlined "Login / Register".

| File | Action | Contents |
|---|---|---|
| `packages/ui/src/primitives/BrandGlyph.tsx` | new | Gear + wrench mark in `currentColor`; wrench cut from the gear by a mask (`useId`-scoped ids) |
| `packages/ui/src/layout/Hero.tsx` | edit | `splash`: centred block (art, h1, subline) and a separate bottom action row |
| `packages/ui/src/tokens.css` | edit | `--brand-splash-bg`, `--brand-splash-bg-solid` |
| `packages/ui/src/base.css` | edit | `.jw-hero-splash*`, `.jw-splash-actions`, `.jw-splash-cta`, `.jw-splash-link` |
| `packages/ui/src/index.ts` | edit | `BrandGlyph` export |
| `apps/portal-web/app/welcome/page.tsx` | edit | Uses the above; corrected tagline (`D-10`) |
| `packages/ui/test/mobile.spec.tsx` | edit | Splash actions outside the centred block; `BrandGlyph` decorative with unique mask ids |

Tests: `@jobwork/ui` (181), `@jobwork/portal-web` (21), typecheck, lint. The walk's public chapter (`e2e/walk/01-public.spec.ts`) finds "Get started" by role, case-insensitively, and runs axe on the page; it runs with the batch walk at the end of VF.

## VF-02 Welcome fork

Deltas found: white field without the brand bar; 30 px "Welcome to" in navy ink over a 58 px "JobWork" in the reference's saturated blue; a workshop illustration (was three small icons); 54 px filled Login and 2 px outlined Register; un-underlined "Continue as Guest"; shield-glyph trio with single labels; the guest note under the link removed (the explore page says what a guest can do).
Corrections: the trio stays "Secure · Reviewed · Managed", not "Secure · Reliable · Fast" (`D-10`); each label's meaning is read out to assistive technology.

| File | Action | Contents |
|---|---|---|
| `packages/ui/src/primitives/WorkshopIllustration.tsx` | new | Original flat SVG (milling centre, operator, fitter at bench, column machine), token fills only |
| `packages/ui/src/primitives/Icon.tsx` | edit | `shieldLock`, `shieldCheck`, `shieldBolt` |
| `packages/ui/src/tokens.css` | edit | `--brand-strong(-hover)`, `--color-ink(-muted)` sampled from the references; `--illus-*` fills |
| `packages/ui/src/base.css` | edit | `.jw-entry*`, `.jw-cta`, `.jw-cta-outline`, `.jw-text-cta`, `.jw-assurance` — reused by later VF screens |
| `packages/ui/src/index.ts` | edit | `WorkshopIllustration` export |
| `apps/portal-web/app/start/page.tsx` | rewrite | The fork on the above; links unchanged (`/login`, `/register`, `/explore`) |
| `packages/ui/test/mobile.spec.tsx` | edit | Illustration decorative, every fill a token |

Tests: `@jobwork/ui` (185), `@jobwork/portal-web` (21), typecheck, lint.

## VF-03 Registration

Deltas found: back-chevron header instead of the brand bar and lede; a bordered two-way switch with a tinted, underlined selection (was filled pill buttons); glyph fields with the label as placeholder (were labelled boxes in a card); inline "Terms & Conditions" link in the agreement line; 54 px action; centred "Already have an account? Login".
Corrections: the second tab is **Supplier** and sends an application, not an account (F-SO); the optional company field stays (an enquiry belongs to an organization).
Validation added in the browser (the API still decides): full name ≥ 2, Indian 10-digit mobile when given, email format, password ≥ 12, confirmation match; messages show once a field is left or the form is tried, and the first submit attempt flags every field.

| File | Action | Contents |
|---|---|---|
| `packages/ui/src/forms/IconTextInput.tsx` | new | Glyph field; visually hidden `<label>`, placeholder = label, hint/error on `aria-describedby`, error as `role="alert"` |
| `packages/ui/src/layout/TopBar.tsx` | new | Back chevron (named link), h1 title, trailing slot — the inner header for every later VF screen |
| `packages/ui/src/primitives/Icon.tsx` | edit | `phone`, `mail`, `lock`, `eye` |
| `packages/ui/src/base.css` | edit | `.jw-topbar*`, `.jw-icon-field*`, `.jw-segment`, `.jw-form-page`, `.jw-form-stack`, `.jw-agree`, `.jw-inline-link`, `.jw-form-foot` |
| `apps/portal-web/app/register/page.tsx` | rewrite | Both forms on the above, client validation, shared terms line and submit |
| `e2e/walk/01-public.spec.ts` | edit | Agreement label is "I agree to Terms & Conditions" |
| `packages/ui/test/mobile.spec.tsx` | edit | `IconTextInput` label/error chain; `TopBar` h1 and named back link |

## VF-04 Customer home

Deltas found: phone header is menu · "JobWork" · bell with no rule (was mark + name left, bell and menu right); a compact banner with machines on the right (was a tall hero with a button and three icons); white quick-action cards with large coloured glyphs (were tinted discs); illustrated process tiles four across (were six family icon tiles); rounded tab bar with a larger raised action.
Kept and moved: "Waiting on you" follows the categories; every quick action still carries its count. Dropped: the "Your account" card (the Profile tab holds it) and the banner's "Create enquiry" button (New Enquiry tile and the raised + do the same).
Corrections: "RFQ / Quotes" is **Quotations** — the customer receives JobWork's quotation, never an RFQ or a bid.

| File | Action | Contents |
|---|---|---|
| `packages/ui/src/primitives/IndustryArt.tsx` | new | `BannerMachines` (light on brand), `ProcessArt` (eight process pictures), `processArtFor(code)` |
| `packages/ui/src/status/QuickAction.tsx` | edit | `accent` prop: coloured glyph, no disc |
| `packages/ui/src/layout/AppShell.tsx` | edit | Menu toggle before the name; header and brand styles moved to `base.css` |
| `packages/ui/src/tokens.css` | edit | `--brand-banner-bg`, `--accent-orange/green/sky` |
| `packages/ui/src/base.css` | edit | `.jw-shell-header`, `.jw-shell-brand` (phone), `.jw-banner*`, `.jw-home-*`, `.jw-quick-accent`, `.jw-quick-glyph-*`, `.jw-category-row`, `.jw-category`, tab bar refresh |
| `apps/portal-web/app/page.tsx` | edit | Banner, quick actions, process row (featured: milling, VMC, turning, welding), waiting list |
| `e2e/walk/03-enquiry-to-award.spec.ts`, `e2e/demo/customer.spec.ts` | edit | Home entry link is "New Enquiry" |
| `packages/ui/test/mobile.spec.tsx` | edit | Accent tile speaks its count without a disc; process art mapping |

## VF-05 Enquiry wizard — Details, and the portal phone theme

Deltas found: inner page headed by the app bar *and* a back row (reference: back chevron and centred title only); pill-tab stepper (reference: numbered discs on a rail, labels under); boxed cards (reference: fields straight on white); 40 px square-ish controls with native select arrows (reference: 52 px, 12 px radius, light border, chevron); old action blue; Back as a grey-bordered button (reference: 2 px blue outline).
Kept: the job-type cards, material supply, assisted intake, grade, target price, quantity breaks, add-another-part, delivery card and application notes — product rules the reference predates (F-MX.1, FR-307). They now sit in the reference's visual language.

Most of this is one **portal phone theme** rather than per-screen work, so VF-06–VF-16 inherit it: below `md`, inside `.jw-has-tabbar` (customer and supplier portal; operations has no tab bar and is untouched) the control height, field/button radius, border width, action colour, button font and secondary border tokens switch to the reference values, selects get the chevron, and a page with a back chevron hides the app bar (`:has(.jw-page-back)`).

| File | Action | Contents |
|---|---|---|
| `packages/ui/src/data/Stepper.tsx` | edit | Disc-and-rail rendering via `.jw-stepper`/`.jw-step*`; accessible names and the current/state split unchanged |
| `packages/ui/src/layout/Page.tsx` | edit | `Card` surface, head and body styles moved to `.jw-card`, `.jw-card-head`, `.jw-card-body` |
| `packages/ui/src/primitives/Button.tsx` | edit | Border width, secondary border and font through `--button-border-width`, `--button-secondary-border`, `--button-font` |
| `packages/ui/src/primitives/Field.tsx` | edit | `backgroundColor` (the shorthand hid the select chevron) |
| `packages/ui/src/tokens.css` | edit | The three button tokens; `--select-chevron` |
| `packages/ui/src/base.css` | edit | Stepper; card classes; `.jw-flat` region; portal phone theme |
| `apps/portal-web/app/enquiries/new/page.tsx` | edit | "New Enquiry" / "Review Enquiry" titles; the wizard inside `.jw-flat` |
| `apps/portal-web/app/enquiries/new/wizard/DetailsStage.tsx` | edit | "Part / Job Name", "Sub Category" |
| `e2e/walk/03-enquiry-to-award.spec.ts`, `e2e/demo/customer.spec.ts` | edit | Review heading text |

Tests: `@jobwork/ui` (193), `@jobwork/portal-web` (21), typecheck (ui, portal, operations), lint.

## VF-06 Enquiry wizard — Requirements

Deltas found: the native file control in a bordered box (reference: dashed drop zone, cloud glyph, "Upload File", "PDF, DWG, STEP, JPG (Max …)"); a passed step drawn as a filled green tick (reference: outlined disc, blue rail); raw purpose codes in the upload select ("drawing 2d").
Added: drag-and-drop onto the zone runs the same upload as the picker. Kept: tolerance class, tightest tolerance, inspection level, heat treatment, required-by and confidentiality — they are free text or richer than the reference's two dropdowns because the reviewer needs the stated value (doc 09).

| File | Action | Contents |
|---|---|---|
| `packages/ui/src/upload/FileUpload.tsx` | edit | Drop zone: the zone is the `<label>` of a visually hidden native input named "Upload File — {purpose}"; drag-over state; drop → upload |
| `packages/ui/src/base.css` | edit | `.jw-dropzone*`; passed-step disc and rail |
| `apps/portal-web/app/enquiries/new/wizard/RequirementsStage.tsx` | edit | Purpose options from `UPLOAD_POLICY` labels; title-case headings |
| `packages/ui/test/dropzone.spec.tsx` | new | Hidden input carries the action and purpose; caption lists the types |

## VF-07 Enquiry wizard — Review

Deltas found: stacked label-over-value list (reference: muted label left, value right, one row each); files in a separate card with a role caption (reference: a "File" row with a PDF badge); full-width Back under a full-width Submit (reference: Back and Submit Enquiry side by side); section headings without the rule.
Kept: job type, material supply, target price, required-by, confidentiality and the "What happens when you submit" note — what is frozen must be read back in full.

| File | Action | Contents |
|---|---|---|
| `packages/ui/src/data/DescriptionList.tsx` | edit | `layout="split"` |
| `packages/ui/src/base.css` | edit | `.jw-dl-split`, `.jw-file-row`, `.jw-file-badge`, flat section heading rule and size, `.jw-action-pair` |
| `apps/portal-web/app/enquiries/new/wizard/ReviewStage.tsx` | edit | Split list with the file row; Back beside "Submit Enquiry" (`onBack`) |
| `apps/portal-web/app/enquiries/new/page.tsx` | edit | Last stage draws no separate Back |
| `e2e/walk/03-enquiry-to-award.spec.ts`, `e2e/tests/portal-enquiry.spec.ts`, `e2e/demo/customer.spec.ts` | edit | "Submit Enquiry" |
| `packages/ui/test/dropzone.spec.tsx` | edit | Split list keeps dt/dd pairs |

## VF-08 Enquiries list

Deltas found: a back-chevron "Enquiries" with a "New enquiry" button (reference: tab root under the app bar, "My Enquiries" with a subtitle); a labelled search box under the chips (reference: glyph search with a filter button, above a tab strip); pill chips (reference: bordered tab strip, tinted underlined selection, "All (12)"); compact record cards with the reference in mono on top (reference: tinted glyph tile, title + status pill, caption, calendar date, chevron).
Corrections and decisions: the filters stay the curated customer statuses (All · Needs you · In review · Sourcing · Drafts · Closed), not "Pending / Quoted / Ordered" — quotation and order state live on their own lists, and an enquiry's customer status is the projection's (`FR-303`). The caption is reference • job type • parts: the customer projection carries no process or material label, and adding one is not a visual change. The filter button opens **Sort by** (newest, oldest, part name).

| File | Action | Contents |
|---|---|---|
| `packages/ui/src/data/RecordCard.tsx` | edit | `icon` + `date` → rich layout; empty reference renders nothing |
| `packages/ui/src/status/StatusChip.tsx` | edit | Padding, radius and font through `--chip-*` tokens (pill on the portal phone theme) |
| `packages/ui/src/primitives/Icon.tsx` | edit | `calendar`, `sliders`, `layers`, `hexagon` |
| `packages/ui/src/tokens.css`, `base.css` | edit | `--chip-*`; `.jw-record-rich*`, `.jw-record-tile-*`; tab-strip chips and tab-root title on the phone theme; `.jw-search-row`, `.jw-square-button`, `.jw-desktop-only` |
| `apps/portal-web/app/enquiries/page.tsx` | edit | Title and subtitle, search row with sort, tiles per job type |
| `packages/ui/test/dropzone.spec.tsx` | edit | Rich record card |

## VF-09 Quotes received

Deltas found: a flat list of compact record cards (reference: an enquiry summary card with a "3 Quotes" badge, then one offer card each with an icon tile, a three-column metric row and View Details / Accept Quote).
Corrections (identity shield, `F-07.6`): the reference's offer cards are three named suppliers with city, rating and a "Verified" badge. Here every card is **JobWork · Standard / Fast / Premium** with its reference, version and status; the metric row is Quote Amount · Valid Until · Option (the list projection has no lead time or minimum quantity, and the detail page carries the terms). The "Enquiry Details" tab is not drawn: the list item carries the enquiry reference, not its id. Accept Quote shows only while the offer is open for decision and goes to the acceptance page, where approval limit and terms are checked.

| File | Action | Contents |
|---|---|---|
| `apps/portal-web/app/quotations/page.tsx` | edit | "Quotes Received"; offers grouped by enquiry; summary card with count; offer cards with metrics and the two actions |
| `packages/ui/src/base.css` | edit | `.jw-offer-groups`, `.jw-offer-summary*`, `.jw-count-badge`, `.jw-offer*`, `.jw-offer-metrics`, `.jw-cta-sm` |
