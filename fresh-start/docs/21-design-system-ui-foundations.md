# Design system and UI foundations

This document defines the shared visual and interaction foundation that implements the UX direction in [UX and screen map](14-ux-screen-map.md). It governs the `packages/ui` design system consumed by both the customer/supplier portal and the operations application ([System architecture](04-system-architecture.md) §4, §8). Screen structure and flows stay in doc 14; this document owns tokens, components, patterns, and quality bars.

Rules carry `DS-nn` identifiers. Brand direction retains the prototype's blue identity pending the brand/accessibility review noted in doc 14 §15.

## 1. Design principles

1. **Action first.** Every surface answers doc 14 §8: what is true, what happens next, who owns it, when it is due, what blocks it, what evidence created it.
2. **Truthful state.** UI never renders a queued side effect as completed business state (doc 04 §10). "Committed" and "processing" are visually distinct.
3. **Evidence density where the work is.** Operations screens optimize for scanning many rows and comparisons; portal screens optimize for one clear decision at a time.
4. **Audience is visible.** Any element that carries cross-party data states its audience; internal-only content is visually unmistakable (doc 14 §11).
5. **Calm, professional trust.** Restrained color, generous whitespace in portals, no decorative motion. Status is informative, not alarming, except genuine blocking exceptions.

## 2. Token architecture

Three layers, exported as CSS custom properties (and a typed TS map) from `packages/ui`:

```text
primitive   --blue-600, --space-4, --font-size-300     raw values, no meaning
semantic    --color-action, --color-surface, --status-blocked-bg   meaning, theme-aware
component   --button-primary-bg, --table-row-height-compact        scoped overrides only
```

- `DS-01`: Application code references semantic or component tokens only; primitives are internal to the design system.
- `DS-02`: Two density modes ship from the start: `comfortable` (portal default, mobile) and `compact` (operations default). Density changes spacing/row-height tokens, never font size below the accessibility floor.
- `DS-03`: Light theme is the launch target; tokens are structured so a dark theme is additive later, and no component hard-codes raw colors.

## 3. Color

### Brand and neutrals

Derived from the prototype identity (`blue #243BDB`, `bg #F6F8FC`, `text #151A2D`, `muted #667085`):

| Ramp | Values (50 → 900) | Use |
|---|---|---|
| `blue` (brand) | `#EEF1FD` `#DCE2FB` `#B9C4F6` `#8D9DEF` `#5F74E6` `#3D53DF` `#243BDB` `#1D30B4` `#17278F` `#101C66` | Primary actions, links, selected states, focus ring |
| `neutral` | `#F6F8FC` `#EEF1F6` `#E1E6EE` `#C9D0DC` `#A5AEBF` `#828CA0` `#667085` `#4A5468` `#2E374B` `#151A2D` | Surfaces, borders, text hierarchy |

Text pairs must meet the contrast bar in §9: body text uses `neutral-900` on light surfaces; `muted` (`neutral-600` `#667085`) is confined to ≥ 18.66 px semibold or non-essential metadata.

### Semantic status palette

Domain statuses map to a fixed semantic set so meaning is consistent across portals (icons + text always accompany color, `DS-07`):

| Semantic token | Base | Domain examples |
|---|---|---|
| `status-neutral` | neutral-600 | draft, superseded, closed |
| `status-progress` | blue-600 | under review, sourcing, in production, in transit |
| `status-attention` | amber `#B45309` | action needed, clarification required, expiring validity, evidence submitted |
| `status-positive` | green `#15803D` | approved, verified, released, accepted, paid |
| `status-blocked` | red `#B91C1C` | hold, failed inspection, NCR open, dispatch blocked, overdue |
| `status-special` | violet `#6D28D9` | accepted under deviation, waived, override — states that pass with an asterisk |

- `DS-04`: `status-special` exists so a deviation-accepted result is never rendered with the same green as a clean pass (`BR-QLT-02` visual analogue).
- `DS-05`: Prototype greens/reds (`#16A34A`, `#DC2626`) are superseded by the darker pairs above where they fail 4.5:1 on light surfaces; use the tokens, not the legacy hex.
- `DS-06`: Each status token ships as a triple (`-fg`, `-bg`, `-border`) with contrast asserted in CI in both densities. What is tested is what identifies the state: `-fg` against its own `-bg` at ≥ 4.5:1, and `-fg` against the page and surface backgrounds at ≥ 4.5:1, because `-fg` carries both the label and the `DS-07` glyph. `-border` is a decorative separator and is deliberately held to no ratio — under WCAG 1.4.11 only visual information *required to identify* a component or state carries the 3:1 bar, and with `DS-07` in force the label and glyph always carry it. Darkening the tints to clear 3:1 anyway would contradict the restraint of §1 principle 5 without adding information.
- `DS-07`: Color never carries meaning alone — every status pairs with a text label and/or distinct icon (doc 14 §8, `NFR-08`).

## 4. Typography

| Token | Size/line | Use |
|---|---|---|
| `display` | 28/36 semibold | Page titles (portal) |
| `heading-1` | 22/30 semibold | Section titles |
| `heading-2` | 18/26 semibold | Card titles, panel headers |
| `body` | 15/22 regular | Default text |
| `body-strong` | 15/22 semibold | Emphasis, labels |
| `caption` | 13/18 regular | Metadata, table secondary text |
| `mono` | 13/20 | IDs, hashes, file names, API references |

- Font: a system-stack default (SF/Segoe/Roboto) or a licensed grotesque chosen at brand review; the scale is independent of the family.
- `DS-08`: Money, quantities, and measurements always render with **tabular (fixed-width) numerals** so columns of figures align — critical in bid comparison, cost sheets, measurement grids.
- `DS-09`: Operations tables may drop to 13 px body in `compact` density but never below; zoom/reflow behavior per §9 is still required.
- `DS-10`: Hashes, document versions, and correlation IDs render in `mono` with copy affordance, truncated middle-out (`sha256:ab12…9f`), full value on focus/tap.

## 5. Spacing, layout, elevation

- 8-pt base grid; spacing tokens `space-1` (4) through `space-10` (96). Compact density maps table paddings down one step.
- Radius: `radius-sm` 6, `radius-md` 10, `radius-lg` 16 (cards/dialogs). Prototype's soft-card look is retained.
- Elevation: three shadow levels only (raised card, overlay, modal); borders are the primary separator in dense operations tables, not shadows.
- Breakpoints: `sm 640`, `md 768`, `lg 1024`, `xl 1280`, `2xl 1536`. Portal is designed mobile-first; operations is designed desktop-first at `lg`+ and degrades to read-mostly below `md` (field approvals still work; dense editing does not have to).
- Motion: 120–200 ms ease-out for reveals; no motion on data mutation results; respect `prefers-reduced-motion`.

## 6. Component inventory

The system ships domain-aware components, not just primitives. Each maps to rules already fixed elsewhere:

| Component | Contract |
|---|---|
| **Status chip** | Semantic status triple + icon + label; tooltip may add detail but never new party/price data (doc 14 §8) |
| **Action-needed card** | Owner, due time (with timezone rule of doc 05 §10), one primary action, blocking reason slot — the home-queue unit for all three apps |
| **Curated timeline** | Grouped commercial/technical/manufacturing/quality/receiving/delivery lanes; renders only released events for external audiences (doc 06 §13) |
| **Gate matrix** | Computed release gates with pass/pending/blocked per gate and evidence links (doc 00 §5); read-only — actions are named commands elsewhere |
| **Approval panel** | Subject type/version/hash, before→after diff, impact summary, authority being used, required checklist, reason field, irreversibility notice; disables after first submit and shows idempotent receipt (doc 14 §9) |
| **Audience banner + composer** | Words + icon + color state the audience; internal-note mode is a visually distinct sub-mode requiring deliberate switching, never a keyboard toggle (doc 14 §11) |
| **Document manifest row** | Logical name, engineering revision, system version, hash (mono), scan/audience state, governing flag (doc 14 §10) |
| **File upload** | Purpose-scoped accept list, per-state progress (uploading → verifying → scanning → quarantined/ready), resumable recovery, fail-closed messaging (doc 08 §7) |
| **Comparison table** | Side-by-side immutable originals + normalized scenario columns, visibly labeled which is which (doc 07 §4); internal-only component |
| **Measurement grid** | Unit-aware cells, original + normalized value display, cannot-evaluate state distinct from fail (doc 09 §10) |
| **Countdown / validity** | Quote validity, RFQ deadlines; switches to `status-attention` at configured threshold; expiry is server truth, countdown is advisory |
| **Queue table (operations)** | Virtualized, sticky context columns, saved filters, bulk selection with per-row authorization awareness |
| **Diff view** | Field-level before/after for versions (bids, quotes, baselines); renders "no change" explicitly |
| **Idempotent action button** | Single-flight; shows in-flight, success receipt, or conflict resolution; used for every money/approval/release command (doc 14 §14) |
| **Empty / loading / error states** | Empty explains eligibility + next action; skeletons never render enabled buttons; errors show stable problem `code` and correlation ID for support (doc 08 §3) |

- `DS-11`: Components that can carry cross-party data (timeline, manifest, chip tooltips, notifications preview) accept only the purpose-built projection DTOs from `packages/contracts` — never raw aggregate shapes. The type system enforces what doc 03 §3 requires.
- `DS-12`: Every component documents keyboard interaction and ARIA in its story; a component without both does not merge (extends doc 13 §12).

## 7. Form patterns

- **Wizard (enquiry intake):** progressive category-driven steps (doc 14 §4); autosave with visible saved-state and conflict-safe resume; step validation summaries link to fields; review step lists completeness and conflicts before submit.
- **Validation:** inline on blur, summary on submit; error text states the fix, not just the failure; server problem codes map to field paths (doc 08 §3).
- **Money input:** currency-aware, integer-minor-unit backed (`BR-FIN-01`); display uses en-IN grouping (₹12,34,567.00) while the wire format stays `{amountMinor, currency}`.
- **Measurement input:** value + unit pair with declared precision; unit changes never silently convert entered values (doc 09 §10).
- **Date/time:** store-and-send UTC instants; display localized with explicit timezone label wherever a deadline has business meaning (doc 05 §10).
- **Reason fields:** rejection, override, deviation, manual match, and sensitive grants require a reason input — the pattern ships as part of the approval panel, not re-built per screen (doc 03 §5).
- `DS-13`: No optimistic UI for money, approval, release, or status-changing commands; buttons resolve only on server confirmation (doc 14 §14).

## 8. PWA and offline behavior

- Installable PWA with offline shell for navigation and read-cached, non-sensitive projections.
- Field evidence capture (photos, milestone notes) may draft offline: drafts are visibly "not submitted", stored encrypted-at-rest by platform capability, and submitted explicitly when online — never auto-fired (doc 14 §14).
- Commands are never queued offline for money/approval/release; the UI states connectivity is required.
- Camera capture flow stamps job/milestone context on the way in (doc 09 §15) and uploads via the doc 08 §7 protocol with resume.
- `DS-14`: Offline caches store no supplier-identity, pricing, or document bytes beyond the session's authorized, short-TTL scope; logout/suspension purges them (`BR-AUTH-05`).

## 9. Accessibility implementation (WCAG 2.2 AA, `NFR-08`)

Concrete bars, testable in CI and manual review (extends doc 13 §12):

- Contrast: text ≥ 4.5:1 (≥ 3:1 for ≥ 24 px or 18.66 px bold); non-text UI parts and status icons ≥ 3:1.
- Target size ≥ 24×24 px (2.2 SC 2.5.8); primary mobile actions ≥ 44 px.
- Focus visible on every interactive element (2-px `blue-600` ring, 2-px offset) and never fully obscured by sticky headers/footers (2.2 SC 2.4.11).
- No drag-only interactions; any drag (file drop, reorder) has a click/keyboard path (2.2 SC 2.5.7).
- No cognitive re-entry tests: session re-auth uses the §5 MFA design of [Authentication](20-authentication-identity-design.md), never puzzles (2.2 SC 3.3.8).
- Reflow to 320 px width / 400 % zoom without loss; dense operations tables provide a per-row detail view as the reflow alternative.
- Status changes announce via live regions; long-running upload/scan states are polled into text, not spinner-only.
- All form controls labeled and described; error summary receives focus on failed submit.
- `DS-15`: The design system publishes an accessibility conformance note per component; the release checklist in doc 15 §11 consumes it.

## 10. Content and language

- Plain, specific, calm. Customer-facing wording follows the curated projection table (doc 06 §13) — no internal jargon, no supplier hints, no unsupported promises.
- Buttons name the business command ("Approve quotation revision 3", "Release to production"), not generic "Submit/OK", mirroring the named-command API (`BR-SYS-01`).
- Timestamps: "2 Sep 2026, 14:30 IST" style with timezone; relative time only as a secondary hint.
- en-IN is the launch locale; all strings externalized from day one, lakh/crore grouping for INR, and templates prepared for Indian-language expansion (doc 14 §13).
- Error tone: state what happened, what is safe to do next, and the reference code — never blame, never fake certainty.

## 11. Governance

- The design system lives in `packages/ui` with versioned releases consumed by both apps; breaking visual changes ride a changelog and migration note.
- Tokens are the single source: a proposed new color/spacing/size must become a token or be rejected — no page-local magic values (`DS-01`).
- Each new component requires: story with all states (including empty/loading/error/disabled), keyboard/ARIA documentation (`DS-12`), density behavior, and a projection-safety note when it can render cross-party data (`DS-11`).
- Visual regression snapshots run on the story set per doc 13 §14 CI gates.
- The five difficult journeys in doc 14 §16 are prototyped with these tokens/components before broad screen production, closing the loop with the Phase 0 exit gate (doc 15 §2).
