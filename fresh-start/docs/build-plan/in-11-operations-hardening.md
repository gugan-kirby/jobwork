# IN-11 — Operations hardening and SLOs

Scope source: [Implementation plan](../24-implementation-plan.md) §4 IN-11; doc 07 §11; doc 08 §14; doc 12 §§1, 3, 6–8, 12; doc 13 §§5, 9–10; doc 23 §4 nightly stage; doc 21 §8.
Edge cases owned (doc 19 §9): search/cache stale after revocation (invalidation verified); same person conflicting roles (SoD config surfaced).
Use cases: UC-35 (SLA/calendar config surface), UC-38 (escalation), UC-36 (security ops tooling).

**Refresh (2026-10-04, before build).** This plan was written at inception; the codebase has since moved. Changes against the original, each with its reason:

| Original | Now | Why |
|---|---|---|
| `0012_queues_sla.sql` | `0016_queues_sla.sql` | 0012–0015 were taken by commercial, orders/finance, production and communication |
| Queue rows written by each domain command | Queue membership stays a query over each module's own tables (the F-OPS summary filters); `queue_assignment` is a projection that adds owner, due time and escalation level, opened and closed by a sweep | Writing queue rows from fifteen commands across six modules couples every module to the platform; the summary queries already define membership and are tested to match their screens. Owner and deadline are the only state the queue itself owns |
| Escalation keyed by `(subject, policy_step, due_version)` | `sla_escalation` unique on `(queue_assignment_id, step, due_version)`; an assignment is one subject's stay in one queue | A subject that leaves a queue and returns gets a fresh clock; keying by assignment keeps "fires once per step" true per stay |
| `apps/worker/src/sla/escalator.ts` scans due rows | The API owns the sweep (`POST /internal/sla/sweep`, service-only); the worker ticks it | The worker holds no business-state access (doc 20 §9) — same split as the RFQ deadline and payment sweeps |
| `app/(shell)/queues/*` | `apps/operations-web/app/queues/page.tsx` | No route groups exist |
| Saved filters (unspecified store) | Preset filters (mine, unassigned, overdue, due today, per queue) held in the URL, last choice remembered per browser | A shareable URL is the saved filter operators exchange; server-stored personal filters wait for a request |
| F-11.2 store unspecified on Redis failure | Redis-backed budgets that fall back to per-instance in-memory budgets when Redis is unreachable | doc 12 §3: "Redis down: degrade rate convenience safely". Failing open would drop `AUTH-12`'s per-IP half; failing closed would turn a cache outage into an outage |
| Metrics format unspecified | Prometheus exposition format on a separate, non-public metrics port (`METRICS_PORT`) per process; Grafana dashboard JSON and Prometheus rule files | The de-facto provider-neutral format: every candidate under `T-01` ingests it. The public listener never serves `/metrics` |
| `fresh-start/runbooks/*.md` | `fresh-start/docs/runbooks/*.md` | Docs live under `docs/`; alerts link to them by repo path |
| `.github/workflows/nightly.yml` | Root `.github/workflows/{ci,nightly}.yml` with `working-directory: fresh-start`; `fresh-start/.github/` removed | GitHub reads workflows only from the repository root: `ci.yml` under `fresh-start/.github/` has never run (the repository reports zero workflows, checked 2026-10-04) |
| `cross-tenant-matrix.api.spec.ts` edit | new | No consolidated matrix exists; each increment's negative suite stays and the matrix adds the generated grid |
| Container rescan in nightly | Dependency audit only | No container images are built yet (`DO-06` arrives with `T-01`); recorded as a gap |
| PWA read cache of "non-sensitive projections" | No API response is cached; the service worker caches the offline page and content-hashed static assets only | Proving a projection carries no identity or price is per endpoint; caching none satisfies `DS-14` by construction. A reviewed projection can be added later |
| Execution order 11.1 → 11.6 | Unchanged | — |

## F-11.1 Work queues, SLA policies, business calendar

Covers: doc 07 §11; `BR-SYS-07`; UC-35 (SLA/calendar), UC-38; doc 21 queue table.

| File | Action | Contents |
|---|---|---|
| `database/migrations/0016_queues_sla.sql` | new | Schema `platform`: `business_calendar_version` (calendar key, version, IANA timezone, working days, working hours, holiday dates; immutable once active, one active per key), `sla_policy_version` (queue key, version, calendar key, target business minutes, escalation steps; immutable), `work_queue` (key, label, acting roles, escalation roles, SLA policy key or none), `queue_assignment` (queue, subject type/id, reference, opened/clock-start, due_at, due_version, policy and calendar versions, assignee, escalation level, next escalation instant, status open/closed, aggregate version), `sla_escalation` (unique assignment + step + due_version). Seeds the Chennai calendar v1, the sixteen queues and fourteen v1 policies, and the `internal.sla_due` / `internal.sla_escalated` templates |
| `apps/api/src/platform/sla/business-time.ts` | new | Pure: add business minutes in a calendar's timezone (working days, hours, holidays), DST-correct via `Intl` offsets; next working instant |
| `apps/api/src/modules/operations/domain/queues.ts` | new | One registry of queue definitions (key, label, href, roles, membership query, subject type) shared by the summary and the queues; membership returns subject, reference and waiting-since |
| `apps/api/src/modules/operations/application/{queue.command.ts,sla-sweep.command.ts}` | new | `take`, `release`, `reassign` (assignee must hold a queue role; reassigning someone else's item needs a reason; audited, `expectedVersion`); sweep: open assignments for new members (first stay clocks from the source's waiting-since, a return clocks from re-entry), close departed ones, recompute open deadlines when a calendar version activates (bumps `due_version`), fire due steps once each (`FOR UPDATE SKIP LOCKED`, insert-or-skip on the escalation key) with audit + outbox `platform.sla_escalated.v1` |
| `apps/api/src/modules/operations/presentation/{queues.controller.ts,sla.controller.ts}` | new | `GET /queues` (role-filtered items: live membership left-joined to assignments), `GET /queues/:key/assignees`, `POST /queues/:key/items/:subjectId/{take,release,reassign}`; `GET /sla/policies`, `GET /sla/calendars`, `POST /sla/calendars/:key/versions` (platform_admin, MFA); service-only `POST /internal/sla/sweep` |
| `apps/api/src/modules/communication/application/notification-rules.ts` | edit | `platform.sla_escalated.v1`: step 1 tells the assignee (or the queue's roles when unassigned), step 2 also tells the escalation roles; variables are the queue label and record reference only |
| `apps/worker/src/sla/escalator.ts` + `main.ts` | new/edit | Tick `POST /internal/sla/sweep` every `SLA_SWEEP_MS` |
| `packages/ui/src/data/QueueTable.tsx` | new | Doc 21 queue table: sticky reference column, due/overdue states in words and colour, owner, per-row actions only where the row allows them |
| `apps/operations-web/app/queues/page.tsx` + shell nav | new/edit | Every queue the actor works, with preset filters in the URL, take/release/reassign, and the SLA/calendar versions in force |

Tests: business-time — Asia/Kolkata across a weekend and a holiday; Europe/London and America/New_York across both DST transitions; start outside hours; deadline at the exact closing instant. API — sweep opens one assignment per member and closes departed ones; a return to the queue gets a new clock; escalation fires once per step under two concurrent sweeps; a new calendar version moves open deadlines and bumps `due_version`, and the step fires again only for the new deadline; reassignment is audited with its reason; an assignee without a queue role is refused; an external actor sees no queue; an escalation notification carries the reference, never content.

**Deviations (2026-10-04, F-11.1):**

- The registry is `operations/infrastructure/queue-registry.ts` (it holds SQL); the pure rules — clock start, step instants, which step fires, item state — are `operations/domain/deadline.ts`. The F-OPS summary now counts from the same registry, so its counts and the queue screen cannot disagree.
- One read, `GET /sla`, returns the calendars and policies in force, instead of two routes. Policies are read-only for now; only a calendar version can be published (a declared holiday is the change operations needs first).
- A first stay's clock starts at the item's waiting-since **or the policy's activation, whichever is later**: without the floor, the first sweep after go-live would declare months of history overdue at once.
- When several steps are past due (a backlog, a worker outage), only the highest fires — one notice, not a storm of stale "due" notices (doc 13 §11 "recover backlog without storm").
- Added `platform.queue_item_reassigned.v1` and the `internal.queue_item_assigned` template: an item handed to someone else tells them. Taking or handing back tells nobody.
- Seeded calendar is an assumption for operations to confirm: Chennai, Monday–Saturday 09:30–18:30 IST, fixed-date public holidays only (26 Jan, 1 May, 15 Aug, 2 Oct, 25 Dec for 2026–27). Festival dates that move each year are added as a new version. Escalation roles are seeded empty, so step 2 tells the queue's whole acting team; a lead role can be named per queue when one exists.
- The queue table is not virtualised and has no bulk selection: queues are tens of rows at launch.

**Browser verification (2026-10-04, F-11.1).** Driven against the dev stack with the worker running: the first live sweep opened seven stays; the queue screen listed exactly the command-center counts with deadlines in IST; take, hand back and reassign worked, and a reassignment produced the audit row with its reason, the in-app notice and an email (`apps/worker/var/mail`) linking to `/queues?queue=…` and naming only the record number. Five defects only the browser showed, all fixed:

| Defect | Fix |
|---|---|
| After **Take**, the row showed "Handed back": React reused the Take button's finished state for the Hand back button in the same slot — a false receipt | The two command buttons are keyed |
| At phone width the page title collapsed to one word per line beside the queue selector | `.jw-page-title-block` had a zero flex basis, so the header never wrapped; non-back headers now have an `18rem` basis (affected every page with a wide action) |
| Stacked rows repeated the title (card heading and "Item" row) | The stacked heading is the reference link alone |
| Three rows' links were all named "Supplier" | Each reference link carries the item title as a visually hidden suffix (WCAG 2.4.4) |
| The queue selector said "All queues (0)" while loading | No count until the data has arrived |

## F-11.2 Rate limits and abuse controls

Covers: doc 08 §§11, 14; doc 11 §10; `AUTH-12` per-IP half; doc 12 §3 Redis row.

| File | Action | Contents |
|---|---|---|
| `apps/api/src/platform/http/rate-limit/{policies.ts,store.ts,rate-limit.guard.ts,rate-limit.decorator.ts}` | new | Operation classes `login`, `public_form`, `upload`, `search`, `message`, `export`, `payment`, `webhook`, `service`, `command`, `read`, each with budgets by IP / user / organization / account; `@RateLimit(class)` on routes, method-based default otherwise; Redis fixed-window counters with an in-memory fallback; 429 `RATE_LIMITED` problem with `Retry-After` and "nothing was changed" guidance; budgets overridable by validated `RATE_LIMIT_POLICIES` (`DO-16`); `TRUST_PROXY` for client IPs |
| `packages/web-kit/src/api.ts` | edit | A 429 becomes an `ApiError` carrying `retryAfterSeconds` |
| `.github/workflows/ci.yml`, `infra/docker-compose.yml` | edit | Redis service for tests |
| `apps/api/test/rate-limit.api.spec.ts` | new | Budget exhaustion per class; webhook capacity isolated from public limits; per-account login budget independent of IP; Redis unreachable → in-memory budgets still limit; problem body and header |

**Deviations (2026-10-04, F-11.2):**

- An interceptor (`rate-limit/rate-limit.interceptor.ts`), not a guard: it runs after the session and service-principal guards, so budgets count per person and per organization, not only per address — everyone behind one office NAT shares an address. The cost: a flood of forged session cookies reaches the session guard's lookup before any limit; that belongs to the edge (WAF) in front of the API.
- Counters are a sliding-window estimate over two fixed windows, keyed by a SHA-256 of the identity: the store never holds an address or an e-mail in clear.
- `RATE_LIMIT_MODE` (`enforce` default, `observe` logs without refusing, `off`). The API suites run with `off` (vitest `env`) because they sign in hundreds of times from one address; `rate-limit.api.spec.ts` turns limits on for itself.
- The refusal is worded by class: sign-in "Too many sign-in attempts", reads "Too many requests in a short time", commands "Nothing was changed by this request" — each with the wait in seconds or minutes, and `Retry-After` plus `retryAfterSeconds` for software.
- **Deployment requirement (recorded for `T-01`):** Next's rewrite proxy sets `X-Forwarded-For` only when the header is absent, so it passes a client-supplied value through. Deployed, the edge must set the header and `TRUST_PROXY` must name the edge and web-app hops; otherwise per-address budgets can be dodged by rotating a forged header. Per-account, per-person and per-organization budgets do not depend on it.
- The module waits up to one second for Redis at start: without the wait, the first requests after a deploy raced the handshake and put every instance into degraded mode for 30 seconds (found by the suite's "counters are in Redis" assertion).

**Browser verification (2026-10-04, F-11.2).** Through the operations app's proxy: five wrong passwords met the existing per-account lockout, the eleventh attempt the account budget (429, `Retry-After: 527`); the budget survived an API restart (Redis). The login screen showed "Try again in 9 minutes" — after first showing "527 seconds" and "Nothing was changed by this request", both reworded as above.

## F-11.3 Metrics, dashboards, alerts, business-control panel, SoD

Covers: doc 12 §§1, 6–8; `ES-35`; doc 19 §9 SoD row; doc 03 §§2, 4.

| File | Action | Contents |
|---|---|---|
| `packages/observability/src/metrics.ts` | new | Registry + exposition server on `METRICS_PORT`; RED histogram by route template, method, status class, caller type (no ids in labels) |
| `apps/api/src/platform/metrics/*` | new | HTTP hook; command outcomes by operation and result class (incl. concurrency conflicts); scrape-time DB gauges: outbox backlog/age/dead letters, scan backlog, leakage backlog, payment suspense, blocked work packages, queue sizes and oldest age, SLA overdue per queue, auth failures |
| `apps/worker/src/metrics.ts` | new | Handler outcomes and durations by event type, sweep outcomes |
| `infra/dashboards/{platform,operations,security}.json`, `infra/alerts/{platform,operations,security}.yaml` | new | Grafana dashboards and Prometheus rules; every rule has owner, severity `page`/`ticket`, impact, window, runbook link; annotations carry no customer/supplier/file/payment data |
| `apps/api/src/modules/operations/presentation/health-panel.controller.ts`, `apps/operations-web/app/ops-health/page.tsx` | new | `GET /operations/controls`: business controls (oldest untriaged, blocked releases, suspense, held messages, overdue by queue) role-filtered like the summary; platform signals (outbox, dead letters, scan backlog) for platform/security admins; role conflicts |
| `apps/api/src/modules/iam/domain/separation-of-duties.ts` + invite-member | new/edit | SoD rule set from doc 03 §§2, 4; inviting a conflicting internal role set is refused (`ROLE_CONFLICT`, names the rule); existing conflicting memberships listed on the panel |

Tests: metrics carry no id-shaped label values; every alert/dashboard expression names a registered metric; every `page` alert links an existing runbook; HTTP histogram labels use the route template; conflicting invitation refused, non-conflicting accepted; panel role filtering.

## F-11.4 Runbooks

Covers: doc 12 §12 list; doc 11 §15 runbook contents.

| File | Action | Contents |
|---|---|---|
| `docs/runbooks/*.md` (12 files) + `docs/runbooks/README.md` | new | One per doc 12 §12 entry: signals and alerts that link here, diagnostics (read-only SQL selecting counts and ids, never contact or file data), mitigation, authority, communication owner, recovery verification, post-incident review |
| `apps/api/test/runbooks.db.spec.ts` | new | Every SQL block in every runbook parses and runs read-only against the migrated schema |

## F-11.5 CI wiring, nightly suites, cross-tenant matrix

Covers: doc 23 §4 nightly stage; doc 13 §§5, 10.

| File | Action | Contents |
|---|---|---|
| `/.github/workflows/ci.yml` (moved), `/.github/workflows/nightly.yml` | new | CI at the repository root; nightly: full suite, cross-tenant matrix, adversarial file corpus, perf smoke against a booted API, `pnpm audit` |
| `apps/api/test/cross-tenant-matrix.api.spec.ts` + `test/helpers/world.ts` | new | One world through the real API (two customers, two suppliers, internal roles); a declared grid of actor × resource × action with expected allow/deny; denial for another tenant's id is indistinguishable from a missing id; suspension denies detail and download immediately |
| `infra/perf/smoke.mjs` | new | Dependency-free load smoke: login, summary, lists, detail; p50/p95/p99 against `NFR-02` |

## F-11.6 Installable portal and offline shell

Covers: doc 21 §8, `DS-14`, `BR-AUTH-05`, ADR-0005. F-DS assigned this work to IN-11; this section carries it (added 2026-10-04 by F-FE.7).

| File | Action | Contents |
|---|---|---|
| `apps/portal-web/app/manifest.ts` + icons | new | Web app manifest (name, icons, `display: standalone`, theme colour from tokens); installability on Android Chrome and iOS Safari |
| `apps/portal-web/public/sw.js` + registration in `app/shell.tsx` | new | Network-first navigation with an offline page fallback; cache-first for content-hashed static assets; no API response and no authenticated page cached (`DS-14`). Loads under the F-FE.6 nonce CSP (`worker-src 'self'`) |
| `apps/portal-web/app/shell.tsx`, `packages/web-kit/src/api.ts` | edit | Purge caches on logout and on a 401 (`BR-AUTH-05`); a non-GET while offline is refused with "Connection needed — nothing was sent", never queued |

Tests: the service worker never stores an `/api/` response or an authenticated navigation; logout and 401 empty every cache; a command attempted offline is refused with the connectivity message and no request is made.

## Increment exit

- [ ] Doc 12 §1 signals measured with dashboards live locally; gaps listed with owners.
- [ ] Every paging alert has a runbook file; alert payloads contain no sensitive data (doc 12 §8).
- [ ] Nightly pipeline green end to end at least once.
