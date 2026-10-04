# Accessibility conformance note

`DS-15` requires the design system to publish a conformance note per component, which the
doc 15 §11 release checklist consumes. `DS-12` requires each component to document its
keyboard interaction and ARIA. This file is both.

Target: **WCAG 2.2 AA** (`NFR-08`, doc 21 §9). Automated coverage lives in
`test/a11y.spec.tsx` (axe over every component in its default, empty, loading, error and
disabled states) and `test/tokens.spec.ts` (contrast computed from the token source).
Automated checks catch roughly a third of real barriers — the keyboard maps below are the
part a machine cannot verify, and they are what manual review checks against.

## Global, from the base layer

| Bar | How it is met |
|---|---|
| Focus visible (2.4.7, 2.4.11) | `:focus-visible` outline, 2 px `blue-600`, 2 px offset, plus `scroll-margin-top` so a sticky header cannot fully obscure the focused element |
| Skip link (2.4.1) | `AppShell` renders it as the first focusable element, targeting the single `<main id="main">` |
| Reflow (1.4.10) | No horizontal document scroll; wide content scrolls inside its own container, and `DataTable` swaps to per-row cards below `md` |
| Reduced motion (2.3.3) | `prefers-reduced-motion` collapses every animation and transition |
| Colour not alone (1.4.1) | `DS-07` — every status renders a glyph and a text label beside the colour |
| Tabular figures (`DS-08`) | `.numeric` sets `font-variant-numeric: tabular-nums` on money, quantity and measurement cells |

## Per component

| Component | Keyboard | ARIA / semantics |
|---|---|---|
| `Button` | Enter/Space activate; disabled removed from tab order | `aria-busy` while working; `title` carries `disabledReason` |
| `CommandButton` | As `Button`; repeat presses during flight are dropped | Visually hidden `role="status"` announces working/receipt; failures render `role="alert"` with the problem code |
| `Field`, `TextInput`, `TextArea`, `Select`, `Checkbox` | Native controls throughout | Label bound by `htmlFor`/`id`; hint and error joined into `aria-describedby`; `aria-invalid` when in error; required marked visually and with visually-hidden "(required)" |
| `ReasonField` | As `TextArea` | Hint names the audience who will read the reason |
| `ErrorSummary` | Receives focus on failed submit; each issue is a button that navigates to its step | `role="alert"`, `tabIndex={-1}` |
| `AppShell` | Skip link first; nav toggle is a button with `aria-expanded`/`aria-controls` — never hover- or drag-only (2.5.7) | `<header>`, `<nav aria-label="Primary">`, `<main>`; active item carries `aria-current="page"` |
| `Page`, `Card` | — | Exactly one `<h1>` per page; `Card` titles are `<h2>` |
| `DataTable` | Native table semantics; row actions are real buttons | `<caption>` (visually hidden by default) names the table; `scope="col"` headers; below `md` the same rows render as a definition list — the documented reflow alternative, not a second copy in the a11y tree |
| `Stepper` | Each step is a button, reachable in order | `aria-current="step"` on the current step; the accessible name states position and state ("Step 3 of 7: Material. Needs attention.") |
| `EmptyState` | — | Explains eligibility and next action rather than "no results" |
| `LoadingState` | No focusable content — skeletons never render an enabled control | `role="status"`, `aria-live="polite"`, visually-hidden label |
| `ErrorState` | — | `role="alert"`; shows the stable problem `code` and correlation id for support |
| `CopyableId` | Button, activated by Enter/Space | Accessible name is the **full** value, never the truncation; copy result announced in a live region |
| `LiveRegion` | — | `role="status"`, polite by default, assertive on request |
| `StatusChip` | — | Glyph plus label; visually-hidden text spells out the tone unless `silent` |
| `ActionNeededCard` | Single primary action | Owner and due time (with an explicit timezone label) in text |
| `MeasurementInput` | Number field and unit select, both labelled | Unit select's accessible name is scoped to its field ("Tightest tolerance unit"); changing the unit never rescales the value |
| `MoneyInput` | Text field, decimal input mode | Currency shown as `aria-hidden` decoration — the field's own label carries the meaning; value stays integer minor units on the wire |
| `FileUpload` | Click/keyboard path alongside drop (2.5.7) | Per-state progress polled into text, not spinner-only |
| `ManifestRow` | Download is a real button, rendered only when the version is releasable | Hash rendered through `CopyableId`; governing flag stated in text |

## Known gaps

- **Visual regression snapshots** (doc 21 §11) are not wired; the axe matrix is the current
  gate. Tracked against the doc 13 §14 merge gate.
- **Manual screen-reader passes** (NVDA/VoiceOver) have not been run on the retrofitted
  screens; the table above states intent and automated conformance, not a manual audit.
- **Contrast in `compact` density** is asserted from tokens, which are density-independent
  for colour; `DS-09`'s 13 px floor is enforced by the type scale, not by a test.
