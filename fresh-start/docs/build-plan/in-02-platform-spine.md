# IN-02 — Platform spine: audit, outbox, idempotency, command template

Scope source: [Implementation plan](../24-implementation-plan.md) §3 IN-02; `BR-SYS-01`–`BR-SYS-07`; doc 05 §§11–12; doc 07 §§9–10.
Edge cases owned (doc 19 §9): notification queued but transaction rolled back; duplicate provider/notification delivery; two users edit same draft (version conflict).
Use cases advanced: UC-38 (retry machinery), UC-37 partial (audit read path).

## F-02.1 Platform migrations

| File | Action | Contents |
|---|---|---|
| `database/migrations/0003_platform.sql` | new | `audit_event` (append-only; restricted role no UPDATE/DELETE), `outbox_event` (envelope cols per doc 08 §8, status, attempts, next_attempt_at, priority, partial index on unpublished), `idempotency_record` (unique (scope, operation, key), request_hash, status, result_ref), `inbox_receipt` (unique (consumer, event_id)) |
| `database/tests/platform-constraints.db.spec.ts` | new | Audit UPDATE/DELETE denied at DB privilege level; outbox partial index used (EXPLAIN sanity) |

## F-02.2 Command execution template

Covers: `ES-05`; doc 02 §8 recipe; `BR-SYS-03`/`04`.

| File | Action | Contents |
|---|---|---|
| `apps/api/src/platform/commands/command.ts` | new | `CommandContext` (actor, org, correlation, clock), `DomainError` base with stable codes |
| `apps/api/src/platform/commands/execute.ts` | new | The template: idempotency claim (canonical request hash; same key + different payload → `IDEMPOTENCY_PAYLOAD_MISMATCH`) → handler in `withTransaction` → audit append → outbox append → result persist → commit |
| `apps/api/src/platform/commands/audit.writer.ts` | new | Minimized audit payload builder (doc 05 §12 last para) |
| `apps/api/src/platform/commands/outbox.writer.ts` | new | Versioned envelope per doc 08 §8 |
| `apps/api/src/platform/commands/expected-version.ts` | new | `WHERE id=? AND aggregate_version=?` helper; zero rows → `VERSION_CONFLICT` |

Unit tests: canonical hash stable under key order/volatile headers; error taxonomy mapping.
DB tests (the spine's soul, doc 13 §4): forced failure after audit write rolls back state+audit+outbox together; concurrent same-key commands → one execution, second gets original result; concurrent different-version updates → one winner.

## F-02.3 Worker outbox leasing and delivery

Covers: doc 07 §10 (corrected backoff), doc 05 §12.

| File | Action | Contents |
|---|---|---|
| `apps/worker/src/outbox/poller.ts` | new | `FOR UPDATE SKIP LOCKED` lease batch, per-event dispatch, attempt/backoff `min(cap, base*2^n*jitter)`, dead-letter state |
| `apps/worker/src/outbox/handlers/registry.ts` | new | eventType → handler map; unknown type → parked with alert log |
| `apps/worker/src/outbox/handlers/invitation-issued.ts` | new | Sends invitation mail via mailer; nulls transient token payload column after confirmed send (raw token must not outlive delivery) |
| `apps/worker/test/outbox.db.spec.ts` | new | Two workers never double-process (SKIP LOCKED race test); kill-between-send-and-mark leaves retry-safe state; poison event → dead-letter after max attempts, others continue |

## F-02.4 Refactor IN-01 commands onto the spine

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/iam/application/*.command.ts` | edit | All IAM commands run through `execute.ts`; auth events from doc 20 §12 become real audit rows; invitation email becomes outbox-driven (removing IN-01 interim direct call) |
| `apps/api/test/iam-spine.db.spec.ts` | new | invite-member: business row + audit + outbox in one transaction; rollback drill leaves no invitation and no email event |

Edge (doc 19 §9): "notification queued but transaction rolled back → no outbox event, therefore no false notification" — this exact test.

## F-02.5 Correlation and observability wiring

Covers: `NFR-11`, doc 12 §6, `ES-34`.

| File | Action | Contents |
|---|---|---|
| `packages/observability/src/context.ts` | new | AsyncLocalStorage correlation context; child loggers |
| `apps/worker/src/outbox/poller.ts` | edit | Propagate correlation/causation from envelope into handler logs |
| `apps/api/src/platform/http/metrics.ts` | new | RED metrics per operation; outbox age gauge |

Test: trace drill — one command's correlation id appears in API log, audit row, outbox row, worker log, mail metadata.

## F-02.6 Minimal audit explorer (operations app)

Covers: UC-37 read path start; doc 14 §6 audit surface.

| File | Action | Contents |
|---|---|---|
| `apps/api/src/platform/presentation/audit.controller.ts` | new | Cursor-paginated query (doc 08 §4), filter allowlist (actor, aggregate, action, time), security-role guarded |
| `apps/operations-web/app/(shell)/audit/page.tsx` | new | Table with correlation-id copy, filter bar; read-only |

Tests: non-security role denied; cursor stable under inserts.

## Increment exit (doc 24 IN-02 = roadmap foundation exit)

- [x] Drills green (2026-09-02): atomic rollback of state+audit+outbox on handler failure; duplicate command returns original result without re-execution; payload-mismatch conflict; concurrent same-key race executes once; SKIP LOCKED double-processing race; poison-message dead-letter; visibility-timeout crash reclaim (22 API + 6 worker + 11 database tests).
- [x] invite-member live end-to-end: MFA-enrolled admin → command with Idempotency-Key → atomic audit+outbox → worker → mail file, one correlation id across audit row, outbox event, and delivery; rawToken stripped after send.
- [x] Audit explorer live in operations app (filters + cursor, role-gated); audit rows append-only via database trigger regardless of connection role.

### Deviations recorded during build (protocol rule 3)

1. Idempotency claim rolls back with the failed transaction (retry re-executes cleanly) instead of persisting a failed claim row — simpler and equivalent for single-transaction commands.
2. Full CommandExecutor used for invite-member (the exemplar); other IAM commands append audit rows via AuditWriter inside their existing transactions. Login success/failure remain structured logs pending a security-event volume decision — carried to IN-11.
3. Outbox `attempts` increments at claim time (visibility-timeout reclaims count as attempts).
4. F-02.5 metrics are minimal (worker backlog/oldest-age heartbeat; request logs) — RED metric emission consolidated into IN-11 as planned there.
5. Mail delivery uses the `log://` FileMailer (`var/mail/*.json`); SMTP adapter slot fails fast until a provider is selected.
