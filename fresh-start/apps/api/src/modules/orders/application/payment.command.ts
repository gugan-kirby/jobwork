import { randomUUID } from 'node:crypto';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type {
  CustomerInvoice,
  CustomerPaymentIntent,
  CustomerPayments,
  PaymentTransaction,
  ProposeAllocationRequest,
  ReconciliationQueue,
  RecordBankTransferRequest,
  SimulatePaymentRequest,
} from '@jobwork/contracts';
import { ApprovalEffectRegistry, CommercialRepository, PolicyRulesInvalid, type ApprovalEffectInput } from '../../commercial';
import { type Actor, requireOrganization, requireRole, requireTransactionalStrength } from '../../iam';
import { NotAuthorized } from '../../iam/domain/errors';
import {
  AllocationInvalid,
  InvoiceNotFound,
  InvoiceNotPayable,
  PaymentIntentNotFound,
  PaymentIntentNotOpen,
  SimulationUnavailable,
  TransactionNotFound,
  WebhookRejected,
} from '../domain/errors';
import { FinanceRepository, type InvoiceRecord } from '../infrastructure/finance.repository';
import { DevGateway, PaymentGateway } from '../infrastructure/gateway';
import { MoneyFlow, sha256 } from './money-flow';
import { OrdersView } from './orders-view';
import { contextFromActor, contextFromService, type AuditSpec, type CommandOutcome, type OutboxSpec } from '../../../platform/commands/command';
import { AuditWriter } from '../../../platform/commands/audit.writer';
import { OutboxWriter } from '../../../platform/commands/outbox.writer';
import { CommandExecutor } from '../../../platform/commands/execute';
import { ConfigService } from '../../../platform/config/config.service';
import { DatabaseService } from '../../../platform/database/database.service';
import { DomainError } from '../../../platform/http/domain-error';

/** The principal provider callbacks are recorded as: a system boundary, not a user (doc 20 §9). */
export const PAYMENT_GATEWAY_PRINCIPAL = { name: 'payment-gateway', id: '00000000-0000-4000-8000-000000000002' };

const PAYABLE = new Set(['issued', 'partially_paid']);
const OPEN_INTENT = new Set(['created', 'pending_customer', 'authorized']);
const CUSTOMER_PAYER_ROLES = ['customer_requester', 'customer_approver', 'org_admin'];

type Opts = { idempotencyKey?: string | undefined };

export interface WebhookOutcome {
  outcome: 'processed' | 'duplicate' | 'suspense' | 'ignored';
  transactionId: string | null;
}

/**
 * The payment boundary (doc 06 §12, doc 08 §11, doc 10 §7, `FR-803`).
 *
 * - An intent is made server-side from the invoice's open balance; the browser never
 *   names an amount.
 * - The browser's return is UX only. Money becomes truth when a *verified* provider
 *   callback is ingested: signature checked over the raw bytes, delivery claimed once,
 *   provider transaction id unique, a balanced journal posted, the invoice updated — in
 *   one transaction with audit and outbox.
 * - Money that cannot be tied to an intent goes to suspense, and leaves suspense only by
 *   a finance allocation that a second finance user approves (maker-checker).
 */
@Injectable()
export class PaymentCommand implements OnModuleInit {
  constructor(
    private readonly finance: FinanceRepository,
    private readonly commercial: CommercialRepository,
    private readonly money: MoneyFlow,
    private readonly view: OrdersView,
    private readonly gateway: PaymentGateway,
    private readonly executor: CommandExecutor,
    private readonly db: DatabaseService,
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxWriter,
    private readonly config: ConfigService,
    private readonly effects: ApprovalEffectRegistry,
  ) {}

  onModuleInit(): void {
    this.effects.register('allocation', (input, tx) => this.applyApprovedAllocation(input, tx));
  }

  // ----------------------------------------------------------------- customer

  private requireCustomer(actor: Actor): string {
    if (actor.organizationType !== 'customer') throw new NotAuthorized('Customer organizations only');
    requireRole(actor, ...CUSTOMER_PAYER_ROLES);
    return requireOrganization(actor);
  }

  async customerInvoices(actor: Actor): Promise<CustomerInvoice[]> {
    const organizationId = this.requireCustomer(actor);
    const rows = await this.finance.listInvoicesForCustomer(organizationId);
    return Promise.all(rows.map((row) => this.view.customerInvoice(row)));
  }

  async ownedInvoice(actor: Actor, invoiceId: string): Promise<InvoiceRecord> {
    const organizationId = this.requireCustomer(actor);
    const invoice = await this.finance.findInvoice(invoiceId);
    if (!invoice || invoice.customerOrganizationId !== organizationId) throw new InvoiceNotFound();
    return invoice;
  }

  async customerInvoice(actor: Actor, invoiceId: string): Promise<CustomerInvoice> {
    return this.view.customerInvoice(await this.ownedInvoice(actor, invoiceId));
  }

  /** Pay an invoice: an intent for exactly its open balance, reused while one is still open. */
  async createIntent(actor: Actor, invoiceId: string, opts: Opts = {}): Promise<CustomerPaymentIntent> {
    const organizationId = this.requireCustomer(actor);
    const intentId = await this.executor.execute(
      {
        operation: 'finance.create-payment-intent',
        handler: async (tx) => {
          const invoice = await this.finance.findInvoice(invoiceId, tx, true);
          if (!invoice || invoice.customerOrganizationId !== organizationId) throw new InvoiceNotFound();
          if (!PAYABLE.has(invoice.status)) throw new InvoiceNotPayable(invoice.status);
          const amountMinor = invoice.totalMinor - invoice.paidMinor;
          const now = new Date();
          for (const existing of await this.finance.listIntentsForInvoice(invoiceId, tx)) {
            if (!OPEN_INTENT.has(existing.status)) continue;
            if (existing.expiresAt.getTime() <= now.getTime()) {
              await this.finance.setIntentStatus({ intentId: existing.id, status: 'expired' }, tx);
            } else if (existing.amountMinor === amountMinor) {
              return { result: existing.id, audit: [] };
            } else {
              await this.finance.setIntentStatus({ intentId: existing.id, status: 'cancelled' }, tx);
            }
          }
          const id = randomUUID();
          const expiresAt = new Date(now.getTime() + this.config.env.PAYMENT_INTENT_TTL_MINUTES * 60_000);
          const made = await this.gateway.createIntent({ intentId: id, amountMinor, currency: invoice.currency, invoiceNumber: invoice.number, customerName: invoice.customerDisplayName, expiresAt });
          await this.finance.createIntent(
            {
              id,
              invoiceId,
              salesOrderId: invoice.salesOrderId,
              customerOrganizationId: organizationId,
              amountMinor,
              currency: invoice.currency,
              provider: this.gateway.provider,
              providerIntentId: made.providerIntentId,
              checkoutUrl: made.checkoutUrl,
              createdBy: actor.userId,
              expiresAt,
            },
            tx,
          );
          return {
            result: id,
            audit: [{ action: 'finance.payment_intent_created', subjectType: 'invoice', subjectId: invoiceId, data: { paymentIntentId: id, amountMinor, provider: this.gateway.provider } }],
          };
        },
      },
      contextFromActor(actor),
      { invoiceId },
      opts,
    );
    return this.customerIntent(actor, intentId);
  }

  async customerIntent(actor: Actor, intentId: string): Promise<CustomerPaymentIntent> {
    const organizationId = this.requireCustomer(actor);
    const intent = await this.finance.findIntent(intentId);
    if (!intent || intent.customerOrganizationId !== organizationId) throw new PaymentIntentNotFound();
    const invoice = (await this.finance.findInvoice(intent.invoiceId))!;
    return this.view.customerIntent(intent, invoice.salesOrderNumber, this.simulationAvailable());
  }

  private simulationAvailable(): boolean {
    return this.gateway instanceof DevGateway && this.config.env.NODE_ENV !== 'production';
  }

  /**
   * The dev gateway's "pay" button. It does not touch money itself: it builds the signed
   * callback the provider would send and feeds it through `ingestWebhook`, the same path
   * a real provider's callback takes.
   */
  async simulate(actor: Actor, intentId: string, input: SimulatePaymentRequest): Promise<CustomerPaymentIntent> {
    const organizationId = this.requireCustomer(actor);
    if (!this.simulationAvailable()) throw new SimulationUnavailable();
    const intent = await this.finance.findIntent(intentId);
    if (!intent || intent.customerOrganizationId !== organizationId) throw new PaymentIntentNotFound();
    if (!OPEN_INTENT.has(intent.status)) throw new PaymentIntentNotOpen(intent.status);
    if (intent.expiresAt.getTime() <= Date.now()) throw new PaymentIntentNotOpen('expired');
    const webhook = (this.gateway as DevGateway).buildWebhook({
      type: input.outcome === 'success' ? 'payment.captured' : 'payment.failed',
      providerIntentId: intent.providerIntentId,
      amountMinor: intent.amountMinor,
      currency: intent.currency,
    });
    await this.ingestWebhook(this.gateway.provider, Buffer.from(webhook.body), webhook.headers);
    return this.customerIntent(actor, intentId);
  }

  async customerPayments(actor: Actor): Promise<CustomerPayments> {
    const organizationId = this.requireCustomer(actor);
    const [receipts, credits] = await Promise.all([this.finance.listCustomerReceipts(organizationId), this.finance.listUnappliedCredits(organizationId)]);
    return {
      payments: receipts.map(({ transaction, orderNumber }) => ({
        transactionId: transaction.id,
        kind: 'payment' as const,
        label: transaction.allocations.length > 0 ? `Payment for ${transaction.allocations.map((a) => a.invoiceNumber).join(', ')}` : 'Payment received',
        amountMinor: transaction.amountMinor,
        currency: transaction.currency,
        occurredAt: transaction.occurredAt.toISOString(),
        invoiceNumber: transaction.allocations[0]?.invoiceNumber ?? null,
        orderNumber,
        reference: transaction.kind === 'bank_transfer' ? transaction.reference : transaction.providerTransactionId,
      })),
      unappliedCreditMinor: credits.reduce((sum, c) => sum + c.amountMinor, 0),
      currency: credits[0]?.currency ?? 'INR',
    };
  }

  // ----------------------------------------------------------------- webhook ingestion

  async ingestWebhook(provider: string, rawBody: Buffer, headers: Record<string, string | string[] | undefined>): Promise<WebhookOutcome> {
    if (provider !== this.gateway.provider) throw new WebhookRejected('unknown provider');
    const verdict = this.gateway.verifyWebhook(rawBody, headers);
    const bodySha256 = sha256(rawBody.toString('utf8'));
    if (!verdict.ok) {
      // Recorded under its own key: a forged delivery must never be able to pre-claim the
      // id a genuine delivery will arrive with.
      await this.db.withTransaction(async (tx) => {
        await this.finance.claimWebhookReceipt(
          { provider, deliveryId: `rejected:${randomUUID()}`, eventType: verdict.eventType, bodySha256, signatureOk: false, outcome: 'rejected', note: `${verdict.reason ?? 'rejected'}; claimed id ${verdict.deliveryId || 'none'}` },
          tx,
        );
        await this.audit.write(tx, contextFromService(PAYMENT_GATEWAY_PRINCIPAL, null), {
          action: 'finance.webhook_rejected',
          subjectType: 'payment_provider',
          subjectId: provider,
          reason: verdict.reason ?? 'rejected',
          data: { claimedDeliveryId: verdict.deliveryId || null, bodySha256 },
        });
      });
      throw new WebhookRejected(verdict.reason ?? 'rejected');
    }

    return this.executor.execute<{ provider: string; deliveryId: string }, WebhookOutcome>(
      {
        operation: 'finance.ingest-payment-webhook',
        handler: async (tx, ctx): Promise<CommandOutcome<WebhookOutcome>> => {
          const receiptId = await this.finance.claimWebhookReceipt(
            { provider, deliveryId: verdict.deliveryId, eventType: verdict.eventType, bodySha256, signatureOk: true, outcome: 'processed', note: '' },
            tx,
          );
          if (!receiptId) return { result: { outcome: 'duplicate', transactionId: null }, audit: [] };
          const event = verdict.event;
          if (!event) {
            await this.finance.setReceiptOutcome({ receiptId, outcome: 'ignored', transactionId: null, note: verdict.reason ?? 'unsupported' }, tx);
            return { result: { outcome: 'ignored', transactionId: null }, audit: [] };
          }
          const intent = await this.finance.findIntentByProvider(provider, event.providerIntentId, tx);

          if (event.kind === 'failed') {
            if (intent && OPEN_INTENT.has(intent.status)) await this.finance.setIntentStatus({ intentId: intent.id, status: 'failed' }, tx);
            return {
              result: { outcome: 'processed', transactionId: null },
              audit: [{ action: 'finance.payment_failed', subjectType: 'payment_intent', subjectId: intent?.id ?? event.providerIntentId, data: { deliveryId: verdict.deliveryId } }],
              outbox: intent ? [{ eventType: 'finance.payment_failed.v1', aggregateType: 'payment_intent', aggregateId: intent.id, data: { paymentIntentId: intent.id, invoiceId: intent.invoiceId } }] : [],
            };
          }

          const transactionId = await this.finance.createTransaction(
            {
              provider,
              providerTransactionId: event.providerTransactionId,
              intentId: intent?.id ?? null,
              customerOrganizationId: intent?.customerOrganizationId ?? null,
              kind: 'capture',
              amountMinor: event.amountMinor,
              currency: event.currency,
              occurredAt: event.occurredAt,
              reference: intent?.invoiceNumber ?? '',
              status: 'recorded',
              note: '',
            },
            tx,
          );
          if (!transactionId) {
            // A different delivery of a transaction we already posted (FR-803).
            await this.finance.setReceiptOutcome({ receiptId, outcome: 'duplicate', transactionId: null, note: 'provider transaction already recorded' }, tx);
            return { result: { outcome: 'duplicate', transactionId: null }, audit: [] };
          }

          if (!intent || intent.currency !== event.currency) {
            const journalId = await this.finance.postJournal(
              {
                sourceType: 'payment_transaction',
                sourceId: transactionId,
                description: intent ? 'Capture in an unexpected currency' : 'Capture for an unknown intent',
                currency: event.currency,
                correlationId: ctx.correlationId,
                lines: [
                  { account: 'gateway_clearing', debitMinor: event.amountMinor },
                  { account: 'suspense', creditMinor: event.amountMinor },
                ],
              },
              tx,
            );
            await this.finance.setTransactionStatus({ transactionId, status: 'suspense', journalId }, tx);
            await this.finance.setReceiptOutcome({ receiptId, outcome: 'suspense', transactionId, note: intent ? 'currency mismatch' : 'no matching intent' }, tx);
            return {
              result: { outcome: 'suspense', transactionId },
              audit: [{ action: 'finance.payment_suspense', subjectType: 'payment_transaction', subjectId: transactionId, data: { amountMinor: event.amountMinor, currency: event.currency, journalId, reason: intent ? 'currency mismatch' : 'no matching intent' } }],
              outbox: [{ eventType: 'finance.payment_suspense.v1', aggregateType: 'payment_transaction', aggregateId: transactionId, data: { transactionId, amountMinor: event.amountMinor } }],
            };
          }

          // The provider's word is the truth about the money, whatever the intent's clock says.
          await this.finance.setIntentStatus({ intentId: intent.id, status: 'captured' }, tx);
          const invoice = (await this.finance.findInvoice(intent.invoiceId, tx, true))!;
          const applied = await this.money.applyReceipt(
            { transactionId, invoice, amountMinor: event.amountMinor, sourceAccount: 'gateway_clearing', allocatedBy: null, approvalRequestId: null, correlationId: ctx.correlationId },
            tx,
          );
          await this.finance.setTransactionStatus({ transactionId, status: 'allocated', journalId: applied.journalId }, tx);
          await this.finance.setReceiptOutcome({ receiptId, outcome: 'processed', transactionId, note: '' }, tx);
          return {
            result: { outcome: 'processed', transactionId },
            audit: [
              { action: 'finance.payment_captured', subjectType: 'payment_intent', subjectId: intent.id, data: { transactionId, amountMinor: event.amountMinor, deliveryId: verdict.deliveryId } },
              ...applied.audit,
            ],
            outbox: applied.outbox,
          };
        },
      },
      contextFromService(PAYMENT_GATEWAY_PRINCIPAL, null),
      { provider, deliveryId: verdict.deliveryId },
    );
  }

  // ----------------------------------------------------------------- reconcile sweep

  /**
   * Worker-driven (doc 10 §7 "reconcile provider clearing"): an intent nobody paid before
   * it expired is closed, so the customer is never told a payment is "being verified"
   * forever. A capture that still arrives later is posted anyway — the callback path does
   * not trust the intent's clock. Querying provider truth for silent intents is the real
   * adapter's job (`T-03`); the dev gateway has nothing to ask.
   */
  async reconcileSweep(principal: { id: string }, now = new Date()): Promise<{ expired: number }> {
    let expired = 0;
    for (const intentId of await this.finance.listStaleIntents(now)) {
      await this.executor.execute(
        {
          operation: 'finance.expire-payment-intent',
          handler: async (tx) => {
            const intent = await this.finance.findIntent(intentId, tx, true);
            if (!intent || !OPEN_INTENT.has(intent.status) || intent.expiresAt.getTime() >= now.getTime()) return { result: undefined, audit: [] };
            await this.finance.setIntentStatus({ intentId, status: 'expired' }, tx);
            expired += 1;
            return { result: undefined, audit: [{ action: 'finance.payment_intent_expired', subjectType: 'payment_intent', subjectId: intentId, data: { invoiceId: intent.invoiceId } }] };
          },
        },
        contextFromService(principal, null),
        { intentId },
      );
    }
    return { expired };
  }

  // ----------------------------------------------------------------- finance (internal)

  private requireFinance(actor: Actor): void {
    if (!actor.isInternal) throw new NotAuthorized('JobWork only');
    requireRole(actor, 'jobwork_finance');
    requireTransactionalStrength(actor);
  }

  async transaction(actor: Actor, transactionId: string): Promise<PaymentTransaction> {
    this.requireFinance(actor);
    const row = await this.finance.findTransaction(transactionId);
    if (!row) throw new TransactionNotFound();
    return this.view.transaction(row);
  }

  async reconciliation(actor: Actor): Promise<ReconciliationQueue> {
    this.requireFinance(actor);
    const [suspense, pending, credits] = await Promise.all([
      this.finance.listTransactions({ status: 'suspense' }, 200),
      this.finance.pendingAllocationRequests(),
      this.finance.listUnappliedCredits(null),
    ]);
    return {
      suspense: suspense.map((row) => this.view.transaction(row)),
      pendingAllocations: pending.map((p) => ({
        approvalRequestId: p.approvalRequestId,
        transactionId: String(p.context['transactionId']),
        invoiceId: String(p.context['invoiceId']),
        invoiceNumber: String(p.context['invoiceNumber']),
        amountMinor: Number(p.context['amountMinor']),
        requestedByName: p.requestedByName,
        requestedAt: p.requestedAt.toISOString(),
      })),
      unappliedCredits: credits.map((c) => ({ creditId: c.id, customerOrganizationId: c.customerOrganizationId, customerDisplayName: c.customerDisplayName, amountMinor: c.amountMinor, currency: c.currency, createdAt: c.createdAt.toISOString() })),
    };
  }

  /** A bank receipt keyed by its bank reference, so entering it twice cannot post twice. */
  async recordBankTransfer(actor: Actor, input: RecordBankTransferRequest, opts: Opts = {}): Promise<PaymentTransaction> {
    this.requireFinance(actor);
    const transactionId = await this.executor.execute(
      {
        operation: 'finance.record-bank-transfer',
        handler: async (tx, ctx, cmd: RecordBankTransferRequest) => {
          const id = await this.finance.createTransaction(
            {
              provider: 'bank',
              providerTransactionId: `bank:${cmd.bankReference.toUpperCase()}`,
              intentId: null,
              customerOrganizationId: cmd.customerOrganizationId ?? null,
              kind: 'bank_transfer',
              amountMinor: cmd.amountMinor,
              currency: cmd.currency,
              occurredAt: new Date(cmd.occurredAt),
              reference: cmd.bankReference,
              status: 'suspense',
              note: cmd.note,
            },
            tx,
          );
          if (!id) throw new DomainError('BANK_REFERENCE_EXISTS', 409, 'That bank reference is already recorded', 'Each bank credit is entered once; find it in the reconciliation queue.');
          const journalId = await this.finance.postJournal(
            {
              sourceType: 'payment_transaction',
              sourceId: id,
              description: `Bank credit ${cmd.bankReference}`,
              currency: cmd.currency,
              correlationId: ctx.correlationId,
              lines: [
                { account: 'bank', debitMinor: cmd.amountMinor },
                { account: 'suspense', creditMinor: cmd.amountMinor },
              ],
            },
            tx,
          );
          await this.finance.setTransactionStatus({ transactionId: id, status: 'suspense', journalId }, tx);
          return { result: id, audit: [{ action: 'finance.bank_transfer_recorded', subjectType: 'payment_transaction', subjectId: id, data: { amountMinor: cmd.amountMinor, currency: cmd.currency, journalId } }] };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.transaction(actor, transactionId);
  }

  private async remaining(transactionId: string, tx?: PoolClient): Promise<{ row: NonNullable<Awaited<ReturnType<FinanceRepository['findTransaction']>>>; remainingMinor: number }> {
    const row = await this.finance.findTransaction(transactionId, tx, Boolean(tx));
    if (!row) throw new TransactionNotFound();
    const allocated = row.allocations.reduce((sum, a) => sum + a.amountMinor, 0);
    return { row, remainingMinor: row.amountMinor - allocated };
  }

  /** The maker half: a finance user proposes moving money out of suspense onto an invoice. */
  async proposeAllocation(actor: Actor, input: ProposeAllocationRequest, opts: Opts = {}): Promise<ReconciliationQueue> {
    this.requireFinance(actor);
    const policy = await this.commercial.activePolicy('allocation');
    const approverRoles = (policy?.rules as { approverRoles?: unknown } | undefined)?.approverRoles;
    if (!policy || !Array.isArray(approverRoles) || approverRoles.length === 0) throw new PolicyRulesInvalid('allocation');
    await this.executor.execute(
      {
        operation: 'finance.propose-allocation',
        handler: async (tx, _ctx, cmd: ProposeAllocationRequest) => {
          const { row, remainingMinor } = await this.remaining(cmd.transactionId, tx);
          if (row.status !== 'suspense') throw new AllocationInvalid('Only money in suspense is allocated by hand.');
          if (cmd.amountMinor > remainingMinor) throw new AllocationInvalid(`Only ${remainingMinor} minor units of this receipt are unallocated.`);
          const invoice = await this.finance.findInvoice(cmd.invoiceId, tx);
          if (!invoice) throw new InvoiceNotFound();
          if (!PAYABLE.has(invoice.status)) throw new InvoiceNotPayable(invoice.status);
          if (invoice.currency !== row.currency) throw new AllocationInvalid('The receipt and the invoice are in different currencies.');
          if (cmd.amountMinor > invoice.totalMinor - invoice.paidMinor) throw new AllocationInvalid('That is more than the invoice still owes.');
          const label = `Allocate ${row.currency} ${(cmd.amountMinor / 100).toFixed(2)} from ${row.reference || row.providerTransactionId} to ${invoice.number}`;
          const requestId = await this.commercial.createApprovalRequest(
            {
              kind: 'allocation',
              subjectType: 'payment_transaction',
              subjectId: row.id,
              subjectVersionNo: null,
              subjectHash: sha256({ transactionId: row.id, invoiceId: invoice.id, amountMinor: cmd.amountMinor }),
              policyVersionId: policy.id,
              requestedBy: actor.userId,
              amountMinor: cmd.amountMinor,
              currency: row.currency,
              marginBp: null,
              context: { transactionId: row.id, invoiceId: invoice.id, invoiceNumber: invoice.number, amountMinor: cmd.amountMinor, customerOrganizationId: invoice.customerOrganizationId, note: cmd.note, label },
              requiredRoles: approverRoles as string[],
            },
            tx,
          );
          return {
            result: undefined,
            audit: [{ action: 'finance.allocation_proposed', subjectType: 'payment_transaction', subjectId: row.id, ...(cmd.note ? { reason: cmd.note } : {}), data: { approvalRequestId: requestId, invoiceId: invoice.id, amountMinor: cmd.amountMinor } }],
            outbox: [{ eventType: 'finance.allocation_proposed.v1', aggregateType: 'payment_transaction', aggregateId: row.id, data: { approvalRequestId: requestId } }],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.reconciliation(actor);
  }

  /** The checker half, run inside decide-approval's transaction when a finance colleague approves. */
  private async applyApprovedAllocation(input: ApprovalEffectInput, tx: PoolClient): Promise<Record<string, unknown>> {
    const transactionId = String(input.context['transactionId']);
    const invoiceId = String(input.context['invoiceId']);
    const amountMinor = Number(input.context['amountMinor']);
    if (input.decision !== 'approved') return { transactionId, invoiceId, applied: false };

    const { row, remainingMinor } = await this.remaining(transactionId, tx);
    if (row.status !== 'suspense' || amountMinor > remainingMinor) {
      throw new AllocationInvalid('The receipt changed since this allocation was proposed; propose it again.');
    }
    const invoice = await this.finance.findInvoice(invoiceId, tx, true);
    if (!invoice) throw new InvoiceNotFound();
    const correlation = `allocation:${input.requestId}`;
    const applied = await this.money.applyReceipt(
      { transactionId, invoice, amountMinor, sourceAccount: 'suspense', allocatedBy: input.decidedBy, approvalRequestId: input.requestId, correlationId: correlation },
      tx,
    );
    const fullyAllocated = amountMinor === remainingMinor;
    await this.finance.setTransactionStatus(
      { transactionId, status: fullyAllocated ? 'allocated' : 'suspense', customerOrganizationId: invoice.customerOrganizationId },
      tx,
    );
    // The decision's own audit/outbox carries this summary; the receipt's effects are written by the decision too.
    await this.writeEffects(tx, input, applied.audit, applied.outbox);
    return { transactionId, invoiceId, applied: true, allocatedMinor: applied.allocatedMinor, unappliedMinor: applied.unappliedMinor, released: applied.released };
  }

  private async writeEffects(tx: PoolClient, input: ApprovalEffectInput, audit: AuditSpec[], outbox: OutboxSpec[]): Promise<void> {
    const ctx = { actor: { type: 'user' as const, id: input.decidedBy, organizationId: null }, correlationId: `allocation:${input.requestId}` };
    for (const spec of audit) await this.audit.write(tx, ctx, spec);
    for (const spec of outbox) await this.outbox.write(tx, ctx, spec);
  }
}
