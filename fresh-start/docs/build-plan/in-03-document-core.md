# IN-03 — Document core: upload, scan, versions, audience

Scope source: [Implementation plan](../24-implementation-plan.md) §3 IN-03; `FR-600` subset; doc 05 §7; doc 08 §7; doc 09 §§2–5; doc 11 §8.
Edge cases owned (doc 19 §3): corrupt/malicious/password-protected/unsupported/huge file; same bytes new filename; embedded party metadata (baseline detection); customer withdraws file; downloaded-before-revocation.
Use cases: UC-03, UC-40 (file half).

## F-03.1 DMS migrations

| File | Action | Contents |
|---|---|---|
| `database/migrations/0004_dms.sql` | new | `file_object` (sha256 unique-per-tenant-policy, size, detected type, scan_state, storage_key), `document` (type, title, classification, retention_class, owner org), `document_version` (doc+version unique, file_object ref, engineering revision label, supersedes), `audience_grant` (version, audience type, party, actions, validity, revoked_at), `upload_session` (grant scope, expiry, status) |
| `database/tests/dms-constraints.db.spec.ts` | new | Version uniqueness; grant FK integrity; scan_state transitions constrained |

## F-03.2 Upload protocol (initiate → direct PUT → finalize) — **done** (2026-09-05)

Covers: doc 08 §7 exactly.

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/dms/application/initiate-upload.command.ts` | new | Purpose-scoped size/type policy, short-lived signed PUT to quarantine prefix |
| `apps/api/src/modules/dms/application/finalize-upload.command.ts` | new | Verify object size/sha256 against store metadata, create file_object(quarantined) + document_version(processing), idempotent |
| `apps/api/src/modules/dms/infrastructure/object-store.ts` | new | S3-compatible port (MinIO dev): sign PUT/GET, head, copy quarantine→clean, delete |
| `apps/api/src/modules/dms/infrastructure/sigv4.ts` | new | SigV4 query-presign and header-signing primitives the port is built on |
| `apps/api/src/modules/dms/infrastructure/dms.repository.ts` | new | Organization-scoped SQL for sessions, file objects, documents, versions |
| `apps/api/src/modules/dms/domain/upload-policy.ts` | new | Per-purpose size/media-type/extension limits, filename hardening |
| `apps/api/src/modules/dms/domain/errors.ts` | new | `UPLOAD_POLICY_REJECTED`, `UPLOAD_SESSION_INVALID`, `UPLOAD_VERIFICATION_FAILED`, `DOCUMENT_NOT_FOUND` |
| `apps/api/src/modules/dms/presentation/documents.controller.ts` | new | initiate/finalize/list/manifest endpoints |
| `apps/api/src/modules/dms/dms.module.ts`, `index.ts` | new | Module wiring and ES-03 public surface |
| `packages/contracts/src/dms.ts` | new | Edge schemas: initiate/finalize requests, document + manifest responses |
| `apps/api/test/dms-upload.api.spec.ts` | new | 9 cases against real MinIO (below) |

Tests (green 2026-09-05): grant→upload→finalize→manifest with audit + `dms.file_finalized` outbox event; policy refusal by size, media type and extension; single-purpose grant (GET refused, moved key refused, oversize refused, tampered bytes refused by the store, expired grant refused); finalize with wrong digest fails closed (session aborted, object deleted, no version, retry dead); finalize with wrong size and with no uploaded object fail closed; double finalize returns the same version; same bytes re-uploaded reuse the file object and append version 2 with a stale `expectedVersion` conflicting; cross-tenant finalize/manifest/list denied; expired session refuses late bytes.

## F-03.3 Scan pipeline worker — **done** (2026-09-05)

Covers: doc 09 §4; doc 11 §8; doc 20 §9 service identity; `T-06` behind a port (dev adapter: signature/type sniff + archive structure limits + EICAR string match; real engine adapter slot documented on the `Scanner` interface).

| File | Action | Contents |
|---|---|---|
| `apps/worker/src/outbox/handlers/file-finalized.ts` | new | Claim the scan, read bounded bytes, re-verify the digest, run the adapter under a deadline, record the verdict through the internal command |
| `apps/worker/src/scan/scanner.ts` | new | `Scanner` port + `SignatureScanner` dev adapter; verdict + stable reason code |
| `apps/worker/src/scan/archive.ts` | new | ZIP central-directory reader (inspection only, never expands) |
| `apps/worker/src/internal-api.ts` | new | Worker→API client; mints a short-lived service credential per call |
| `apps/api/src/modules/dms/application/record-scan-result.command.ts` | new | Service-principal-only; copies quarantine→clean on `clean`, settles waiting versions, releases nothing by itself |
| `apps/api/src/modules/dms/application/begin-scan.command.ts` | new | Claims a file into `scanning` so an interrupted scan stays visible |
| `apps/api/src/modules/dms/presentation/internal-scan.controller.ts` | new | `@ServiceOnly` internal routes: begin, result |
| `apps/api/src/platform/http/service-principal.guard.ts` | new | `@ServiceOnly` guard; session guard stands aside for these routes |
| `packages/service-auth/` | new | Named principals, short-lived token mint/verify (worker mints, API verifies) |
| `packages/object-store/` | new | SigV4 + store client extracted from the API so the worker reads bytes without duplicating signing |
| `packages/test-kit/src/file-corpus.ts` | new | Doc 13 §6 corpus built in memory, including a ZIP builder |
| `apps/worker/test/scan.spec.ts`, `apps/api/test/dms-scan.api.spec.ts` | new | 24 + 6 cases (below) |

Tests (green 2026-09-05): the fifteen-entry corpus — clean PDF/PNG/xlsx/STEP, EICAR sample, renamed executable, PNG-declared-PDF, truncated PDF, PDF with embedded JavaScript, encrypted archive, nested archive, decompression bomb, macro project, path-traversal entry name, truncated archive — each reaching its exact verdict and reason, plus a sweep asserting no unsafe entry can return `clean`; digest mismatch after finalize refused; oversize refused as policy, not retried; scanner timeout and scanner crash retry and then quarantine when retries are spent; a settled file stops the worker; a duplicate delivery meeting a recorded verdict completes. API side: user session (org admin) and forged, unknown-principal, and expired tokens all refused with the file left quarantined; clean verdict promotes bytes to the clean bucket, deletes the quarantine copy, marks the version available, emits `dms.file_cleared`, and audits as `actor_type=service`; infected verdict quarantines the version and keeps the bytes as evidence with no clean-bucket copy; retriable failure leaves the version processing and allows `failed → scanning` re-claim, terminal failure quarantines it; replaying a verdict is idempotent while a contradicting one is refused `SCAN_VERDICT_CONFLICT`; unknown file object 404s.

Live end-to-end (2026-09-05): the real worker handler against a running API and MinIO — clean PDF ended `clean`/`available` in the clean bucket, EICAR sample ended `infected`/`quarantined` with bytes retained, both audited under the service principal.

## F-03.4 Audience grants and downloads — **done** (2026-09-05)

Covers: `BR-ENG-02/08`; doc 03 §6 signed-URL bounds; doc 03 §7 negative matrix; doc 20 §8 propagation target 5.

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/dms/application/grant-audience.command.ts` | new | Explicit version grant with audience type/party/validity; blocked unless scan clean; re-release returns the live grant |
| `apps/api/src/modules/dms/application/revoke-grant.command.ts` | new | Revocation with audit; records the download count taken before revocation as history |
| `apps/api/src/modules/dms/domain/audience-policy.ts` | new | Who may release, who may read, and the shielding rule |
| `apps/api/src/modules/dms/presentation/download.controller.ts` | new | Grant/revoke/list routes plus authorize-now → short-TTL signed GET on the storage origin, attachment disposition |
| `apps/api/test/dms-negative.api.spec.ts` | new | 9 cases (below) |

Authorization is one SQL decision (`DmsRepository.decideAccess`): owner-organization access and live-grant access are computed in the query over `audience_grant`, so a revoked, expired, or wrong-audience grant is simply absent rather than fetched and filtered.

Tests (green 2026-09-05): owner downloads its own cleared file and the access log records it, with the URL on the storage origin, `attachment` disposition, and a TTL inside `DOWNLOAD_GRANT_TTL_SECONDS`; processing and infected content refuses both release and download (`BR-ENG-08`); another organization's version cannot be fetched, released, or probed — an unknown id answers identically; an external party cannot name a counterparty organization and can release only to JobWork; JobWork sourcing can read a released file while `platform_admin`/`security_admin` cannot, and an auditor reads only through an auditor grant; a release binds one version, so the supplier holding v1 gets nothing on v2 (`BR-ENG-02`); revocation kills future access immediately, is idempotent, keeps the access-log rows (append-only trigger refuses `DELETE`), and audits `downloadsBeforeRevocation`; a closed validity window stops honouring the grant and a backdated one is refused outright; a suspended membership loses file access on the running session.

## F-03.5 Upload UI component — **done** (2026-09-05)

Covers: doc 21 §6 file-upload and manifest-row contracts.

| File | Action | Contents |
|---|---|---|
| `packages/ui/src/upload/FileUpload.tsx` | new | Phases idle→preparing→uploading→verifying→scanning→ready/quarantined; client-side SHA-256; XHR progress; resume on refresh via `upload_session`; refusals name their problem code and the corrective action |
| `packages/ui/src/document/ManifestRow.tsx` | new | Doc 21 manifest row (name, revision, system version, mono hash, scan state, audience state) + header; download offered only when the version is releasable |
| `packages/ui/src/index.ts`, `tsconfig.json`, `package.json` | changed | The design-system package now ships components, not only tokens |
| `apps/portal-web/app/documents/page.tsx` | new | Purpose picker, uploader, and per-document manifest with download |
| `apps/portal-web/lib/api.ts` | changed | Commands can carry an `Idempotency-Key` |
| `apps/api/.../documents.controller.ts` | changed | `GET /documents/uploads/:id` for resume; manifest rows carry live `audiences` |
| `packages/contracts/src/dms.ts` | changed | `UPLOAD_POLICY`/`acceptAttribute` (shared with the UI), `uploadSessionStatusSchema`, `audiences` on version rows |

**Defect fix (2026-09-06).** `GET /documents` returned a document summary with no version identity, so no caller could attach a document to anything: the enquiry wizard filtered its list on a `currentVersionId` the API never sent and therefore always showed an empty library. `documentSummarySchema` now carries `currentVersionId`, `currentVersionStatus` and `currentVersionScanState` (list built from a lateral join on the newest version; manifest from the version rows it already returns), which is what an attach decision needs — the same three facts `documentsUsable` checks server-side. `apps/portal-web/lib/upload-api.ts` extracts the `FileUploadApi` wiring both the library page and the wizard now share. Test: `dms-upload.api.spec.ts` — "lists the version an attach would use, with the states that decide it".
| `database/seeds/dev-seed.ts` | changed | Also seeds a customer member, since the portal cannot be exercised by an MFA-gated internal account |

Live end-to-end in a real browser against the running stack (2026-09-05, Chrome via Puppeteer, portal 3002 → API 4000 → MinIO 9000 → worker):

- clean PDF: file chosen → hashed → direct PUT to storage (browser CORS preflight included) → finalize → **Scanning** → **Ready**, manifest row showing `v1`, mono digest, `scan: clean`, `Not released`;
- download: the issued URL is on the storage origin, carries `content-disposition: attachment`, expires in 120 s, and returns the original bytes;
- EICAR sample: → **Quarantined** with the corrective-action panel and `scan result: infected`; the row shows `Blocked by scan` and offers no download;
- resume: an interrupted session survives a reload — the component asks the API what became of it and reports “was not finished”, then continues under the same idempotency key.

### Deviations recorded during build (protocol rule 3)

1. **SHA-256 is declared at initiate, not only at finalize.** Doc 08 §7 lists the digest on finalize; verifying it "against store metadata" requires the store to hold it, and an S3-compatible store only records a SHA-256 the client sent at PUT. The digest is therefore declared up front and signed into the grant, so mismatched bytes are rejected by the store on arrival (MinIO: `XAmzContentChecksumMismatch`, 400) and finalize re-checks the stored value. Finalize still carries size and digest, and refuses any declaration that disagrees with the session or the store.
2. **SigV4 is implemented in `sigv4.ts` rather than pulling the AWS SDK** (ES-29: four operations used, transitive-heavy dependency otherwise). Behaviour was verified empirically against MinIO before the code was written: method-, key-, length-, digest- and time-binding all enforced by the store.
3. **Extra files beyond the plan's manifest**, all following the IAM module's layering: `sigv4.ts`, `dms.repository.ts`, `domain/upload-policy.ts`, `domain/errors.ts`, `dms.module.ts`/`index.ts`, and `packages/contracts/src/dms.ts`.
4. **`VersionConflict` moved** from `modules/iam/domain/errors.ts` to `platform/http/domain-error.ts` (re-exported from IAM) so every versioned aggregate shares one code without a cross-module deep import.
5. **Upload purpose is the document logical type** (doc 05 §7 enum) rather than a second vocabulary; size/format policy keys off it.
6. **Deduplication is per organization**: finalize reuses an existing `file_object` with the same digest, appends the new version, deletes the redundant quarantine object, and emits no scan event (the verdict already exists). A reused *clean* file yields an `available` version immediately; everything else is `processing`.
7. **Infrastructure**: `infra/stack.sh` now starts MinIO and creates both buckets, and CI gained a `minio/minio:edge-cicd` service — the upload tests run against a real store, not a fake.
8. **F-03.3: a second internal command, `begin-scan`.** The database trigger runs `quarantined → scanning → verdict`, and a claim step is what makes an interrupted scan visible instead of invisible; it also gives the retry path its one legal way back (`failed → scanning`). Recording a verdict for a file that was never claimed still passes through `scanning` so the history stays truthful.
9. **F-03.3: two packages extracted rather than duplicated.** `@jobwork/object-store` (SigV4 + client) because the worker must read quarantined bytes, and `@jobwork/service-auth` (named principals, token mint/verify) because the worker mints what the API verifies. Duplicating either would let security-critical code drift between two runtimes.
10. **F-03.3: service credentials are short-lived HMAC tokens** minted per call from `SERVICE_TOKEN_SECRET`, with the principal named in the token and allow-listed per route. This satisfies doc 20 §9 (no shared user accounts, no long-lived API keys) at MVP; the mint side is the documented slot for cloud workload identity. The `scan-worker` principal has a fixed id so audit and idempotency have a scope key without a new table.
11. **F-03.3: the corpus is generated, not checked in.** `packages/test-kit/src/file-corpus.ts` builds every case in memory — the EICAR string is assembled at runtime so no malware test sample sits on a developer's disk, and the archive cases need flags and declared sizes no editor would preserve. The planned `packages/test-kit/fixtures/files/` directory was not created.
12. **F-03.3: `retriesExhausted` carries the fail-closed decision.** The worker owns the retry budget (the outbox's `maxAttempts`); a `failed` verdict leaves versions processing while retries remain and quarantines them once spent, so nothing can sit releasable-but-unscanned or hang forever.
13. **F-03.3: the bucket is derived from `scan_state`**, not stored — `clean` files live in the clean bucket, everything else in quarantine — so promotion needed no schema change.
14. **F-03.4: refusal without disclosure.** A release attempt on a version the actor has no standing over answers `DOCUMENT_NOT_FOUND`, exactly as the download path does — the first implementation returned `NOT_AUTHORIZED`, which confirmed the existence of another organization's document to anyone guessing ids (caught by the negative suite). A wrong role *inside* one's own organization still returns `NOT_AUTHORIZED`, since existence is not a secret there.
15. **F-03.4: grant and revoke routes live in `download.controller.ts`** with the download route, rather than in a controller the plan did not name; all three are operations on one document version.
16. **F-03.4: shielding is enforced in the release policy.** Only internal document handlers may name a target organization; an external party can release to `internal` only. This is what keeps a customer from addressing a supplier (or the reverse) directly, and it makes onward release JobWork's deliberate act.
17. **F-03.4: `validUntil` must be in the future** — a grant created already-expired would confer nothing while reading as a live release.
18. **F-03.4: no `preview` action yet.** `access_log` supports it and grants can carry `view`, but only `download` is issued; sanitized preview artifacts are a derived-artifact concern that arrives with the preview pipeline, not with release.
19. **F-03.5: the page is `app/documents/page.tsx`, not `app/(shell)/documents/`** — no shell route group exists in either app yet (IN-02 put the audit explorer at `app/audit`). A shell arrives when the apps grow real navigation.
20. **F-03.5: `UPLOAD_POLICY` moved into `@jobwork/contracts`.** The accept list is a contract between the uploader and the API; keeping two copies would let the UI offer a file the server refuses. The API still enforces it — the move changed the source, not the authority.
21. **F-03.5: two API additions the plan did not list** — `GET /documents/uploads/:id`, without which "resume on refresh via upload_session" cannot be implemented, and `audiences` on manifest version rows, without which the manifest row cannot show audience state.
22. **F-03.5: `packages/ui` became a component package** (React peer dependency, `tsconfig`, exports); until now it shipped only `tokens.css`.
23. **F-03.5: the E2E is a live browser verification, not an automated suite.** The repo has no E2E harness yet and inventing one for a single page would outrun the plan; the flow was driven in real Chrome against the running stack and the states recorded above. An E2E harness belongs with the first multi-page flow (IN-05).
24. **F-03.5: the worker acknowledges events nothing subscribes to yet** (`dms.file_cleared`, `dms.file_quarantined`, `dms.audience_granted`, `dms.audience_revoked`). Unhandled types dead-letter by design, which would read as delivery failure and page someone; IN-10 replaces the acknowledgement with real delivery.
25. **F-03.5: the dev seed creates a customer member** (`buyer@demo.local`). The portal is an external surface and the internal admin is held to MFA before any transactional command, so the portal was otherwise unexercisable.
26. **F-03.5: the doc 21 governing flag is not rendered.** Nothing is governing until baselines exist (IN-09); the column arrives with them rather than as a permanently empty cell.


## Increment exit

- [x] Doc 13 §6 adversarial suite green, fail-closed everywhere (2026-09-05): 15-entry corpus each reaching its exact verdict, no unsafe entry able to return `clean`, and every failure path — digest mismatch, oversize, scanner timeout, scanner crash — ending quarantined rather than released.
- [x] Grant-before-scan impossible; the clean path takes an authorized user from upload to download with audit at every step (2026-09-05): release refuses anything not `available`+`clean` (`BR-ENG-08`), and one flow leaves `dms.upload_initiated` → `dms.upload_finalized` → `dms.scan_started` → `dms.scan_recorded` → `dms.audience_granted` → an `access_log` row, with the service actor distinguished from the user.
- [x] Roadmap foundation's "one scanned document flow" demonstrable in one sitting (2026-09-05): done in the browser end to end, clean and quarantined, including download and resume (F-03.5 above).

Totals at close: 94 automated tests (46 API, 30 worker, 16 database, 2 observability), build/typecheck/lint clean.
