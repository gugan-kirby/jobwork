# Engineering standards and repository playbook

This document turns the guardrails of [System architecture](04-system-architecture.md) §13 and the quality bars of [Testing strategy](13-testing-strategy.md) into day-to-day conventions for the team writing code. It governs the monorepo proposed in doc 04 §8. Where it proposes tooling, those are recommended defaults recorded properly at inception (`T-01`–`T-06` posture); where it states rules, they are review-blocking.

Rules carry `ES-nn` identifiers.

## 1. Repository baseline

| Concern | Standard |
|---|---|
| Package manager / workspaces | pnpm workspaces (recommended); one lockfile at root, committed |
| Task runner | Workspace-aware task graph (Turborepo or Nx — pick once at inception) with remote cache disabled until security review |
| Language level | TypeScript strict mode everywhere: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`; shared `packages/config` tsconfig is the only base |
| Lint/format | ESLint (typed rules) + Prettier from `packages/config`; zero warnings policy — a warning is either fixed or ruled out explicitly |
| Node runtime | Single pinned LTS version via `.nvmrc`/`engines`; CI and containers use the same digest-pinned base image |
| Commit style | Conventional Commits (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`); scope = module or app name (`feat(sourcing): …`) |
| Branching | Trunk-based: short-lived branches off `main`, merged by PR only; no long-running release branches until a supported-versions need exists |

- `ES-01`: `main` is always releasable; anything not ready ships dark behind a feature flag (doc 12 §10) rather than sitting on a stale branch.
- `ES-02`: Generated artifacts (API clients, migration snapshots, OpenAPI) are either always generated in CI or always committed — never a mix; the choice is documented per artifact.

## 2. Module anatomy (`apps/api`)

Each domain module from doc 04 §5 follows one shape:

```text
apps/api/src/modules/<module>/
  domain/          # entities, value objects, state machines, domain errors — pure TS, no framework imports
  application/     # command/query handlers, ports (interfaces), transaction orchestration
  infrastructure/  # repositories, provider adapters, outbox publishers — implements ports
  presentation/    # HTTP controllers, DTO mapping, request validation
  index.ts         # THE public surface: exported application services/ports only
```

- `ES-03`: Cross-module imports go through the target module's `index.ts` public surface only. Deep imports (`modules/finance/infrastructure/…` from another module) are build failures, enforced by import-boundary lint (`eslint-plugin-boundaries` or dependency-cruiser) plus an architectural test.
- `ES-04`: `domain/` imports nothing from NestJS, Fastify, the ORM, or providers (doc 04 §13). Value objects own validation of their own invariants (`Money`, `Quantity`, `MeasurementValue`, branded ID types).
- `ES-05`: One command = one handler = one transaction boundary. The handler template is fixed (doc 02 §8): idempotency check → authorize → load with expected version → guard state transition → mutate → append audit + outbox → commit. Helpers may factor steps out, but no handler skips or reorders them.
- `ES-06`: Queries never reuse command aggregates for external output; they build purpose-scoped projections (doc 08 §1) with authorization predicates inside the SQL (doc 03 §1).

## 3. Type discipline

- `ES-07`: IDs are branded types (`EnquiryId`, `QuoteVersionId`), minted at the boundary; a raw `string` ID crossing module boundaries is a review reject.
- `ES-08`: State enums are closed unions with exhaustive `switch` handling (`never` check); adding a state fails compilation everywhere the state matters — the code analogue of doc 06 §1.
- `ES-09`: Money is `{ amountMinor: bigint | number-safe integer; currency: CurrencyCode }` via the shared `Money` value object; float arithmetic on money is banned by lint rule and review (`BR-FIN-01`).
- `ES-10`: External input crosses the edge only through schema validation (Zod or class-validator — one, chosen at inception, used everywhere). Internal code never re-parses what the edge validated; types flow from the schema.
- `ES-11`: `packages/contracts` holds wire DTO types generated/shared per audience (customer, supplier, internal). Domain entities never appear in it (doc 04 §13); the customer-safe projection types are what `DS-11` consumes in the UI.

## 4. Error and result conventions

- `ES-12`: Domain failures are typed domain errors with stable machine codes (`QUOTE_SUPERSEDED`, `VERSION_CONFLICT` — the doc 08 §3/§6 vocabulary), thrown/returned from guards and mapped centrally to problem details. String-throwing or `Error("something failed")` in domain code is a reject.
- `ES-13`: The central error mapper is allowlist-based: unknown errors become an opaque 500 with correlation ID; internal messages, stack traces, SQL, and provider payloads never serialize outward (doc 08 §3, doc 11 §14).
- `ES-14`: No silently swallowed promise rejections or empty `catch`. A caught error is handled (mapped, compensated, retried) or rethrown with context — logging alone is not handling.
- `ES-15`: Worker jobs classify failures as retryable vs. permanent explicitly (doc 07 §10); a job that can throw ambiguously is incomplete.

## 5. Database and migration authoring

- `ES-16`: Migrations are forward-only SQL (or SQL-first tool), reviewed like code, and follow expand → migrate → contract across releases (doc 05 §16); a single PR never renames-and-drops in one step against a live table.
- `ES-17`: Every table carries the doc 05 §2 baseline columns; immutable version tables get their protection (repository discipline plus trigger/privilege strategy where adopted) in the same migration that creates them, not later.
- `ES-18`: Naming: snake_case tables/columns, singular table names as in doc 05 §4, `_id` suffix for FKs, `chk_`/`uq_`/`idx_` prefixes for constraints/indexes; every FK is indexed deliberately or its absence justified in the migration comment (doc 05 §13).
- `ES-19`: Data backfills are separate, resumable, idempotent scripts with progress logging — never inline in schema migrations (doc 05 §16).
- `ES-20`: Repository methods take an explicit organization/relationship scope parameter; a repository method without a scope is only legal inside the platform module and must be named `…Unscoped` so review can see it (doc 11 §7).

## 6. Testing conventions

Placement and naming (layers per doc 13 §2):

```text
*.spec.ts          co-located unit/property tests (domain, application)
*.db.spec.ts       database integration (real PostgreSQL via testcontainers)
*.api.spec.ts      API contract tests
e2e/               browser + workflow suites, per app
packages/test-kit  factories, builders, harnesses, fixed clock, seeded scenarios
```

- `ES-21`: Factories build valid aggregates by default and require explicit opt-in to cross organizations (doc 13 §13); a factory that can accidentally produce cross-tenant fixtures is a defect.
- `ES-22`: Time, randomness, and IDs are injected (clock port, ID generator port) — no `new Date()`/`Math.random()` in domain or application code; tests use the fixed clock from test-kit.
- `ES-23`: Every feature PR includes the negative-authorization cases for its new surface (doc 13 §5) and the state-machine illegal-edge cases for any new transition (doc 13 §3). "Tests added" without these is not done (doc 13 §15).
- `ES-24`: Property tests cover conservation/determinism claims (money sums, quantity conservation, canonical hashing) wherever doc 07 declares them; golden examples are hand-computed and cited in the test.

## 7. Pull request and review

PR template requires: linked requirement/rule IDs (`FR-…`, `BR-…`, or "none — mechanical"), what changed and why, authorization/audience impact, audit/outbox impact, migration/rollback note, test evidence, and screenshots for UI (per doc 17 §7 change-control rule).

- `ES-25`: A PR is small enough to review properly (guideline ≤ ~400 changed lines excluding generated/lock files); larger changes are stacked or split by expand/contract steps.
- `ES-26`: Review is mandatory (min one qualified reviewer; two for auth policy, money posting, release gates, migration of immutable tables). Self-merge without review is disabled on `main`.
- `ES-27`: Reviewers check the standards in this document plus: does the change leak data across an audience boundary, mutate an immutable artifact, bypass a named command, or skip audit/outbox? Any yes blocks.
- `ES-28`: CI gates from doc 13 §14 are required checks; a red or flaky-skipped check cannot be admin-merged except through the incident process with an issue attached.

## 8. Definition of ready (complements doc 13 §15 definition of done)

A story enters a sprint only when it has:

1. requirement/rule IDs and acceptance criteria;
2. authorization audience decided (who may do/see this);
3. state/command impact named (which transitions, which guards);
4. audit/outbox/notification events listed;
5. error/edge cases from doc 19 identified as in/out of scope;
6. UX state coverage (empty/loading/error/conflict) referenced against doc 21 patterns;
7. no unresolved dependency on an open decision (`D-*`, `T-*`) — or the story is explicitly building the decided-safe default.

## 9. Dependency policy

- `ES-29`: Adding a runtime dependency requires justification in the PR (what it does, why not stdlib/existing dep, maintenance status, license). Transitive-heavy or unmaintained packages are rejected by default.
- `ES-30`: Lockfile integrity, provenance/signature verification where the ecosystem supports it, and automated vulnerability scanning with a patch SLA (critical: days, high: two weeks) per doc 11 §10; overrides/resolutions carry an expiry comment.
- `ES-31`: License allowlist: permissive (MIT/Apache-2.0/BSD/ISC) by default; copyleft or unusual licenses need explicit approval before merge.
- `ES-32`: Framework/runtime upgrades ride their own PRs (never mixed with features) and record resulting supported versions in the dependency policy file (doc 04 §4 note).

## 10. Observability and logging in code

- `ES-33`: Use the `packages/observability` logger only; `console.*` in application code fails lint. Log calls take structured fields, never interpolated sensitive values; the doc 11 §14 exclusion list is enforced by redaction tests.
- `ES-34`: Every command handler emits its metric/trace span with operation name matching the API command name; correlation/causation IDs propagate through outbox to workers (doc 12 §6, `NFR-11`).
- `ES-35`: New failure modes ship with their alert/runbook impact stated in the PR (doc 13 §15); "we'll notice in logs" is not an operability plan.

## 11. Documentation-as-code

- `ES-36`: Architecture-material changes require an ADR in `docs/adr` (superseding, never rewriting — ADR README rule); product-rule changes update the affected numbered doc in the same PR (doc 17 §7).
- `ES-37`: Each module keeps a short `README.md` (purpose, owned tables, public commands/queries, events emitted/consumed) — the human index that keeps doc 04 §5 true over time.
- `ES-38`: Runbooks live with the platform docs and are updated in the PR that changes the behavior they describe (doc 12 §12).
