# F-OPS — The operations console: command center and administration

Scope source: doc 14 §6 operations IA (action queues / command center; organization, users, security); doc 03 §§2–5 roles and separation; doc 20 §§4–7 (`AUTH-06` suspension, invitations); doc 21 §§2, 6 (compact density, queue and command patterns); `FR-104`, `FR-105`, `UC-10`, `UC-36`, `UC-37`.
Edge cases owned: an administrator who suspends the wrong person; an invitation that expired before it was accepted; an organization that exists with nobody able to sign into it; a reviewer who cannot tell what is waiting on *them* versus on someone else.

## The gap this closes

The operations application was built queue-first: intake (IN-05), supplier verification (IN-04) and supplier onboarding (F-SO) each shipped their own screen. Nobody ever built the console those screens hang off, so the internal experience has three holes an operator falls into immediately:

| # | Gap observed 2026-09-06 | Consequence |
|---|---|---|
| 1 | **Home is a list of links with no numbers.** Nothing states what is waiting, for whom, or how long it has waited. | An operator must open every queue to find out whether there is work. |
| 2 | **There is no administration surface at all.** `POST /admin/organizations`, membership suspension and user suspension exist in the API and appear in no screen; there is no way to list organizations, see who belongs to one, invite an internal colleague, or resend an invitation. | The only organization an admin can create through the product is a supplier (F-SO). Customers, and JobWork's own staff, can only be created by calling the API by hand. |
| 3 | **Suspension is one-way.** `suspendUser` and `suspendMembership` have no reinstate; `revokeInvitation` has no resend. | Every administrative mistake is permanent, which in practice means administrators avoid the commands entirely. |

Two smaller ones, both flow breaks of the kind F-SO's Documents step had: the evidence queue does not link to the supplier whose evidence it is, and the supplier 360 lists pending invitations it cannot act on.

**Comparable-practice note (R&D, 2026-09-06).** An admin panel is action-oriented where a dashboard is insight-oriented: operators create, read, update and manage records, so the design optimises form efficiency, bulk action and *error prevention* rather than charts. Ops consoles are communal — several people work the same rows — so state must be visible and concurrent edits survivable. The standard B2B feature set is user management (invite, assign role, deactivate), tenant/organization management, and a tamper-evident audit log answering who did what, when, to which resource; a left sidebar is the usual navigation because it keeps the whole menu visible. Every one of those exists here except the administration surface itself, which is what this increment builds; the audit log (IN-02) already answers the fourth question, so the work is to *link* to it from the records it describes rather than to build it again.

Sources: [Admin panel patterns for SaaS](https://www.dashhold.com/glossary/admin-panel/), [User management for B2B SaaS (WorkOS)](https://workos.com/blog/user-management-for-b2b-saas), [SaaS admin panel design principles](https://taqwah.agency/blog/saas-admin-panel-design-guide), [Enterprise UX practice](https://fuselabcreative.com/enterprise-ux-design-guide-2026-best-practices/), [Admin dashboard UI/UX practice](https://medium.com/@CarlosSmith24/admin-dashboard-ui-ux-best-practices-for-2025-8bdc6090c57d).

**What this increment deliberately does not do.** No impersonation ("sign in as this user"): it is the one item on the standard list that hands an operator a customer's or supplier's identity, and doc 03 §7 shields those from each other. If it is ever wanted it needs its own ADR, a consent model and a visible banner — not a quiet button in an admin panel. No bulk actions yet: the queues are small at pilot scale, and bulk approval of admissions would defeat the reviewer separation F-SO just established.

## F-OPS.1 Administration commands the console needs

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/iam/application/account.service.ts` | changed | `reinstateMembership`, `reinstateUser` — the mirror of each suspension, same authority, same audit shape; a reinstatement never resurrects revoked sessions, the person signs in again |
| `apps/api/src/modules/iam/application/organization.service.ts` | changed | `listOrganizations` (type/status filter, member and pending-invitation counts), `getOrganization` (header + members + invitations), `setOrganizationStatus` (suspend/reinstate, reason recorded) |
| `apps/api/src/modules/iam/application/invitation.service.ts` | changed | `resendInvitation` — revokes the outstanding token and issues a fresh one to the same email and roles in one transaction, so a lost or expired link is one click rather than a re-typed invitation |
| `apps/api/src/modules/iam/presentation/admin.controller.ts` | changed | `GET /admin/organizations`, `GET /admin/organizations/:id`, `POST /admin/organizations/:id/{suspend,reinstate}`, `POST /admin/memberships/:id/reinstate`, `POST /admin/users/:id/reinstate`, `POST /admin/organizations/:id/invitations/:invitationId/resend` |
| `packages/contracts/src/auth.ts` | changed | `organizationSummarySchema`, `organizationDetailSchema`, `organizationStatusSchema`, `createOrganizationRequestSchema` (reused by the UI), `suspensionRequestSchema` (reason mandatory) |

Authority is unchanged from doc 03: `platform_admin` or `security_admin` for user- and organization-level suspension; `org_admin` may still suspend a membership inside its own organization.

## F-OPS.2 The work summary

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/operations/operations.module.ts` + `presentation/summary.controller.ts` | new | `GET /operations/summary`: one payload of counts and oldest-waiting timestamps for the queues that exist — enquiries awaiting triage, clarifications awaiting the customer, supplier files awaiting an admission decision, evidence awaiting review, suppliers currently unmatchable, invitations pending and expiring |
| `apps/api/src/modules/operations/infrastructure/summary.repository.ts` | new | One query per queue, each already scoped by the same rules its screen uses |

Every count is **role-filtered**: an operator is shown a queue only if their roles allow them to act on it, because a number you cannot act on is noise, and a number you must not see is a leak.

## F-OPS.3 Command center

| File | Action | Contents |
|---|---|---|
| `apps/operations-web/app/page.tsx` | changed | "Waiting on you" first — one row per queue with its count, its oldest item's age, and a link straight into the filtered queue; then the reference sections. Empty is stated as empty, not hidden |
| `packages/ui/src/status/QueueCard.tsx` | new | The doc 21 queue tile: count, label, age of the oldest item, tone from urgency, whole tile is the link |

## F-OPS.4 Organizations and people

| File | Action | Contents |
|---|---|---|
| `apps/operations-web/app/organizations/page.tsx` | new | Every organization: type, status, members, pending invitations, created; filters by type and status; "Add customer organization" |
| `apps/operations-web/app/organizations/new/page.tsx` | new | Creates a customer or internal organization and invites its first user in one step — the same shape F-SO uses for suppliers, so admission of any party looks the same |
| `apps/operations-web/app/organizations/[organizationId]/page.tsx` | new | Members with roles and status, pending invitations with resend and revoke, suspend/reinstate for membership, user and organization, and a link into the audit trail filtered to this organization. Supplier organizations link across to the supplier 360 rather than duplicating it |

## F-OPS.5 Wayfinding

| File | Action | Contents |
|---|---|---|
| `packages/ui/src/layout/AppShell.tsx` | changed | `NavItem.badge` renders a count beside the label; grouped navigation (`section`) so Work, Network, Administration and System read as different kinds of place |
| `apps/operations-web/app/shell.tsx` | changed | The grouped operations navigation, badges fed by the summary |
| `apps/operations-web/app/suppliers/verification/page.tsx` | changed | Each queued item links to its supplier's 360; a `?supplierProfileId=` filter arrives from the 360 |
| `apps/operations-web/app/suppliers/[supplierProfileId]/page.tsx` | changed | Invitation resend/revoke, membership suspend/reinstate, and a link into the audit trail for this supplier |
| `apps/operations-web/app/audit/page.tsx` | changed | Reads `subjectType`/`subjectId` from the URL so every record can link to its own history |

## Tests

`apps/api/test/operations-admin.api.spec.ts` (new):

1. Every new admin route refuses a customer, a supplier and an internal user without `platform_admin`/`security_admin`; the allowed roles succeed.
2. Suspend → reinstate round trip for a membership and for a user: sessions are revoked on suspension, the row returns to `active` on reinstatement, and both directions write an audit event naming the actor.
3. Organization suspension takes its members out of the product (a suspended organization's user cannot use a transactional command) and reinstatement restores them.
4. Resending an invitation invalidates the previous token and the new one is accepted; the revoked one is refused as invalid.
5. Nobody can suspend themselves, and an `org_admin` cannot suspend a membership in another organization.
6. `GET /operations/summary` returns only the queues the actor's roles allow, and its counts match the queues' own endpoints for the same fixtures.
7. The organization listing carries member and pending-invitation counts and never leaks a supplier's or customer's data to the other.

Existing suites stay green, in particular `iam-auth.api.spec.ts` and `supplier-onboarding.api.spec.ts`.

## Exit checklist

- [x] An administrator can, in the product alone: create a customer organization and invite its first user; find any organization and see who is in it (customers, suppliers and JobWork itself); invite anybody into it with a role scoped to its type; resend or revoke an invitation; suspend and reinstate a membership, a user and an organization; and open the audit trail for any of them.
- [x] The home screen states what is waiting, how much of it, and how old the oldest item is; every number links to the work, empty queues say so rather than disappearing, and the navigation carries the same counts as badges.
- [x] No queue count is shown to somebody whose roles cannot act on it — asserted in the API spec (a sourcing reviewer sees no invitation queue; a security administrator sees only that one; an external caller gets 403).
- [x] Driven live in the browser as `platform_admin` (2026-09-06): command center with three live queues and their ages → organizations directory listing all five organizations with their people and pending invitations → resent a stale invitation (link moved from 2026-09-09 to 2026-09-13) → added *Kovai Hydraulics* with its first invitation → suspended and reinstated that organization → suspended and reinstated a membership, watching the member count go 1 → 0 → 1 → opened the organization's audit trail and saw both membership events.
- [x] `pnpm -r build && pnpm typecheck && pnpm lint && pnpm test` green: **229 automated tests** (api 88, ui 74, worker 30, database 35, observability 2).

### Deviations recorded during build (protocol rule 3)

1. **Organization creation through the console makes a customer only.** A supplier organization without a supplier profile is a broken record, so suppliers keep their own admission command (F-SO.2); a second *internal* organization would be a second set of eyes over everything, and the environment seed creates the one that exists. The request schema states this with `type: z.literal('customer')`.
2. **Authorization is settled before the body is parsed.** Adding the stricter schema turned an existing test red — a customer posting to `/admin/organizations` got 400 (bad body) instead of 403 (not yours to call). Telling somebody their JSON is malformed on a route they may not use answers a question they were not entitled to ask; the controller now asserts the administrator role first.
3. **`aboutOrganizationId` was added to the audit filter.** The first version of the "history of this organization" link filtered by subject id, which found the organization row's own events and missed every membership and user event — the half an administrator actually looks for. The filter now unions subject, payload `organizationId` and issuing organization, and the page states exactly what that includes.
4. **`Card.title` accepts a node** so the evidence queue can title each card with a link to the supplier it belongs to (the queue previously named a supplier it could not take you to).
5. **`NavItem.badge`** carries counts in the navigation; zero renders nothing, because a badge that is always present stops being read.
6. **No impersonation, no bulk actions** — reasoning above; both would need their own decision, not a quiet button.
