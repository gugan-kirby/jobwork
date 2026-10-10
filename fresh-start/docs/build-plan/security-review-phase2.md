# Phase 2 security review (TP.6)

Review of the IN-13–IN-18 build against doc 11 §16, the security release gates, dated 2026-10-10. It follows the [Phase 1 review](security-review-phase1.md) and covers what Phase 2 added: engineering change, quality plans, inspections, NCR and deviation, quality release, both logistics legs, delivery and acceptance, supplier bills and settlement, support cases and remedies, and margin. This is the engineering team's own review, not an independent assessment. The external penetration test (gate 9) is that.

**Method.**
- **Source audit.** The change, quality, logistics, support and settlement modules were read for authorization, leakage, injection, audit placement and concurrency. Every finding was then checked against the code by hand before it was fixed or recorded.
- **Probes.** `cross-tenant-matrix.api.spec.ts` gained 25 Phase 2 reads and 10 Phase 2 commands. Each read is refused to every party it does not belong to. Each command is refused to every external party, and the matrix asserts that a refused command writes nothing.
- **Pilots.** The TP pilots (scenarios 11 and 12, `phase2-exit`) were run end to end with their leak checks.

## 1. Release gates (doc 11 §16)

| # | Gate | Status | Evidence | Closes with |
|---|---|---|---|---|
| 1 | Threat model reviewed for each major workflow | Done for Phase 2 | §2 below | Re-review per new workflow in Phase 3 |
| 2 | Authorization matrix and cross-tenant negative suite passing | Passing | The matrix with its Phase 2 probes. `@InternalOnly()` refuses every non-JobWork session on JobWork's own routes before the handler runs (finding 3). Plus `pilot/scenario-12`, `cases`, `settlement`, `margin` and the leak suites in `customer-dispatch` and `customer-deliveries` | — |
| 3 | High/critical findings resolved or formally risk-accepted | No high or critical found; the mediums found are fixed | §3 | Owner reviews findings 9–12 |
| 4 | Upload/preview isolation verified with adversarial corpus | Unchanged from Phase 1. Case evidence, bill documents and receiving photos go through the same quarantine and scan; a case accepts only the opener's own clean files (`EVIDENCE_UNAVAILABLE`) | Phase 1 evidence; `cases.api.spec.ts`, `delivery.api.spec.ts` | Re-run when a preview pipeline exists |
| 5 | MFA and privileged access operational | MFA: operational. Separation of duties extended to Phase 2 | Every Phase 2 internal command requires a password+TOTP session. Separation of duties: bill exceptions are approved by a second finance member; a case action is verified by someone other than its doer (`VERIFIER_SEPARATION`); an NCR's corrective action is reviewed by JobWork quality; a dispatch override is decided by the hold's owner and never the requester (`APPROVAL_SEPARATION`) | Phase 1 finding 7 (just-in-time elevation) stays open |
| 6 | Secrets, deploy, backups and restores tested | Restore drill rerun | [drills-2026-10-10.md](evidence/drills-2026-10-10.md) | T-01 for point-in-time recovery |
| 7 | Audit coverage verified for all critical commands | Verified | `audit-coverage.spec.ts`; the reviewed inventory (`test/__snapshots__/audit-inventory.txt`) lists every Phase 2 executor command. The source audit found no state change outside the executor transaction: approval effects run in the approval rail's transaction, and `OrderClosure`, `CustomerRemedy` and `CaseLogistics` run in their caller's | — |
| 8 | Incident contacts and runbooks exercised | Unchanged from Phase 1 | — | Owner names contacts (Phase 1 finding 12) |
| 9 | External penetration test before material transaction volume | Not started | — | Owner, before real money |
| 10 | Privacy, contract, payment, tax and retention decisions approved by professionals | Not started. Phase 2 adds the e-way bill threshold, credit notes and the acceptance window to the list | IN-17 and IN-18 owner items | Owner |

## 2. Threat model per Phase 2 workflow

Threat names are doc 11 §4's rows.

| Workflow | Threats that apply | Controls in place | Evidence | Residual |
|---|---|---|---|---|
| Engineering change | Identity leakage; tampered baseline; change without approval | The supplier gets JobWork's brief, never the customer's words. A baseline is released only in a change's name (`BASELINE_CHANGE_REQUIRED`). The customer decides on price and date within its approval limit, with `expectedVersion`. The PO is amended by an appended, acknowledged amendment, never rewritten | `change.api.spec.ts`, `pilot/scenario-06`, `phase2-exit` | Finding 9 |
| Quality plan, inspection, NCR, deviation | Tampered evidence; identity leakage; release of nonconforming goods | Results are immutable and corrections supersede them. A plan written against a superseded baseline cannot plan an inspection (`PLAN_BASELINE_STALE`). A rework is judged only by a new inspection. An open NCR holds release and settlement. A deviation's customer view now carries JobWork markings only (finding 4) | `quality`, `ncr`, `deviation`, `quality-release` specs; pilots 7 and 8 | — |
| Logistics, both legs | Identity leakage; quantity fraud; tampered documents | The customer sees `JW-` markings, never supplier lot codes. The identity guard catches a supplier name on an item. Leg-2 labels and notes are checked for supplier name, lot codes, PO number and city. The stock ledger conserves every piece. A carrier event never receives or accepts anything. POD and acceptance are distinct (`BR-LOG-05`) | `customer-dispatch`, `delivery`, `customer-deliveries`, `receiving`; pilots 10 and 11 | — |
| Supplier bill and settlement | Duplicate billing; over-billing; paying a held supplier | One bill per supplier reference. A three-way match against the committed PO (now including acknowledged amendments, finding 2) and the accepted quantity. An exception goes to a second finance member. Eligibility is read from facts at schedule and at payment. A paid settlement is final by trigger | `settlement.api.spec.ts`, `settlement-support.db.spec.ts`, `phase2-exit` | — |
| Support cases and remedies | Identity and cost leakage; remedy fraud; a case on someone else's order | The customer's view is built field by field: no supplier, PO, recovery or internal note. A case names only its own order's PO and its own order's delivery (finding 5). Remedies go through the approval rail and are executed by their owning role. Each is verified by someone else. Actions are forward-only by trigger (D4). A credit note never exceeds what the invoice can still take | `cases.api.spec.ts`, `pilot/scenario-11` | Finding 10 |
| Margin | Margin leakage | JobWork finance and sales only, on an `@InternalOnly()` controller; platform administrators are refused | `margin.api.spec.ts`, matrix | — |
| All Phase 2 | Injection/SSRF | Every `${}` in Phase 2 SQL is a constant fragment: column lists, `FOR UPDATE`, typed table unions, ledger location constants, a clamped `LIMIT`, and mapped update keys. All values are bound parameters | Source audit, 2026-10-10 | — |
| Carrier webhook | Forged event | HMAC with a timestamp window, rate limited; the acceptance sweep is service-only | `delivery.api.spec.ts`, pilot 10 | Re-verify with a real carrier (T-05) |

## 3. Findings

Severity is the impact if exploited in production. "Fixed" means the fix is merged with a regression test.

| # | Severity | Finding | Status |
|---|---|---|---|
| 1 | Medium | A customer posting to JobWork's case-center route `POST /cases` got 403, but the case was already written and audited: the shared command let the customer through, and only the internal read-back refused. The customer gained nothing it could not do on its own route, but it was told "refused" for a change that happened, and a retry opened duplicates. Found by the matrix's "refused commands write nothing" check (D11) | Fixed: `@InternalOnly()` |
| 2 | Medium (integrity) | The three-way match read the PO's issued total only. A change that raised the supplier's cost appends an acknowledged amendment instead of rewriting the PO, so a supplier billing the amended amount failed the match. Deltas within the 1 % tolerance passed by accident (D10) | Fixed: the match commits the PO total plus acknowledged amendments. `phase2-exit` bills a delta above the tolerance |
| 3 | Medium | JobWork-only routes shared their application method with the supplier route and answered suppliers with their own records: `/supplier-bills` (D6), `/ncrs` (D12), `/shipments` (read, pickup, cancel), `/inspections` and `/ncrs/:id/containment`. Nothing leaked, since each answer was the supplier's own projection, but an internal route must refuse anyone outside JobWork | Fixed: `@InternalOnly()` (`platform/http/public.decorator.ts`), enforced by the session guard and applied to every JobWork-only controller. `/quality-units` stays shared because the portal reads it |
| 4 | Medium | The customer's deviation view returned the workshop's own lot codes (`LOT-A`), against the rule IN-17 set: customers see JobWork's `JW-` markings only. The IN-15 specs asserted the raw codes (D13) | Fixed: markings of the stock lots JobWork holds, and none before receiving. `deviation.api.spec.ts` checks the code is absent |
| 5 | Low | A case accepted any shipment id, including a supplier's leg-1 shipment or another order's delivery, and showed its number to the customer. A return or rework could name a PO of a different order (staff only) | Fixed: a case names only a leg-2 delivery of its own order (`SHIPMENT_NOT_FOUND`), and a return or rework only a PO of the case's order. `cases.api.spec.ts` |
| 6 | Low | The ops case page offered cancel while a proposal waited for approval, and close while actions were unverified (D7, D8) | Fixed in TP.5 |
| 7 | Low (bug) | `schedule` and `markPaid` wrote a "held" settlement and then refused, so the write was always rolled back | Fixed: the dead writes are gone; `recheck` records a hold |
| 8 | Low | The operations navigation ran off-screen at 1280, so Approvals, Audit and Account could not be reached (D9) | Fixed in TP.5 |
| 9 | Medium (product) | A customer sees the title and reason of every change on its orders from `proposed` on, including changes JobWork or a supplier raised, and changes opened by a new document revision, whose title names the document. Staff write those texts for an internal audience | Owner: decide whether customers see changes they did not propose before JobWork prices them. Until then, staff write change titles and reasons as customer-readable |
| 10 | Low | Free text staff type into a case's actions (return, rework descriptions), close and reject notes reaches the customer by design. A supplier name typed there would leak | Accepted as designed; staff guidance. The contact-leakage detector covers messages, not case text |
| 11 | Low | `/instruments` is an alias of `/supplier/instruments` on one handler, so the internal path answers a supplier with its own instruments | Accepted: same projection on both paths. Split when the internal instrument screen gains internal-only fields |
| 12 | Low | Some mutations run under a row lock and a status guard instead of `expectedVersion`: case execute, verify and cancel; supplier change impact and acknowledgment; the delivery issue report. Some reads check organization but not role (`SettlementCommand.get` on the supplier route; change withdraw and provide-info accept any customer member). Settlement eligibility reasons show a holding case's number to the supplier | Recorded. None is exploitable across parties; each is a candidate for the Phase 3 hardening pass |

Phase 1 findings 6, 7 and 9–13 stay open with the owner.

## 4. Verdict

No high or critical finding is open in the code, and every medium found is fixed with a regression test except finding 9, which is a product decision. Phase 2 may run its pilot on non-production infrastructure with test money. Before real customers, real money or real drawings:
- the owner closes or formally accepts finding 9 and Phase 1 findings 6, 7 and 9–13;
- the external penetration test (gate 9) covers the Phase 2 surfaces listed in §2.
