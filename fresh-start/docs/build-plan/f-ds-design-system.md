# F-DS — Design system build-out and screen retrofit

Scope source: [Design system and UI foundations](../21-design-system-ui-foundations.md) (`DS-01`–`DS-15`); component inventory doc 21 §6; form patterns §7; accessibility §9 (`NFR-08`, WCAG 2.2 AA); content rules §10; governance §11. Screen structure stays in doc 14.

**Why this exists as its own increment.** IN-00 → IN-05 shipped working screens at prototype fidelity: every page re-declares its own buttons and inputs as inline `CSSProperties`, `packages/ui` holds only `FileUpload`, `ManifestRow`, `StatusChip` and the form inputs added in IN-05, and doc 21's component inventory has never been built. Doc 21 §11 makes the design system the single source and forbids page-local magic values (`DS-01`); every increment built against inline styles adds retrofit debt and drifts from that rule. This increment builds the component layer once and moves all 15 existing screens onto it, so IN-06 onward inherits it.

Not in scope: dark theme (`DS-03` says additive later), PWA/offline shell (doc 21 §8 — belongs with IN-11), the operations-only comparison table, measurement grid, gate matrix and curated timeline (built with the increments that own their data: IN-06, IN-14, IN-09).

## F-DS.1 Token and stylesheet completion

Covers: `DS-01`–`DS-03`, `DS-08`, doc 21 §5 breakpoints and motion, §9 focus and reflow.

| File | Action | Contents |
|---|---|---|
| `packages/ui/src/tokens.css` | edit | Add motion tokens (`--motion-fast` 120ms, `--motion-base` 200ms, ease-out) with a `prefers-reduced-motion` override; breakpoint custom properties as documentation plus a `--container-*` set; component-layer tokens (`--button-*`, `--field-*`, `--table-*`); `.density-comfortable` as an explicit class so portal can opt in per-region |
| `packages/ui/src/tokens.ts` | new | Typed TS map of semantic tokens (doc 21 §2 "and a typed TS map"), so components reference names, not strings |
| `packages/ui/src/base.css` | new | Base layer applied by both apps: body background/typography, `:focus-visible` ring (2px `blue-600`, 2px offset), skip-link, `[hidden]`, reduced-motion, print-safe defaults, `.numeric` tabular numerals, keyframes, and the component layout classes (`jw-split`, `jw-table-wrap`, `jw-nav`, `jw-stack-divided`) |

**Deviation (2026-09-06):** component CSS started as `<style>` elements rendered inside the components. A test caught the consequence — an injected stylesheet inside a `<button>` becomes part of its `textContent` and its accessible name — so all of it moved to `base.css`, which also stops the rules being duplicated per rendered instance.

**Deviation (2026-09-06):** the `-border` third of each status triple does not meet 3:1 against the page, and the first draft of `tokens.spec.ts` asserted that it should. The tokens were right and the test was wrong: WCAG 1.4.11 puts the 3:1 bar on what *identifies* a component or state, and with `DS-07` in force that is the label and glyph (both `-fg`, which clears 4.5:1 everywhere). `DS-06` in doc 21 §3 was rewritten to record the interpretation rather than darkening six tints to satisfy a misreading.

Tests: `packages/ui/test/tokens.spec.ts` — every status triple (`-fg` on `-bg`) meets 4.5:1, every border meets 3:1 against its background (`DS-06`, doc 21 §9); no component file contains a raw hex outside `tokens.css` (`DS-01`).

## F-DS.2 Form primitives

Covers: doc 21 §6 (idempotent action button, empty/loading/error), §7 validation and reason fields, §9 labelling, `DS-12`, `DS-13`.

| File | Action | Contents |
|---|---|---|
| `packages/ui/src/primitives/Button.tsx` | new | `Button` with variants `primary`/`secondary`/`ghost`/`danger`, sizes tied to `--control-height`, ≥24×24 target, loading and disabled states, `busy` announcing via `aria-busy` |
| `packages/ui/src/primitives/CommandButton.tsx` | new | Doc 21 §6 idempotent action button: single-flight (ignores repeat clicks while in flight), renders in-flight → receipt → conflict, never optimistic (`DS-13`); takes an async handler and surfaces the problem `code` on failure |
| `packages/ui/src/primitives/Field.tsx` | new | `Field` wrapper owning label, hint, error text and the `id`/`aria-describedby`/`aria-invalid` wiring; `TextInput`, `TextArea`, `Select`, `Checkbox` built on it |
| `packages/ui/src/primitives/ReasonField.tsx` | new | Doc 21 §7 reason pattern (rejection, override, decline, revoke) with minimum-length guidance stated as the fix, not the failure |
| `packages/ui/src/primitives/ErrorSummary.tsx` | new | Submit-time summary that receives focus, lists field paths as links to the offending control (doc 21 §9, doc 08 §3 problem→field mapping) |

Tests: `packages/ui/test/primitives.spec.tsx` — CommandButton fires its handler exactly once across rapid repeat clicks; a failed command shows the problem code and re-enables; Field associates label/error to the control; ErrorSummary takes focus on submit failure.

## F-DS.3 Layout and shell

Covers: doc 21 §5 breakpoints and elevation, §9 landmarks and skip link, doc 14 §4/§6 information architecture.

| File | Action | Contents |
|---|---|---|
| `packages/ui/src/layout/AppShell.tsx` | new | Header with product name, primary navigation, environment banner slot, account menu slot; skip-to-content link; `<main>` landmark; mobile nav that is a disclosure, not a drag |
| `packages/ui/src/layout/Page.tsx` | new | `Page` (title, description, breadcrumb, actions slot), `Section`, `Card`, `Toolbar` — one place that owns page rhythm so screens stop re-declaring padding |
| `packages/ui/src/layout/Stack.tsx` | new | `Stack`/`Inline` spacing primitives on the 8-pt grid, plus `SplitPane` for the two-pane operations layout and a `divided` mode replacing the hand-rolled hairline list rows three screens had each declared |

Tests: `packages/ui/test/shell.spec.tsx` — skip link is the first focusable element and targets `<main>`; nav exposes `aria-current` for the active route; shell renders one `<h1>` per page.

## F-DS.4 Data display and feedback

Covers: doc 21 §6 (queue table, empty/loading/error, status chip), §9 reflow alternative for dense tables, `DS-07`, `DS-08`, `DS-10`.

| File | Action | Contents |
|---|---|---|
| `packages/ui/src/data/DataTable.tsx` | new | Column-driven table: sticky header, `numeric` columns tabular-aligned, per-row detail disclosure as the documented reflow alternative below `md` (doc 21 §9), empty and loading states built in, row actions authorization-aware via a `disabledReason` per row |
| `packages/ui/src/data/DescriptionList.tsx` | new | Label/value pairs used by every detail pane, with `mono` and `numeric` value variants |
| `packages/ui/src/data/Stepper.tsx` | new | Wizard stepper with per-step state (`complete`/`current`/`incomplete`/`error`), keyboard navigable, `aria-current="step"`, error steps announced — replaces the button row in the enquiry wizard |
| `packages/ui/src/data/States.tsx` | new | `EmptyState` (explains eligibility and the next action), `LoadingState` (skeletons that render no enabled buttons), `ErrorState` (message, stable problem `code`, correlation id for support — doc 08 §3) |
| `packages/ui/src/data/CopyableId.tsx` | new | `DS-10`: mono, middle-out truncation (`ab12…9f`), full value on focus, copy affordance with a live-region confirmation |
| `packages/ui/src/data/Callout.tsx` | new (unplanned) | Toned notice box — four screens had each written the same tinted-box block with different spacing |
| `packages/ui/src/feedback/LiveRegion.tsx` | new | Polite/assertive announcer used for autosave state, upload/scan progress and command receipts (doc 21 §9 "status changes announce via live regions") |

Tests: `packages/ui/test/data.spec.tsx` — DataTable renders a detail disclosure per row at narrow widths and keeps the header sticky otherwise; EmptyState requires an action or an explicit reason; LoadingState renders no enabled button; CopyableId exposes the full value to assistive tech while showing the truncation.

## F-DS.5 Domain components brought to contract

Covers: doc 21 §6 rows already partly built, `DS-04`, `DS-07`, `DS-11`.

| File | Action | Contents |
|---|---|---|
| `packages/ui/src/status/StatusChip.tsx` | edit | Add the icon half of `DS-07` (colour never alone), the `status-special` tone for deviation-accepted results (`DS-04`), and a `tone` map covering the six semantic statuses rather than the enquiry projection alone |
| `packages/ui/src/status/ActionNeededCard.tsx` | new (split) | Promote out of `StatusChip.tsx` into its own file and complete the doc 21 §6 contract: owner, due time with timezone label, one primary action, blocking-reason slot |
| `packages/ui/src/document/ManifestRow.tsx` | edit | Move onto `CopyableId` and the shared `Chip`, add the governing flag the doc 21 §6 row requires |
| `packages/ui/src/upload/FileUpload.tsx` | edit | Move to shared `Button`/`Field`, keep the state machine; add the keyboard path alongside drop (`DS`/WCAG 2.5.7) |
| `packages/ui/src/forms/{MeasurementInput,MoneyInput}.tsx` | edit | Rebuild on `Field`; money display uses en-IN lakh/crore grouping while the wire stays `{amountMinor, currency}` (doc 21 §7) |

Tests: `packages/ui/test/domain.spec.tsx` — every status tone renders a text label and an icon, never colour alone (`DS-07`); a deviation-accepted status does not use the positive tone (`DS-04`); MoneyInput formats ₹12,34,567.00 and still emits minor units.

## F-DS.6 Portal screen retrofit

| File | Action | Contents |
|---|---|---|
| `apps/portal-web/app/layout.tsx` | edit | Adopt `AppShell` with portal navigation (Home, Enquiries, Documents, Capabilities, Account), environment banner, skip link |
| `apps/portal-web/app/ui.tsx` | delete | Its `card`/`inputStyle`/`buttonStyle`/`Field`/`ErrorNote` are what the design system now owns (`DS-01`) |
| `apps/portal-web/app/{page,login,accept-invitation,account/security,documents,capabilities}` | edit | Move to `Page`/`Card`/`Field`/`Button`/`DataTable`/`States` |
| `apps/portal-web/app/enquiries/{page,[enquiryId]/page,new/page}.tsx` | edit | Wizard onto `Stepper` + `Field` + `ErrorSummary` + `LiveRegion` autosave announcements; list onto `DataTable`; detail onto `Page`/`DescriptionList`/`CommandButton` |

## F-DS.7 Operations screen retrofit

| File | Action | Contents |
|---|---|---|
| `apps/operations-web/app/layout.tsx` | edit | `AppShell` in `compact` density with operations navigation (Queues, Intake, Suppliers, Audit, Account) |
| `apps/operations-web/app/ui.tsx` | delete | Same reason as the portal copy |
| `apps/operations-web/app/{page,login,audit,suppliers/verification}` | edit | Move to shared components; audit and verification queues onto `DataTable` with `CopyableId` for correlation ids and hashes |
| `apps/operations-web/app/intake/{page,[enquiryId]/page}.tsx` | edit | Queue onto `DataTable`; workspace onto `Page` two-pane layout, `DescriptionList`, `CommandButton` for every named command, `ReasonField` for decline |

## F-DS.8 Accessibility and regression gates

Covers: doc 21 §9, `DS-12`, `DS-15`, doc 13 §12 and §14.

| File | Action | Contents |
|---|---|---|
| `packages/ui/package.json`, `packages/ui/vitest.config.ts` | edit/new | Real test script: vitest + `@testing-library/react` + `jsdom` + `vitest-axe` |
| `packages/ui/test/a11y.spec.tsx` | new | Axe pass over every component in its default, empty, loading, error and disabled states (`DS-12` story-set equivalent) |
| `packages/ui/ACCESSIBILITY.md` | new | Per-component keyboard map and ARIA note, the conformance note `DS-15` requires the doc 15 §11 release checklist to consume |

## Increment exit

- [x] No `apps/**` file declares a colour or a pixel literal; all rendering goes through tokens or components (`DS-01`) — asserted by a test that greps every app source, not by review alone.
- [x] `packages/ui` test script runs real tests (71); axe reports no violations across 27 component states.
- [x] Status contrast asserted programmatically from the token source (`DS-06`, with the border interpretation recorded in doc 21 §3).
- [x] Every interactive element is reachable and visibly focused by keyboard; `DataTable` offers the per-row detail alternative below `md` (doc 21 §9). Keyboard maps published in `packages/ui/ACCESSIBILITY.md` (`DS-12`, `DS-15`).
- [x] Portal reflows without horizontal document scroll; operations two-pane collapses to one column below `lg` and keeps the approve/decline path.
- [x] All previously existing tests stay green; full verify passes (202 tests).

**Closed 2026-09-06.** `pnpm -r build && pnpm typecheck && pnpm lint && pnpm test` — 204 tests green (api 71, ui 71, worker 30, database 30, observability 2). Both `app/ui.tsx` files deleted; 15 screens moved onto the system.

Not done, and deliberately: visual-regression snapshots (doc 21 §11) and a manual screen-reader pass. Both are recorded as known gaps in `ACCESSIBILITY.md` and belong with the IN-11 hardening gate.

## Browser verification (2026-09-06)

Both apps were run against a seeded database and driven through the portal wizard, the enquiry list, the operations intake queue and the intake workspace, at 1280 px and at 320 px. Compiling is not the same as working; six defects only a running browser could show were found and fixed:

| Defect | Fix |
|---|---|
| **A calendar date moved a day earlier.** `node-pg` parses a `date` (OID 1082) into a JS `Date` at *local* midnight; serialising that as UTC shifts the day at every positive offset. In IST a required-by date of 2026-11-30 was returned as 2026-11-29. It also affected `enquiry_item.target_date` and, from IN-04, `capacity_window.window_start`/`window_end`. | `registerPgTypeParsers()` in `@jobwork/database`, registered by the API, the worker and the test kit before any pool opens: a `date` stays the `YYYY-MM-DD` string Postgres sent. `isoDate`/`asDate` deleted. Regression test in `enquiry-constraints.db.spec.ts` runs under `TZ=Asia/Kolkata` and fails loudly without the parser (2026-01-01 → 2025-12-31). |
| **The stepper lost "you are here" on a failed submit.** `StepState` folded position and content into one value, so a step that was both current and in error rendered only the error and dropped `aria-current`. | `Stepper` takes `current` separately from each step's `state`; an errored current step keeps the error tone and gains a focus ring, and its accessible name says both. |
| **A failed list request rendered as an empty list.** Four screens set `rows=[]` in their catch, so "No enquiries yet" was asserted about data that never arrived. | The catch leaves rows `null` and the screen renders the error instead of the table. |
| **Two-pane cards stretched to the taller column**, pooling dead space under short cards. | `alignContent: start` on both `SplitPane` columns. |
| **Stacked table rows repeated their title**, once as the card heading and again as a row. | `hideOnStack` on the title column of both list screens. |
| **The portal offered "Capabilities" to customers**, who have no supplier profile. | `PortalShell` builds navigation from `organizationType`. |

Verified after the fixes: `pnpm -r build && pnpm typecheck && pnpm lint && TZ=Asia/Kolkata pnpm test` — 204 tests green.
