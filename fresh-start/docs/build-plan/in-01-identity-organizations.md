# IN-01 — Identity and organizations

Scope source: [Implementation plan](../24-implementation-plan.md) §3 IN-01; [Authentication design](../20-authentication-identity-design.md) (all `AUTH-*`); `FR-100`; doc 03 roles model.
Edge cases owned (doc 19 §9): suspension mid-session; conflicting roles; stale cache after revocation.
Use cases advanced: UC-35 (partial — user/role config), UC-36.

Build order inside the increment: F-01.1 → F-01.8. Auth precedes the platform spine because IN-02's commands need a real actor; invite-member lands minimally here and is refactored onto the spine in IN-02 (accepted, documented duplication of one week).

## F-01.1 IAM migrations

| File | Action | Contents |
|---|---|---|
| `database/migrations/0002_iam.sql` | new | `organization` (type: customer/supplier/internal, status), `organization_site`, `user_account` (citext unique email, password_hash nullable-for-SSO, status, failed_login state), `membership` (unique user+org active, status, version), `role`, `membership_role`, `approval_limit`, `session` (opaque id hash, user, org context, strength, device meta, expiries, revoked_at), `invitation` (email, org, proposed roles, token_hash unique, expires_at, consumed_at, revoked_at), baseline columns per doc 05 §2 |
| `database/tests/iam-constraints.db.spec.ts` | new | Duplicate active membership rejected; email uniqueness case-insensitive; FK integrity |

## F-01.2 Password + session core

Covers: `AUTH-11`–`AUTH-13`, `AUTH-16`–`AUTH-18`; doc 20 §4, §6.

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/iam/domain/password.ts` | new | Argon2id hash/verify, parameter version, rehash-needed check |
| `apps/api/src/modules/iam/domain/session.ts` | new | Session entity: create/rotate/revoke rules, lifetime policy by audience (internal vs external) |
| `apps/api/src/modules/iam/application/login.command.ts` | new | Uniform-response login, failed-counter + progressive delay/lockout, session issue, fixation rotation |
| `apps/api/src/modules/iam/application/logout.command.ts` | new | One/all sessions |
| `apps/api/src/modules/iam/infrastructure/session.repository.ts` | new | Hash-keyed session store, revocation check |
| `apps/api/src/modules/iam/presentation/auth.controller.ts` | new | `POST /auth/login`, `POST /auth/logout`; cookie set/clear (env-driven name, `__Host-` in prod) |
| `apps/api/src/platform/http/session.guard.ts` | new | Global guard: resolve session → actor context (user, org, strength); 401 problem on miss |
| `apps/api/src/platform/http/csrf.ts` | new | Origin check + double-submit token for state changes (doc 20 §6) |

Tests (`iam.api.spec.ts` + unit): wrong password and unknown email byte-identical; lockout after N; cookie flags; rotated old session id rejected; CSRF-less mutation rejected.

## F-01.3 Invitations

Covers: `AUTH-08`–`AUTH-10`; doc 20 §3.

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/iam/domain/invitation.ts` | new | Token = id.secret; hash(secret) stored; expiry/consumption/revocation rules; atomic accept |
| `apps/api/src/modules/iam/application/invite-member.command.ts` | new | Authorize (org admin/ops), create invitation, request email side effect |
| `apps/api/src/modules/iam/application/accept-invitation.command.ts` | new | Verify token (constant-time), create/attach account + membership, consume atomically |
| `apps/api/src/modules/iam/presentation/invitation.controller.ts` | new | issue/revoke/accept endpoints per doc 08 §5 identity commands |
| `apps/portal-web/app/(auth)/accept-invitation/page.tsx` | new | Review org/roles → set password → accept |

Tests: used/expired/revoked token fails closed; accept idempotent under token uniqueness; above-authority role grant routes to approval (stub queue until IN-02).
Edge: invitation email carries no business data (`AUTH-09`) — snapshot test on rendered mail.

## F-01.4 Organization context and switching

Covers: `AUTH-04`, doc 20 §7.

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/iam/application/switch-organization.command.ts` | new | Validate membership, rotate session, update context |
| `apps/api/src/platform/http/org-context.ts` | new | Context from session only; contradictory explicit org params → 403 problem |
| `apps/portal-web/app/(shell)/org-switcher.tsx` + operations twin | new | Switcher UI |

Tests: no-membership switch denied; post-switch requests scoped; params contradiction rejected.

## F-01.5 Suspension and revocation propagation

Covers: `AUTH-06`, `AUTH-19`, `FR-104`, `BR-AUTH-05`; doc 20 §8.

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/iam/application/suspend-membership.command.ts` (+ user/org variants) | new | Status change + session revocation in one transaction |
| `apps/api/src/modules/iam/application/revoke-sessions.command.ts` | new | Security-admin scope |
| `apps/api/test/revocation-propagation.api.spec.ts` | new | The timing-bound suite: API denied ≤ 1 min (immediate here — direct store), refresh path dead, per doc 20 §13 |

Edge (doc 19 §9): user suspended mid-session loses next request.

## F-01.6 MFA (TOTP) for internal accounts

Covers: `AUTH-14`, `AUTH-15`, `FR-103`; doc 20 §5. WebAuthn deferred to a marked backlog item (needs provider/browser test rig).

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/iam/domain/mfa.ts` | new | TOTP secret provisioning, drift window, recovery codes (hashed, single-use) |
| `apps/api/src/modules/iam/application/{enroll,challenge,verify}-mfa.command.ts` | new | Enrollment proof-before-activate; login second step; step-up check helper |
| `apps/operations-web/app/(auth)/mfa/*` | new | Enrollment + challenge screens |

Tests: internal role blocked from transactional commands pre-enrollment (`AUTH-15`); recovery code single-use; step-up freshness window.

## F-01.7 Session inventory and account security UI

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/iam/presentation/sessions.controller.ts` | new | List/revoke own sessions (doc 20 §6) |
| `apps/portal-web/app/(shell)/account/security/page.tsx` | new | Sessions with device meta, logout-all, password change (step-up) |

## F-01.8 Seeds and negative suite completion

| File | Action | Contents |
|---|---|---|
| `database/seeds/dev-seed.ts` | new | JobWork internal org, admin user (dev password from env, never hardcoded), role catalogue from doc 03 §2 |
| `apps/api/test/auth-negative.api.spec.ts` | new | Full doc 20 §13 list as one suite; enumeration timing tolerance documented |

## Increment exit

- [x] Doc 20 §13 negative suite green: 15 API tests covering enumeration-safe login, lockout, CSRF/origin, AUTH-15 gate, TOTP enroll + recovery codes, challenge + rotation + stale-token death, invitation single-use/role-scope/atomic accept, auto org-context, switch denial, external→internal denial, suspension revocation, logout-all (2026-09-02).
- [x] Full journey demonstrated live against the seeded dev database (admin login → me with internal context/roles); portal pages shipped: login (with MFA step), accept-invitation, account security (sessions + MFA), org switcher on home; operations app: login, security, MFA-required banner.
- [x] Auth events from doc 20 §12 emitted as structured logs; they become atomic audit rows in IN-02 (F-02.4) as planned.

### Deviations recorded during build (protocol rule 3)

1. WebAuthn deferred per plan (F-01.6); TOTP + recovery codes shipped.
2. Session rotation replaces the bearer token on the same session row (inventory continuity) rather than issuing a new row.
3. Portal and operations apps temporarily duplicate the auth pages/`lib/api.ts` (copied files); dedup into `packages/ui` when design-system components land (IN-05).
4. Per-IP login throttling deferred to IN-11 rate limits; per-account progressive lockout implemented.
5. Invitation accept URL is returned to the inviter in non-production until outbox email delivery lands (F-02.4).
6. TOTP secrets stored unencrypted pending the field-level encryption decision (doc 11 §11) — carried to the F-12.3 security review checklist.
7. F-01.5's separate suspend commands merged into `account.service.ts`; F-01.2 login/logout live in `auth.service.ts` (file layout consolidation, same behavior).
