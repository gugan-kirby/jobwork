# F-FE — Frontend hardening

Scope source: a senior-frontend review of `apps/portal-web`, `apps/operations-web` and `packages/ui` on 2026-10-04, measured against a production build (Next.js 16.3.4, Turbopack) and a running browser. Standards: `ES-14` (no swallowed rejections), doc 21 §6 (empty/loading/error states), doc 14 §§4–5 (audience-separated navigation), doc 11 §10 and doc 20 §11 threat row "session theft via XSS" (CSP, frame protection, HSTS, secure headers), `NFR-08` (WCAG 2.2 AA).

**Why this exists as its own increment.** Every screen through IN-09 inherits the same five defects from shared code, and IN-10 onward would copy them into every new screen. Fixing them once in the shared layer before IN-10 is cheaper than retrofitting later.

| Finding (measured 2026-10-04) | Evidence |
|---|---|
| A failed load spins forever | 80 `catch` sites in 55 files keep only `ApiError`; `api()` throws a `SyntaxError` for a non-JSON body and a `TypeError` offline. With the API down, `/orders` still showed "Loading your orders" after 6 s. `PortalShell` turns any `/auth/me` failure into the public navigation, so a signed-in customer is offered Sign in / Register during an outage. |
| Every route ships Zod and every contract schema | 289 KB gz of JS per route, of which a 117 KB gz chunk is `zod` + `@jobwork/contracts`. Chain: `@jobwork/ui` barrel → `FileUpload` value-imports `UPLOAD_POLICY`/`acceptAttribute` → contracts resolves to CommonJS `dist/index.js` → nothing tree-shakes. Reaches `/login` and `/welcome`. |
| No response security headers | Neither app sends CSP, frame protection, `nosniff`, referrer or permissions policy; no `proxy.ts`, no `headers()`, nothing in the API. |
| Every internal link is a full page load | `AppShell`, `TabBar`, `Page` back link, `RecordCard`, `QueueCard`, `QuickAction` render bare `<a>`; each click re-downloads the document and re-runs identity. |
| `<Link><Button>` in 39 places | `<button>` inside `<a>`: invalid interactive nesting, two tab stops per action. `quotations/[quotationId]` wraps a *disabled* "Accept quote" button in a live link — the keyboard still reaches the accept page. |
| No error boundaries | No `error.tsx`, `global-error.tsx` or `not-found.tsx`; a render exception blanks the screen. |

Not in scope, deliberately:

- **Server rendering of data.** Every page is a client component fetching in `useEffect`. Moving reads to server components (cookie-forwarded fetches, streamed HTML) is the larger performance lever, but it changes the data-access model doc 04 §4 describes ("do not put authorization/business truth in server components alone") and touches every screen. It needs an ADR with measured mobile timings, not a hardening pass. Recorded here so it is a decision, not an omission.
- **PWA install/offline shell** (doc 21 §8, `DS-14`). F-DS assigned it to IN-11; IN-11's plan did not carry it. F-FE.7 adds it there.
- **Visual regression and a bundle-size budget in CI.** No numeric frontend NFR exists to enforce; F-FE.3 guards the structural cause instead.

## F-FE.1 Failure-honest transport

Covers: `ES-14`; doc 21 §6 error state; doc 08 §3 problem shape.

| File | Action | Contents |
|---|---|---|
| `packages/web-kit/{package.json,tsconfig.json,vitest.config.ts}` | new | `@jobwork/web-kit`: browser transport and response security policy shared by the two Next apps (source-exported like `@jobwork/ui`, transpiled by Next) |
| `packages/web-kit/src/api.ts` | new | `api()`, `ApiError`, `Problem` moved from the two identical `apps/*/lib/api.ts`. Every failure becomes an `ApiError`: fetch rejection → `NETWORK_UNREACHABLE` (status 0); a body that is not JSON → `UNEXPECTED_RESPONSE` carrying the HTTP status; a JSON body without a problem shape on a non-2xx → `UNEXPECTED_RESPONSE`. `Problem` gains the `correlationId` the API already sends. |
| `apps/{portal-web,operations-web}/lib/api.ts` | edit | Re-export from `@jobwork/web-kit`, so the 55 importing screens need no edit and every existing `instanceof ApiError` branch now sees the outage |
| `apps/*/next.config.ts` | edit | Add `@jobwork/web-kit` to `transpilePackages` |
| `apps/{portal-web,operations-web}/app/page.tsx` | edit | Both home screens handled only a 401 and dropped every other failure, so they too spun forever. They now render the error. |

**Deviation (2026-10-04):** the plan assumed the 80 `instanceof ApiError` catches were the whole problem. A TypeScript-AST scan of every `catch` in both apps found two more shapes, catches that handled only a 401 (the two homes above); no others.

Tests: `packages/web-kit/test/api.spec.ts` — 2xx JSON returns data; empty 2xx body returns `{}`; problem JSON becomes `ApiError` with its code and correlation id; `text/plain` 500 (the Next proxy's answer when the API is down) becomes `UNEXPECTED_RESPONSE` 500; HTML 502 likewise; fetch rejection becomes `NETWORK_UNREACHABLE`; CSRF header from cookie; content-type only with a body; idempotency key forwarded.

## F-FE.2 Portal identity: ask once, believe only 401

Covers: doc 14 §§4–5, `D-17`.

| File | Action | Contents |
|---|---|---|
| `apps/portal-web/app/shell.tsx` | edit | `/auth/me` is asked on entering the signed-in area, not on every navigation; re-asked after an unshelled page (login, logout, invitation) and on navigation only while the last attempt failed. Only a 401 means anonymous; any other failure is `unreachable` and renders the shell with no navigation (neither audience's links, nor Sign in). While identity is loading the shell renders no navigation, so a supplier never sees the customer's. Portal counts still refresh per navigation. |
| `apps/portal-web/{package.json,vitest.config.ts,test/setup.ts}` | new/edit | App-level tests (vitest + jsdom + Testing Library, the versions `packages/ui` already uses — no new dependency to the workspace) |

Tests: `apps/portal-web/test/shell.spec.tsx` — 401 shows the public navigation; a 500 or a network failure shows neither public nor customer links; a customer navigating three pages asks `/auth/me` once and `/portal/summary` three times; a failure is retried on the next navigation, not in a loop; visiting `/login` and returning asks again; a supplier's navigation never contains Enquiries, including while loading.

## F-FE.3 Zod-free contract constants

Covers: the bundle finding; `ES-11` (contracts stay the wire vocabulary).

| File | Action | Contents |
|---|---|---|
| `packages/contracts/src/constants.ts` | new | Zod-free values the web needs at runtime: `UPLOAD_POLICY`, `acceptAttribute`, `JOB_TYPE_LABELS` (moved, not copied; their home modules re-export them so API imports are untouched) |
| `packages/contracts/package.json` | edit | `exports`: `.` (unchanged CommonJS build) and `./constants` |
| `packages/ui/src/upload/FileUpload.tsx`, three screens importing `JOB_TYPE_LABELS` | edit | Import values from `@jobwork/contracts/constants`; types stay on `@jobwork/contracts` (erased) |

Tests: `packages/ui/test/bundle-boundaries.spec.ts` — parses every `apps/*-web/**` and `packages/ui/src/**` source with the TypeScript compiler and fails on a value import from the `@jobwork/contracts` root; walks `constants.ts`'s relative imports and fails if any reaches `zod`. Measured after build: `/login` no longer loads the Zod chunk.

Measured (production build, gzipped JS per route): 285–289 KB before, 186–196 KB after; `/login` 289 → 189 KB. No route loads a chunk containing Zod, the enquiry wizard included — it uses contract types only.

## F-FE.4 One link primitive

Covers: doc 21 §6 buttons/links, `NFR-08`.

| File | Action | Contents |
|---|---|---|
| `packages/ui/src/primitives/Link.tsx` | new | `LinkProvider` (the app injects its router link; default a plain `<a>`), `UiLink` for internal hrefs, `ButtonLink` — a link styled by the button's own style function. `ButtonLink disabled` renders a real disabled `Button` with its reason, never a live link. |
| `packages/ui/src/primitives/Button.tsx` | edit | Extract `buttonStyle()` shared with `ButtonLink` |
| `AppShell`, `TabBar`, `Page`, `RecordCard`, `QueueCard`, `QuickAction` | edit | Internal hrefs render through `UiLink`; the skip link stays a fragment anchor |
| `apps/*/app/shell.tsx` | edit | Wrap the app in `LinkProvider` with `next/link` |
| 39 `<Link><Button>` sites | edit | `ButtonLink` |

Tests: `packages/ui/test/primitives.spec.tsx` — `ButtonLink` is one `<a>` with no nested button and the button's name; disabled renders a disabled button with its reason and no link; components route through an injected link component; axe clean. `packages/ui/test/bundle-boundaries.spec.ts` — no `apps/**` source nests `<Button` directly inside `<Link`.

**Deviation (2026-10-04):** the conversion found 41 sites, not 39 — the count came from a grep for `<Button` on the line after `<Link`, and two sites had a line between. The codemod parsed JSX with the TypeScript compiler, so attributes containing `>` (`iconStart={<Icon …/>}`, `length > 0`) survived intact. Its first pass re-sorted import lists and mis-indented multi-line children; it was reverted and rerun with order-preserving imports and Prettier-shaped output (`printWidth: 100`), so the diff touches only the converted elements.

**Deviation (2026-10-04):** `LinkComponent` is typed as React's `ElementType`, not `ComponentType<UiLinkProps>`. `next/link` declares optional handlers without `| undefined`, which `exactOptionalPropertyTypes` will not reconcile with React's anchor attributes; the alternative was a cast in every app.

The design system also had a defect this fixes on the way: `quotations/[quotationId]` wrapped a disabled "Accept quote" in a live link. `ButtonLink disabled` renders a disabled button, so the keyboard no longer reaches the accept page for a quotation that cannot be accepted.

## F-FE.5 Error boundaries

Covers: doc 21 §6 error state; `ES-13` (no internals to the user).

| File | Action | Contents |
|---|---|---|
| `packages/ui/src/data/States.tsx` | edit | `RouteError`: the doc 21 error state for a crashed segment — plain-language message, the error digest as the reference to quote, Try again, Go home |
| `apps/*/app/error.tsx` | new | Segment boundary inside the shell, calling `retry()` (stable in 16.3) |
| `apps/*/app/global-error.tsx` | new | Own `<html>`/`<body>` and the token stylesheets, for a failure in the root layout |
| `apps/*/app/not-found.tsx` | new | "That page does not exist" with a way home, inside the shell |

Tests: `packages/ui/test/data.spec.tsx` — `RouteError` shows the digest, never the error message; Try again calls back; axe clean. `apps/portal-web/test/boundaries.spec.tsx` — `error.tsx` wires `retry`.

Not done: client-side error reporting. Doc 22 `ES-33` bans `console.*` in application code and no browser telemetry exists yet; a crashed page is recoverable for the user but invisible to JobWork. It belongs with the IN-11 F-11.3 signals.

## F-FE.6 Response security headers

Covers: doc 11 §10, doc 20 §11, `AUTH-17` (HttpOnly cookies are half of the XSS answer; CSP is the other half).

| File | Action | Contents |
|---|---|---|
| `packages/web-kit/src/security-headers.ts` | new | `contentSecurityPolicy({ nonce, development, connectOrigins })` and `staticSecurityHeaders({ production })` |
| `apps/*/proxy.ts` | new | Per-request nonce; CSP on the request (Next reads the nonce from it) and on the response. Matcher skips `/api`, static assets and prefetches. |
| `apps/*/app/layout.tsx` | edit | `await connection()` — a nonce needs request-time rendering; every page is personalised client-side already, so there is no cache to lose |
| `apps/*/next.config.ts` | edit | `headers()`: `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` (camera `self` for evidence capture, everything else off), `X-Frame-Options`, `Cross-Origin-Opener-Policy`; HSTS in production only |
| `.env.example` | edit | Web apps read `OBJECT_STORE_ENDPOINT` for `connect-src`: upload grants PUT straight to the store |

Policy: `script-src 'self' 'nonce-…' 'strict-dynamic'` (+ `'unsafe-eval'` in development only, which React needs for dev error stacks); `style-src 'self' 'unsafe-inline'` because React style attributes and the operations quote preview's `srcdoc` (which inherits the parent policy) need it; `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'`; `img-src 'self' blob: data:`; `connect-src 'self'` + object-store origin.

Tests: `packages/web-kit/test/security-headers.spec.ts` — nonce present with `strict-dynamic`; no `unsafe-inline` in `script-src`; `unsafe-eval` only in development; store origin in `connect-src`; HSTS only in production. `apps/portal-web/test/proxy.spec.ts` — CSP on the response, same nonce on the request, a fresh nonce per request. Browser: both apps render and navigate with zero `securitypolicyviolation` events.

**Deviation (2026-10-04):** HSTS and `upgrade-insecure-requests` moved from "production only" to "response arrived over HTTPS" (`x-forwarded-proto`, else the request scheme), decided per request in `proxy.ts` rather than in `next.config` `headers()`. A production build served over plain HTTP (local `next start`) would otherwise upgrade its own subresources to an HTTPS port that does not exist.

**Deviation (2026-10-04):** Next 16.3's proxy docs name the matcher test helper `unstable_doesProxyMatch`; 16.3.4 ships it as `unstable_doesMiddlewareMatch`. The test uses the shipped name and says so.

What `'strict-dynamic'` does and does not stop, checked in Chrome: a script delivered in markup without the nonce (an `iframe srcdoc` that inherits the policy) is blocked; an inline event handler injected through `innerHTML` is blocked; a script created by already-trusted code (`createElement`) runs, which is the point of `'strict-dynamic'` — the defence there is that no untrusted string reaches a script-creating sink.

## F-FE.7 Plan hand-offs

| File | Action | Contents |
|---|---|---|
| `docs/build-plan/in-11-operations-hardening.md` | edit | Add the doc 21 §8 PWA work F-DS assigned to IN-11: manifest, installability, offline shell, `DS-14` purge on logout/suspension |
| `docs/build-plan/README.md` | edit | Index row for F-FE |

## Increment exit

- [x] A failed request renders an error state on every screen; the portal never offers Sign in to a session it could not verify. Browser: with the API stopped, `/orders` and `/` show `UNEXPECTED_RESPONSE`, the shell shows no navigation, and the next navigation after restart restores it.
- [x] No route loads Zod; contracts' value imports in web code go through `@jobwork/contracts/constants` (test-enforced). 289 → 189 KB gzipped on `/login`.
- [x] Internal navigation is client-side (one document across sign-in and three page changes, `/auth/me` asked once); no `<button>` is nested in a link (test-enforced, 41 sites converted).
- [x] Every page response carries CSP and the secure headers; all 13 scripts on a page carry the response nonce; both apps sign in (operations through MFA), navigate and upload to the object store with zero `securitypolicyviolation` events.
- [x] A thrown render error shows a recoverable error state, not a blank page; an unknown address returns 404 inside the shell.
- [x] Full verify passes: `pnpm -r build && pnpm typecheck && pnpm lint && TZ=Asia/Kolkata pnpm test`.

**Closed 2026-10-04.** 445 tests green (api 186, ui 139, database 57, worker 30, web-kit 17, portal-web 14, observability 2), from 404 at the start.

**Deviation (2026-10-04):** the first full run failed two portal shell tests that passed alone. The spec reset its `api` mock in `afterEach`, which runs before `test/setup.ts`'s `cleanup()`; under the full run's load a passive effect was still pending, and unmounting flushed it against the reset mock. Resetting in `beforeEach` fixed it — under six concurrent runs the old ordering failed 3 of 30, the new 0 of 30.
