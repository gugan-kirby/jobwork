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
| VF-04 | `JobWork Precision Dashboard.png` | `/` | |
| VF-05 | `JobWork New Enquiry Form.png` | `/enquiries/new` stage 1 | |
| VF-06 | `New Enquiry Requirements Form.png` | `/enquiries/new` stage 2 | |
| VF-07 | `Mobile Review Enquiry Form UI.png` | `/enquiries/new` stage 3 | |
| VF-08 | `JobWork Enquiry Dashboard.png` | `/enquiries` | |
| VF-09 | `JobWork Quotes Received Screen.png` | `/quotations` | |
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
