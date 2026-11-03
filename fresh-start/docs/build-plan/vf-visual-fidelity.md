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
| VF-02 | `JobWork Industrial Welcome Screen.png` | `/start` | |
| VF-03 | `Mobile Register Screen UI.png` | `/register` | |
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
