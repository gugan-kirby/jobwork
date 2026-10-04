# F-SN — Life in the network: renewal, availability, and leaving

Scope source: `FR-201`–`FR-203`; doc 06 §14 verification lifecycle (`expiring` → `expired`); doc 07 §2.1 hard filter; doc 14 §5 supplier portal IA; `UC-11`.
Edge cases owned: evidence that lapses while nobody is looking; a shop that stops offering a process it still advertises; a shop that is full for six weeks; a supplier that wants to leave the network.

## The gaps this closes

Audited 2026-09-06 by reading the supplier module and using the portal as an admitted supplier (*Sri Balaji Precision*, active):

| # | Gap | What it does to a supplier |
|---|---|---|
| 1 | **Expiry is silent.** The sweep flips an item to `expiring` thirty days out and emits an event the worker only acknowledges (mail is IN-10). The onboarding checklist counts `expiring` as **complete**, so the portal says "Verified by JobWork" while eligibility is three weeks from lapsing. | The first thing a supplier learns is that the enquiries stopped. Nobody told them a certificate was expiring, and the day it lapses they leave matching without a word. |
| 2 | **There is no renewal path**, only the first-submission path. Nothing states an expiry date on the compliance screen or asks for a replacement. | A supplier who *wants* to stay current has to guess when. |
| 3 | **A declaration cannot be withdrawn.** `supplier_capability.status` allows `withdrawn`; no command sets it, and the page offers only "Publish version". Machines and capacity windows are the same. | A shop that sells its laser cutter keeps being matched for laser cutting, and the only fix is to ask JobWork to edit the database. |
| 4 | **There is no availability control.** `paused` exists but is JobWork's suspension, with a reason the supplier reads as a punishment. | A shop that is full for six weeks cannot say so. It either takes work it cannot do or quietly declines RFQs, and both damage it. |
| 5 | **`exited` is unreachable.** It is in the state machine and no command writes it. | Nobody can leave the network, and JobWork cannot offboard anybody. |
| 6 | **An admitted supplier's home is a completed checklist and nothing else.** | The screen a supplier opens most says "Nothing outstanding" and never mentions the dates that decide whether they get work. |

**Comparable-practice note (R&D, 2026-09-06).** Xometry's partner dashboard (Workcenter) is built around exactly the three things missing here: partners **choose the jobs that fit their capacity**, they maintain their own **Shop Capabilities** — adding *and updating* certifications, materials, processes and equipment — and they see a score that explains their standing. On the compliance side, the practice is unambiguous: staged reminders before expiry (90/60/30, or 60/30/14 days) to the supplier *and* the internal owner, with a portal where the supplier uploads the renewed certificate, so lapses are caught in-year instead of at the moment work stops. Our sweep already computes the warning; nothing shows it to the person who can act on it.

Sources: [Xometry partner network](https://www.xometry.com/manufacturing-partner-network-overview/), [Optimising a Xometry partner profile (Workcenter capabilities)](https://www.xometry.com/resources/shop-tips/optimize-your-xometry-profile/), [Xometry partner network overview](https://community.xometry.com/kb/articles/498-xometrys-partner-network), [Portal-based supplier compliance](https://www.serversys.com/insights/how-a-portal-keeps-supplier-compliance-current/), [Renewal alert practice](https://expiryedge.com/blogs/renewal-alerts-in-procurement-a-2026-strategy-guide/).

## Availability is not suspension

The two must not share a field. Suspension is JobWork's judgement with a reason the supplier is owed; availability is the supplier's own statement about the next few weeks. They exclude from matching in the same way and mean opposite things, so availability lands as its own column with its own exclusion code.

```text
network status   onboarding → submitted → active ⇄ paused → exited     (JobWork's, F-SO)
accepting work   true ⇄ false, with an optional "back on" date          (the supplier's, F-SN)
```

## F-SN.1 Availability, withdrawal and leaving

| File | Action | Contents |
|---|---|---|
| `database/migrations/0008_supplier_availability.sql` | new | `supplier_profile.accepting_work` (default true), `accepting_work_note`, `accepting_work_until`; `exited_at`; index for the eligibility filter |
| `apps/api/src/modules/supplier/application/set-availability.command.ts` | new | `setAvailability` — the supplier pauses or resumes itself with an optional note and return date; audited, never touches network status |
| `apps/api/src/modules/supplier/application/withdraw-declaration.command.ts` | new | `withdrawCapability`, `withdrawMachine`, `withdrawCapacity` — mark the live version `withdrawn`, keeping every earlier version readable (UC-11) |
| `apps/api/src/modules/supplier/application/exit-network.command.ts` | new | `exitNetwork` — supplier-initiated with a confirmation phrase, or JobWork-initiated with a reason; terminal, and it says so before it happens |
| `apps/api/src/modules/supplier/domain/verification.ts` | changed | Exclusion code `supplier_unavailable`; `computeExclusions` reads the availability flag |
| `packages/contracts/src/supplier.ts` | changed | `setAvailabilityRequestSchema`, `exitNetworkRequestSchema`, `supplierSummarySchema`, the new exclusion code, availability on the profile |

## F-SN.2 The renewal loop

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/supplier/domain/onboarding-checklist.ts` | changed | `expiring` stops reading as "Done": the row states the date and the days left, and turns blocking the moment it lapses |
| `apps/api/src/modules/supplier/presentation/profile.controller.ts` | changed | `GET /suppliers/me/summary`: evidence expiring and expired, items returned for better evidence, certifications lapsing, and whether the supplier is currently matchable — counts and the nearest date |
| `apps/portal-web/app/supplier/page.tsx` | changed | Queue tiles first (`QueueCard`), then status, then the checklist; availability control with its own card |
| `apps/portal-web/app/supplier/compliance/page.tsx` | changed | Each item states its expiry and days remaining; an expiring item asks for the replacement in the same place the first one was uploaded |

## F-SN.3 Managing what you offer

| File | Action | Contents |
|---|---|---|
| `apps/portal-web/app/capabilities/page.tsx` | changed | Every live declaration carries a withdraw action that says what it means ("we stop matching you for this"); withdrawn versions stay listed under history |
| `apps/operations-web/app/suppliers/[supplierProfileId]/page.tsx` | changed | Availability and its note beside the network status, and JobWork's own offboard command |

## Tests

`apps/api/test/supplier-network-life.api.spec.ts` (new):

1. A supplier pauses itself: it disappears from capability cards with exclusion `supplier_unavailable`, its network status stays `active`, and resuming restores it — no reviewer involved either way.
2. Suspension and unavailability are distinguishable: a suspended supplier reads `profile_not_active`, an unavailable one `supplier_unavailable`, and a supplier cannot resume itself out of a suspension.
3. Withdrawing a capability removes it from matching, keeps every version readable, and refuses to touch an already-superseded version.
4. `GET /suppliers/me/summary` counts evidence expiring within the warning window and evidence already expired, with the nearest date, and is refused to anyone but that supplier.
5. The checklist stops calling an expiring item complete: it warns while it is still valid, and blocks the day it lapses.
6. Exit: a supplier-initiated exit requires the confirmation phrase, is terminal (no self-resume), and takes the supplier out of every projection; JobWork-initiated exit requires a reason and is audited.

Existing suites stay green, in particular `supplier-capabilities.api.spec.ts` and `supplier-onboarding.api.spec.ts`.

## Exit checklist

- [x] A supplier is warned before evidence lapses: the checklist row states the date and the days left from 45 days out (and stops saying "Done"), the home screen counts it, and the compliance card asks for the renewal in the place the original was uploaded.
- [x] A supplier stops and restarts taking work itself, with an optional note and return date; the network status is untouched, the exclusion reads `supplier_unavailable`, and a suspension still reads `profile_not_active` — the console shows both, separately.
- [x] A capability, machine or capacity window can be withdrawn: matching stops, every version stays readable, and re-offering it later works.
- [x] Leaving is possible from either side, typed rather than clicked, terminal, and audited with its initiator.
- [x] Driven live as *Sri Balaji Precision* (2026-09-06): the returned Udyam item appeared as a queue tile on the home for the first time; evidence rows now read "valid to 2027-09-06"; pausing with "Shutdown for Diwali… back on 2026-11-15" left the status `active`, set `accepting_work = false` and dropped the customer's capability cards to zero; resuming restored them; withdrawing CNC turning left `status = withdrawn, version_no = 1` in place and re-offering it published version 2.
- [x] `pnpm -r build && pnpm typecheck && pnpm lint && pnpm test` green: **243 automated tests** (api 101, ui 75, worker 30, database 35, observability 2).

### Deviations recorded during build (protocol rule 3)

1. **Availability is a column, not a status.** `accepting_work` (+ note and return date) sits beside the network status with its own exclusion code. Putting a full order book and a compliance suspension in one field would make every busy shop look suspended in the audit trail.
2. **A publish-after-withdraw bug, found by using the feature.** Version numbers were derived from the *live* row; after a withdrawal there is no live row, so the next publish restarted at version 1 and hit the unique version constraint — a supplier could withdraw a capability and never offer it again. All three declaration types now number from the highest version ever recorded, and the case is covered by a test.
3. **`chk_supplier_exited` is `NOT VALID`**, matching the F-SO precedent for rows that predate the model; the F-SO database test now asserts the constraint refuses an exit with no timestamp.
4. **The expiry warning is 45 days and the row does not block.** Practice is staged notice (90/60/30 or 60/30/14); one clear warning window is what the portal can honestly support before IN-10 adds mail. Blocking submission for something that has not happened would be worse than silence.
5. **`QueueCard` no longer prints "waiting"** when a queue has no date to age against — filler under a number that already said it.
