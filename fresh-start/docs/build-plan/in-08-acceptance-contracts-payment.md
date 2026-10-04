# IN-08 — Acceptance, contracts, orders, payment boundary

Scope source: [Implementation plan](../24-implementation-plan.md) §4 IN-08; `FR-407`, `FR-501`–`FR-502`, `FR-801`–`FR-806` subset; doc 02 §8; doc 06 §12; doc 10 §§4–7.
Edge cases owned (doc 19 §7): browser success without callback; duplicated/delayed/out-of-order callback; unknown/short/combined transfer; overpayment; (doc 19 §4) accepted-as-it-expires race; approver limit routing.
Use cases: UC-05, UC-07, UC-16 (PO half), UC-30.

## F-08.1 Orders + finance migrations

| File | Action | Contents |
|---|---|---|
| `database/migrations/0009_orders_finance.sql` | new | `acceptance` (quote_version ref, hash, actor/authority snapshot, idempotency), `contract_snapshot`, `sales_order`, `purchase_order` (+acknowledgment), `order_line`, `payment_intent`/`payment_transaction` (provider tx unique per provider/account)/`payment_allocation`, `invoice`/`invoice_version`/`invoice_line`, `credit_profile`/`credit_hold`, `ledger_account`/`journal`/`journal_line` (balanced-by-currency check constraint + cost-object ref), installment schedule tables |
| `database/tests/finance-constraints.db.spec.ts` | new | Journal imbalance rejected; duplicate provider tx rejected; one acceptance per offer-set enforced under concurrency |

## F-08.2 Accept-quote transaction

Covers: doc 02 §8 recipe verbatim; `FR-407`; `BR-COM-09`.

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/commercial/application/accept-quote.command.ts` | new | The 11-step transaction: idempotency → state/validity/version checks → hash+terms acknowledgment match → authority/limit check → acceptance evidence → transition → sales-order + contract snapshot → audit + outbox → commit |
| `apps/api/test/accept-race.db.spec.ts` | new | Concurrent accept vs expire vs supersede: exactly one winner; loser gets stable `QUOTE_SUPERSEDED`/`QUOTE_EXPIRED`; retry with same idempotency key returns original result |
| `apps/portal-web/app/(customer)/quotations/[id]/accept/*` | new | ApprovalPanel with quote hash display, terms acknowledgment, idempotent submit button |

Edge: approver limit too low → approval routing (delegation path recorded), no partial acceptance.

## F-08.3 Purchase order issuance and acknowledgment

Covers: `FR-502` (references exact bid version + baseline — minimal baseline arrives IN-09; PO created `pending_baseline` and cannot release work), UC-16 half.

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/orders/application/{issue-po,acknowledge-po}.command.ts` | new | Buy-side snapshot from award/bid version; supplier acknowledgment with terms |
| `apps/portal-web/app/(supplier)/purchase-orders/*` | new | PO list/detail/acknowledge |

Tests: PO immutable after issue; acknowledgment recorded with actor/time; sell-side fields absent from supplier PO payload.

## F-08.4 Payment intents and provider port

Covers: doc 10 §7; `T-03` behind port (dev adapter: simulated gateway with signed webhooks; Razorpay/Cashfree adapter slot documented for inception).

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/finance/application/create-payment-intent.command.ts` | new | Server-side amount from authoritative installment balance (never client amount) |
| `apps/api/src/modules/finance/infrastructure/gateway.port.ts` + `dev-gateway.adapter.ts` | new | Create/intent, verify signature, refund stub |
| `apps/portal-web/app/(customer)/invoices-payments/*` | new | Installments, pay action, "verifying payment" state (browser return ≠ truth) |

## F-08.5 Webhook ingestion and reconciliation

Covers: doc 08 §11 seven steps; `BR-FIN-05`; edge cases §7 list.

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/finance/presentation/webhook.controller.ts` | new | Raw-body capture, signature+timestamp verify, provider delivery-id claim, fast ack |
| `apps/api/src/modules/finance/application/record-gateway-event.command.ts` | new | Idempotent named command → payment_transaction + balanced journal (capture) + allocation |
| `apps/worker/src/outbox/handlers/payment-reconcile.ts` | new | Scheduled provider-truth comparison; ambiguous → suspense queue |
| `apps/operations-web/app/(shell)/finance/reconciliation/page.tsx` | new | Suspense/unapplied cash, maker-checker manual match (second approver) |

Tests: duplicate webhook posts once; out-of-order capture-then-authorize reconciles; unknown transfer lands in suspense (edge); overpayment → unapplied credit, no wallet (edge); browser-success-no-callback stays pending (edge).

## F-08.6 Invoice boundary and credit profile

Covers: `FR-804` immutability; `T-04` posture (numbering/tax fields via versioned config stub, provider slot documented); doc 10 §4 credit gate.

| File | Action | Contents |
|---|---|---|
| `apps/api/src/modules/finance/application/{issue-invoice,record-credit-decision,place-credit-hold}.command.ts` | new | Immutable issue with content hash; credit_profile limit/exposure computation; commercial-release gate input |
| `apps/portal-web/app/(customer)/invoices-payments/invoices/*` | new | Immutable invoice PDFs (hash-linked) |

Tests: issued invoice cannot mutate (correction = credit note path stubbed for Phase 2); commercial release gate red when advance installment unpaid or credit hold present.

## Build notes (2026-10-01)

Design decisions taken at build time (recorded here as the plan edits the protocol requires):

- Migration is `0013_orders_finance.sql` (0009 was taken); schemas `orders` and `finance`, with `acceptance`/`contract_snapshot` in `commercial` as doc 05 §4 lists them. A balanced journal is a **deferred constraint trigger** (`trg_journal_balanced`): the whole command rolls back on an imbalance; journals and lines are insert-only.
- The quotation carries a structured schedule from here on: `advance_bp` and `balance_trigger` on `quote_version` (frozen with the rest; defaults 50 % advance, balance before dispatch). Instalments are derived from them at acceptance; the advance is invoiced in the acceptance transaction, the balance when its trigger is met (IN-17 dispatch; until then an operations command may issue it).
- Acceptance authority (`D-07`): the actor must hold `customer_approver`; if an `iam.approval_limit` of type `quote_acceptance` exists for the membership and the total exceeds it, acceptance is refused with `APPROVAL_LIMIT_EXCEEDED` and the routing hint; with no limit row an approver is unlimited (launch policy, documented).
- Payment provider (`T-03`) stays behind `PaymentGateway` (createIntent, verifyWebhook). The dev adapter is a simulated gateway inside the API: the checkout page is a portal route that asks the API to **synthesize a signed webhook** and dispatch it through the real ingestion path, so the same code handles signature checks, delivery-id claims, idempotent posting and allocation in dev and in tests. A Razorpay/Cashfree adapter is a second implementation of the same port.
- Manual cash allocation reuses the IN-07 approval rail with a new kind `allocation` (finance maker-checker).
- Customer order status words follow doc 06 §13; the IN-08 curated timeline carries the commercial lane (accepted → advance invoiced → paid → technical confirmation) and IN-09 adds the production lanes.

## Build notes (2026-10-04) — as built

| Plan item | Built as | Deviation / reason |
|---|---|---|
| F-08.1 | `0013_orders_finance.sql`; `database/tests/finance-constraints.db.spec.ts` (5 tests) | `invoice_version` not created: an issued invoice is one frozen row (trigger `trg_invoice_immutable`); a correction is a credit note (Phase 2), so there is no second version to hold. Installments, credit, intents, transactions, allocations, unapplied credit and webhook receipts are separate tables. |
| F-08.2 | `apps/api/src/modules/orders/application/accept-quote.command.ts`; portal `quotations/[id]/accept` | Lives in the new `orders` module, not `commercial`: it writes orders and finance rows, and commercial must not depend on them. Acceptance **serializes on the offer set** (`SELECT … FOR UPDATE`) before locking the quote, so two options accepted at once queue instead of deadlocking; the partial unique index stays as the backstop. Over-limit acceptance is refused with `APPROVAL_LIMIT_EXCEEDED` naming the routing (ask an approver with a higher limit); a recorded customer-side delegation request arrives with team approvals. The race test is in `apps/api/test/orders-payments.api.spec.ts`, not a separate `accept-race.db.spec.ts`. |
| F-08.3 | `OrderCommand.issuePurchaseOrders` / `acknowledge`; portal `supplier/orders/*`; ops `sales-orders/[id]` | Issuance is a named sourcing command after acceptance (not inside it), matching doc 02 §8 which lists only sales order + snapshot. One PO per awarded supplier, lines and bid-version ids frozen (`trg_purchase_order_immutable`, `trg_purchase_order_line_immutable`), born `pending_baseline`. |
| F-08.4 | `infrastructure/gateway.ts` (`PaymentGateway` port, `DevGateway`); `PaymentCommand.createIntent`; portal `invoices/*`, `pay/[intentId]` | `finance` lives inside the `orders` module for now (one module, two repositories); split when supplier settlement (IN-16) gives finance its own commands. The dev checkout posts a **signed** callback through the real ingestion path; the browser never marks anything paid. |
| F-08.5 | `PaymentWebhookController` (`@Public`, raw body), `PaymentCommand.ingestWebhook`; worker `payment-reconcile.ts` + `POST /internal/payments/reconcile-sweep`; ops `finance` | Signature is HMAC over `timestamp.body` with a 300 s tolerance; a rejected delivery is recorded under its own key so a forgery cannot pre-claim a genuine delivery id. The worker sweep expires unpaid intents; provider-truth queries are the real adapter's job (`T-03`). Manual allocation is a maker-checker request on the IN-07 approval rail (kind `allocation`), applied by an effect registered into commercial's `ApprovalEffectRegistry`. |
| F-08.6 | `MoneyFlow.issueInstallmentInvoice`, `MoneyFlow.gate`; credit commands on `OrderCommand`; ops credit panel | Invoice numbering `INV-YYYY-NNNN` under an advisory lock; statutory particulars (GSTIN, HSN/SAC, IRN) are printed as "confirmed by finance before dispatch" until the tax-provider decision (`T-04`). Revenue is credited at invoice per doc 10 §6's conceptual table; advance-liability treatment is an accounting decision. |
| — | Quotation validity | Found by a test that failed between 00:00 and 05:30 IST: "valid until D" now ends at the end of D in India time (`Asia/Kolkata`), in both `isExpired` and the expiry sweep's SQL. Previously it ended at end of D UTC, 5½ hours late. |
| — | Worker | Every event type the API emits is now registered (IN-02…IN-08 types acknowledged until the notification increment); before this the IN-07 commercial events dead-lettered. |

## Increment exit

- [x] Doc 19 §10 scenarios 4 and 9 green (acceptance race; duplicate delayed webhook) — `orders-payments.api.spec.ts`: "lets exactly one of two options accepted at the same moment win"; replayed delivery, same transaction under a new delivery id, stale timestamp and out-of-order `authorized` all post nothing (2026-10-04).
- [x] Accept → sales order + contract snapshot + PO chain complete with hashes; commercial release gate computes from real records — acceptance evidence + contract hash + advance invoice in one transaction; two POs (60/40 split) with content hashes; gate reads installments, invoices, receivables, credit profile and holds; release on advance paid and on credit covered both tested.
- [x] Every posted journal balances; suspense workflow demonstrated — deferred balance trigger (DB test) and a whole-ledger imbalance query after every money test; unknown capture → suspense → proposal → self-approval refused → second finance user approves → invoice paid and order released.
- [x] Full verification (2026-10-04): `pnpm -r build` ok; `pnpm typecheck` ok; `npx eslint .` clean; tests api 163, database 54, ui 127, worker 30, observability 2.
- [x] Browser walkthrough on the dev database (2026-10-04): customer at 390 px — quotation → accept → order "Payment needed" → dev checkout → paid → order "Technical confirmation", orders/invoices/payments/home; sourcing issues both POs in operations; supplier acknowledges its PO at 390 px; finance views sales orders, the order's gate/instalments/POs/evidence/credit and the reconciliation page at 1280 px. No page errors; zero unbalanced journals. The walkthrough found and fixed: money rendered without its currency symbol everywhere (`formatMoney` now follows doc 21's "₹12,34,567.00"), the timeline calling an unpaid step "Advance received" (now "Advance payment"), and the checkout showing the internal intent status.
