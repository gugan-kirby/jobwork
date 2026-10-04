# Security, privacy, and threat model

## 1. Security objective

Protect engineering IP, supplier network identity, customer identity, commercial margin, quality evidence, financial data, and transaction authority while preserving complete, attributable operations. The strongest product-specific threat is unauthorized information flow between customer and supplier, including indirect leakage through files and logistics.

Use a recognized application-security verification baseline such as OWASP ASVS, with threat modeling and controls tailored to this domain. Formal compliance scope is an open business decision.

## 2. Sensitive assets

- CAD, drawings, BOMs, specifications, process know-how, prototypes, and customer application.
- Supplier legal identity, capabilities, price, capacity, contacts, factory/location, bank and tax data.
- Customer identity, contacts, delivery location, sell price, payment/credit data.
- JobWork margin, sourcing strategy, negotiation, risk and internal notes.
- Credentials, sessions, MFA recovery, signing/encryption keys, provider secrets.
- Approvals, audit evidence, quality measurements, deviations, release and shipment documents.
- Personal data of users, inspectors, drivers, and recipients.

## 3. Threat actors

- unauthenticated attacker/bot;
- compromised customer or supplier account;
- curious/malicious user from another organization;
- supplier/customer attempting to bypass JobWork;
- over-privileged or malicious internal employee;
- compromised support/admin account;
- malicious file uploader;
- compromised third-party integration/provider;
- accidental operator/developer error;
- supply-chain/dependency attacker.

## 4. Threat table

| Threat | Example | Primary controls |
|---|---|---|
| Broken object authorization | Supplier fetches another supplier's bid by ID | Relationship-scoped queries, deny default, negative tests, opaque IDs only as defense-in-depth |
| Identity leakage | Customer sees supplier name in PDF metadata/POD | Sanitization, audience-specific derived artifacts, logistics label policy, output allowlists |
| Margin leakage | Internal cost field serialized in customer quote | Separate DTO/projection, schema allowlist, snapshot/DLP tests |
| Account takeover | Phished internal finance session | MFA, risk/session management, short elevation, alerts, approval separation |
| Malicious upload | CAD/ZIP/PDF exploits parser or stores malware | Quarantine, allowlist/content validation, isolated scanner/converter, private serving |
| Tampered approval/evidence | Actor denies accepted quote or measurement changes | Immutable versions/hashes, authority snapshot, append-only audit, signed generated artifacts where appropriate |
| Duplicate/replay | Payment webhook replay posts twice | Signature/timestamp, provider-ID uniqueness, idempotent command/ledger |
| Injection/SSRF | Search/template/preview requests execute attacker input | Parameterization, validation, sandbox/no-network processing, egress restrictions |
| Insider export | Large CAD/bid download by staff | Least privilege, JIT access, watermark/reason, rate/anomaly alert, review |
| Notification leak | Internal note appears in WhatsApp/email | Audience-safe templates, minimal event payload, pre-send policy, tests |
| Availability attack | Huge archive or message burst exhausts workers | Size/decompression/time limits, quotas, isolation, backpressure, rate limits |
| Supply-chain compromise | Dependency/build artifact altered | Lockfiles, provenance, scanning, minimal images, protected CI, signed artifacts |

## 5. Authentication and sessions

- OIDC-ready identity; verified email/phone according to account type.
- MFA mandatory for internal/admin/finance/quality release; configurable customer/supplier policy.
- Enterprise SSO/SCIM later for larger organizations.
- Secure, HttpOnly, SameSite cookies for web sessions where chosen; CSRF protection for state changes.
- Session inventory, device metadata, rotation, idle/absolute lifetime, logout-all, and immediate revoke.
- Recovery and factor reset are high-risk audited workflows with step-up verification.
- No account enumeration in login/reset responses.
- Service identities use workload identity/short-lived credentials, not shared user API keys.

## 6. Authorization

- Central policy layer plus domain-specific guards.
- Deny by default; role + relationship + attribute + state + approval limit.
- Query scoping prevents unauthorized rows entering application memory.
- Signed file URL issued only after current authorization; shortest practical TTL.
- Delegation and break-glass are time/scope limited and alerted.
- Permission/config changes are versioned, reviewed, and tested.
- Periodic access review for internal high-risk roles and inactive external memberships.

## 7. Tenant isolation

- Organization context is derived from authenticated membership, never trusted solely from request body/header.
- Repository methods require organization/relationship scope explicitly.
- Foreign keys/ownership constraints prevent orphan/cross-tenant relationships.
- Optional PostgreSQL RLS defense-in-depth only with safe connection context.
- Cache/search keys include tenant/audience and never broaden authorization.
- Automated test suite mutates IDs, nested resources, exports, files, webhooks, and real-time channels across tenants.

## 8. File and content security

- Upload directly to quarantine prefix/bucket with short-lived single-purpose grant.
- Verify expected object key, size, checksum, signature/type, count, and archive expansion.
- Isolated parsers/converters, patched and resource-limited, with no credentials and no network by default.
- Original download is attachment from separate origin/domain; safe previews are derived artifacts.
- Scan result is versioned and revocable if threat intelligence changes.
- Strip macros/scripts/metadata where producing a release copy; never mutate original evidence.
- Prevent path traversal, overwrite, public ACL, executable content, MIME sniffing, and cross-tenant dedupe leaks.

## 9. Contact and identity shielding

Inspect:

- message text and structured profile fields;
- filenames, Office/PDF properties, CAD title blocks where supported, ZIP manifests;
- image EXIF, visible text, QR/barcodes;
- email signatures, URLs/social handles;
- generated quote/invoice/PO/label/POD templates;
- carrier tracking portals and notification content.

Actions are policy-driven: allow, warn, block, redact-derived-copy, or human review. Preserve engineering integrity and minimize false positives. Intentional disclosure requires an explicit approval/audit path.

## 10. Application controls

- Strict input schemas, output encoding, parameterized SQL, safe template rendering.
- CSP, frame protection, HSTS, secure headers, CORS allowlist, CSRF/session protections.
- Rate limits/quotas by operation and actor; bot/abuse controls at edge and application.
- No sensitive data in URL query, analytics events, error messages, logs, or client storage.
- Secrets only in managed store; rotation, separation by environment/provider, no source control.
- Dependency/SAST/secret/container/IaC scans plus patch SLA.
- Privileged changes require protected CI/CD, review, immutable artifacts, environment approval, and deployment audit.

## 11. Encryption and keys

- TLS for all external/internal transport.
- Managed encryption at rest for database, storage, backups, queue, and logs.
- Separate environment/account keys; least-privileged key use and rotation.
- Field-level encryption/tokenization for selected bank/tax/identity fields after data-classification review.
- Passwords, if locally managed, use a modern adaptive password hash and strong reset flow.
- Hashes for file/content integrity are not a replacement for encryption or signatures.

## 12. Audit and non-repudiation

Critical audit actions include authentication/security changes, membership/permission, sensitive view/download/export, bid/quote versions, approvals, baseline/transmittal, change/deviation, quality release, invoice/payment/refund/settlement, shipment release, overrides, and configuration/deployment.

Audit is append-only with restricted write path, synchronized time, actor/session/organization/correlation, subject version/hash, reason, and safe outcome. Access to audit is itself audited. Retention and cryptographic sealing/export signing depend on legal requirements.

## 13. Privacy and data governance

- Inventory fields by purpose, controller/processor role, sensitivity, region, retention, and subprocessor.
- Collect minimum personal/contact/location data.
- Separate operational necessity from marketing consent/preferences.
- Provide controlled access/correction/export/deletion workflows subject to contract/legal retention.
- Do not train models or send CAD/messages to AI providers without explicit approved purpose, contract, retention, and data boundary.
- Mask/synthesize production data in non-production; never copy raw production DB/files casually.
- Define data-residency and cross-border transfer requirements before selecting regions/providers.

## 14. Logging safety

Structured logs contain timestamp, severity, service/module, environment, correlation/trace ID, safe actor/organization pseudonymous IDs, operation, outcome, duration, and error code. They exclude tokens, cookies, authorization headers, passwords, signed URLs, bank details, raw provider payloads, full messages, CAD/file content, and sensitive quote fields.

Redaction is tested. Debug logging cannot be enabled globally in production without controlled expiry.

## 15. Incident readiness

Runbooks cover account compromise, cross-tenant leak, malicious file, payment anomaly, provider-key exposure, mass download, ransomware/data corruption, lost shipment data, and unavailable DB/object storage. Each defines containment, session/key revocation, evidence preservation, impact assessment, notification/legal escalation, recovery, and post-incident correction.

## 16. Security release gates

Before production:

- threat model reviewed for each major workflow;
- authorization matrix and cross-tenant negative suite passing;
- high/critical findings resolved or formally risk-accepted;
- upload/preview isolation verified with adversarial corpus;
- MFA and privileged access operational;
- secrets/deploy/backups/restores tested;
- audit coverage verified for all critical commands;
- incident contacts and runbooks exercised;
- external penetration test before material transaction volume;
- privacy, contract, payment, tax, and retention decisions approved by responsible professionals.
