# F-CX — The customer flow: finishing, repeating, and where it ships

Scope source: doc 14 §4 customer portal IA (action queue, enquiry, tracking); `FR-301` (an enquiry names its destinations), `FR-302`, `FR-303`; doc 06 §3 enquiry lifecycle; `UC-01`, `UC-02`, `UC-04`, `UC-10`, `UC-21`.
Edge cases owned: a draft nobody finished; an enquiry raised by mistake; the same part ordered again six months later; a customer with two factories and one address field; a buyer who cannot invite the colleague who has to approve.

## The gaps this closes

Audited 2026-09-06 by reading the portal and then using it as `buyer@demo.local`:

| # | Gap | What it does to a customer |
|---|---|---|
| 1 | **A draft is a dead end.** The enquiry list links a draft to the read-only detail page, which shows an action card reading *"Finish and submit — this enquiry has not been submitted yet"* and offers **no way to do either**. The only route back into a draft is a URL nobody is given. | The demo account has four abandoned drafts. Every one of them is a customer who tried to tell us what they needed and could not get back to it. |
| 2 | **Nothing can be withdrawn.** `POST /enquiries/:id/cancel` exists and no screen calls it. | A mistaken enquiry sits in the list forever, and the customer's own view of their work fills with noise they cannot clear. |
| 3 | **Nothing can be repeated.** `POST /enquiries/:id/copy` exists and no screen calls it. | The most common B2B action — order that again — means retyping the whole enquiry, including re-attaching drawings. |
| 4 | **The wizard never asks where to deliver.** `enquiry.delivery_site_id`, the contract field and the command all exist; the customer is never shown an address. | `FR-301` is unfulfilled: sourcing quotes freight against an address nobody stated. A customer with two plants has no way to say which one. |
| 5 | **Home is a static list of links.** No count of what is waiting on the customer, no route back into unfinished work. | The one screen that could say "two questions are waiting on you" says nothing. |
| 6 | **A customer organization cannot manage itself.** Suppliers got a team page in F-SO; customers have none, so a requester cannot invite the approver who is supposed to approve. | Onboarding a customer team means asking JobWork to do it. |

**Comparable-practice note (R&D, 2026-09-06).** Xometry added a **Reorder Parts** button to order history, the dashboard *and* the order confirmation — reorder is treated as a primary path, not a convenience — and its Teamspace collaboration (7,000+ teams by Q1 2025) says the buying side is a team, not a person. Protolabs' myRapid centres the same three things: quotes and order history in one place, sharing with colleagues, and contact/address details the customer edits themselves. General B2B portal practice puts it plainly: design for repeat purchasing, build "speed lanes" — reorder from history, saved lists, templates — and let the buying organization's own administrator manage its users, roles and **shipping addresses**. Every one of those is a gap above, which is the strongest evidence the list is the right one.

Sources: [Xometry release notes (Reorder Parts)](https://www.xometry.com/release-notes/), [Xometry quotes, orders and Teamspace](https://community.xometry.com/kb/quotes-orders), [Protolabs myRapid](https://www.protolabs.com/services/myrapid/), [B2B customer portal guide](https://wizcommerce.com/blog/b2b-customer-portal/), [B2B self-service practice](https://kibocommerce.com/blog/creating-engaging-self-service-experiences-for-b2b-customers/).

## F-CX.1 A draft you can finish, an enquiry you can withdraw

| File | Action | Contents |
|---|---|---|
| `apps/portal-web/app/enquiries/page.tsx` | changed | Draft rows link into the wizard (`/enquiries/new?draft=…`), labelled as unfinished work with a Continue action; submitted rows keep linking to the detail |
| `apps/portal-web/app/enquiries/[enquiryId]/page.tsx` | changed | A draft opens with **Continue editing** and **Discard draft**; a submitted enquiry that sourcing has not yet approved offers **Withdraw**, with a reason, and says what that means |
| `packages/contracts/src/sourcing.ts` | unchanged | `cancelEnquiryRequestSchema` already carries `expectedVersion` and `reason` |

Discard and withdraw are the same command with different words, because they are the same fact to the platform and a completely different act to a customer.

## F-CX.2 Order that again

| File | Action | Contents |
|---|---|---|
| `apps/portal-web/app/enquiries/[enquiryId]/page.tsx` | changed | **Order this again** on any submitted enquiry: calls `copy`, then opens the new draft in the wizard at step 1, carrying items and attached documents but no dates and no reference |
| `apps/portal-web/app/enquiries/page.tsx` | changed | The same action on each submitted row, because the list is where a customer actually looks for the thing they ordered last time |

## F-CX.3 Where it ships

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/iam/presentation/sites.controller.ts` | new | `GET /organizations/me/sites`, `POST /organizations/me/sites` (create or update a delivery address), `POST /organizations/me/sites/:siteId/archive` — scoped to the caller's own organization, never a path parameter |
| `apps/api/src/modules/iam/application/site.service.ts` | new | Validation, audit, and the rule that an archived site stays readable to the enquiries that already named it |
| `packages/contracts/src/auth.ts` | changed | `organizationSiteSchema`, `saveOrganizationSiteRequestSchema` |
| `apps/portal-web/app/enquiries/new/page.tsx` | changed | Step 6 asks where it ships: pick a saved address or add one **in place**, and the choice saves with the draft as `deliverySiteId` |
| `apps/portal-web/app/account/addresses/page.tsx` | new | The customer's address book: add, edit, archive |
| `apps/api/src/modules/sourcing/application/save-draft.command.ts` | changed | Accepts `deliverySiteId` from the wizard and refuses a site belonging to another organization |

## F-CX.4 A home that says what is waiting

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/operations/presentation/portal-summary.controller.ts` | new | `GET /portal/summary`: questions awaiting an answer, drafts unfinished, enquiries in progress — counts and oldest-waiting, scoped to the caller's organization |
| `apps/portal-web/app/page.tsx` | changed | Queue tiles first (the same `QueueCard` operations uses), then the account context |

## F-CX.5 The customer's own team

| File | Action | Contents |
|---|---|---|
| `apps/portal-web/app/team/page.tsx` | new | Members, roles, pending invitations and an invite form for a customer organization; a requester who cannot invite is told who can, rather than shown a button that fails |
| `apps/portal-web/app/shell.tsx` | changed | Customer navigation gains Team and Addresses |

## Tests

`apps/api/test/customer-portal.api.spec.ts` (new):

1. Sites: a customer creates, edits and archives a delivery address; another organization's site is invisible and unusable; an archived site stays readable on an enquiry that already named it.
2. A draft carrying a `deliverySiteId` from another organization is refused, and the enquiry payload states the site it names.
3. `GET /portal/summary` counts only the caller's organization, and an internal user is refused.
4. Cancel: a draft can be discarded by its author; a submitted enquiry can be withdrawn with a reason; an approved-for-sourcing enquiry cannot be withdrawn by the customer.
5. Copy: the new draft carries items and documents, no reference, no dates, and belongs to the same organization.

Existing suites stay green, in particular `enquiry-intake.api.spec.ts`.

## Exit checklist

- [x] No dead ends: a draft opens in the wizard from the list *and* from its own detail page, which now offers **Continue editing** and **Discard draft** instead of an action card with no action.
- [x] A customer can withdraw what they raised by mistake (with a reason, kept out of the default list but retrievable under "Show withdrawn") and repeat what they ordered before — the copy carries the items and the attached drawings straight into a new draft.
- [x] An enquiry states where it ships, chosen from an address book the customer keeps, with a new address addable **inside** the wizard step.
- [x] The home screen counts questions waiting, drafts unfinished and work in progress, each with the age of its oldest item.
- [x] Driven live as `buyer@demo.local` (2026-09-06): the four abandoned drafts became "4 unfinished enquiries" with a Continue on each → continued one, added *Ambattur plant* in place and saw it save to the draft (`delivery_site_id` confirmed in the database) → discarded another and watched the count fall to three → reordered `ENQ-2026-0002`, landing in a new draft carrying both attached drawings → the team page told a requester who can invite instead of failing.
- [x] `pnpm -r build && pnpm typecheck && pnpm lint && pnpm test` green: **235 automated tests** (api 94, ui 74, worker 30, database 35, observability 2).

### Deviations recorded during build (protocol rule 3)

1. **`aggregateVersion` joined the customer projection.** Withdrawing is a customer command and every command carries `expectedVersion`; without it the projection could be read but never acted on, which is exactly how the withdraw button came to be missing. A version counter says nothing about internal state, so the curation rule (doc 06 §13) is intact.
2. **Cancelled enquiries are filtered from the list by default** (`includeCancelled=true` brings them back), rather than deleted or always shown. Withdrawn work is history, not a to-do.
3. **A 500 in the address-book update, found by the tests**: the `UPDATE` referenced `$13` while leaving `$12` unbound, and Postgres cannot type a parameter nothing uses. `created_by` is now excluded from the update — the row keeps whoever added it.
4. **The address book lives under Account, not a top-level nav item.** It is a setting a customer visits rarely; the enquiry step is where it is actually needed, so that is where a new address can be added.
5. **No customer-side approval workflow yet** (roles exist, `customer_approver` has nothing to approve until quotations land in IN-07). The team page invites into the role so the organization is ready.
