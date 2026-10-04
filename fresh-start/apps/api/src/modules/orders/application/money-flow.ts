import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { CommercialGate } from '@jobwork/contracts';
import { CommercialRepository } from '../../commercial';
import { evaluateGate, splitSchedule } from '../domain/schedule';
import { FinanceRepository, type InstallmentRecord, type InvoiceRecord } from '../infrastructure/finance.repository';
import { OrdersRepository, type SalesOrderRecord } from '../infrastructure/orders.repository';
import { canonicalJson } from '../../../platform/commands/canonical';
import type { AuditSpec, OutboxSpec } from '../../../platform/commands/command';

export function sha256(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex');
}

/** Effects a helper produced inside someone else's transaction, for the caller to append. */
export interface SideEffects {
  audit: AuditSpec[];
  outbox: OutboxSpec[];
}

const ADVANCE_DUE_DAYS = 7;

/**
 * The money flows every command shares (IN-08): computing the commercial gate, issuing an
 * instalment's invoice with its balanced journal, and applying a receipt to an invoice.
 * Each runs inside the caller's transaction and returns the audit/outbox it implies, so
 * the caller's single commit carries business state, audit and outbox together (doc 02 §8).
 */
@Injectable()
export class MoneyFlow {
  constructor(
    private readonly orders: OrdersRepository,
    private readonly finance: FinanceRepository,
    private readonly commercial: CommercialRepository,
  ) {}

  // ----------------------------------------------------------------- gate

  async gate(order: Pick<SalesOrderRecord, 'id' | 'customerOrganizationId' | 'currency' | 'totalMinor'>, tx?: PoolClient): Promise<CommercialGate> {
    const [installments, invoices, otherOpen, credit, holds] = await Promise.all([
      this.finance.listInstallments(order.id, tx),
      this.finance.listInvoicesForOrder(order.id, tx),
      this.finance.openReceivables(order.customerOrganizationId, order.id, tx),
      this.finance.findCreditProfile(order.customerOrganizationId, tx),
      this.finance.listActiveHolds(order.customerOrganizationId, tx),
    ]);
    const advance = installments.find((i) => i.kind === 'advance');
    const advanceInvoice = advance?.invoiceId ? invoices.find((i) => i.id === advance.invoiceId) : undefined;
    return evaluateGate({
      currency: order.currency,
      orderTotalMinor: order.totalMinor,
      advanceDueMinor: advance?.amountMinor ?? 0,
      advancePaidMinor: Math.min(advanceInvoice?.paidMinor ?? 0, advance?.amountMinor ?? 0),
      otherOpenReceivablesMinor: otherOpen,
      credit: credit ? { limitMinor: credit.limitMinor, currency: credit.currency, validUntil: credit.validUntil } : null,
      activeHolds: holds.map((h) => ({ reason: h.reason })),
      today: new Date().toISOString().slice(0, 10),
    });
  }

  /**
   * If the order is waiting on commercial release and the gate now passes, release it.
   * Called after a payment lands and by the explicit release command; a no-op otherwise.
   */
  async releaseIfGatePasses(orderId: string, tx: PoolClient, cause: string): Promise<SideEffects & { released: boolean; gate: CommercialGate | null }> {
    const order = await this.orders.findSalesOrder(orderId, tx, true);
    if (!order || order.status !== 'pending_commercial_release') return { audit: [], outbox: [], released: false, gate: null };
    const gate = await this.gate(order, tx);
    if (!gate.pass || !gate.basis) return { audit: [], outbox: [], released: false, gate };
    await this.orders.setSalesOrderStatus({ orderId, status: 'pending_technical_release', commercialRelease: { basis: gate.basis } }, tx);
    return {
      released: true,
      gate,
      audit: [
        {
          action: 'orders.commercially_released',
          subjectType: 'sales_order',
          subjectId: orderId,
          subjectVersion: order.aggregateVersion + 1,
          data: { basis: gate.basis, cause, advancePaidMinor: gate.advancePaidMinor, creditExposureMinor: gate.creditExposureMinor },
        },
      ],
      outbox: [
        {
          eventType: 'orders.sales_order_released.v1',
          aggregateType: 'sales_order',
          aggregateId: orderId,
          data: { orderId, number: order.number, basis: gate.basis, customerOrganizationId: order.customerOrganizationId },
        },
      ],
    };
  }

  // ----------------------------------------------------------------- invoices

  /**
   * Issue the invoice for one instalment (FR-804). The amounts are re-derived from the
   * accepted quotation version with the same split the instalments were created with,
   * so the advance and balance invoices always sum to the quotation, tax included.
   */
  async issueInstallmentInvoice(
    input: { order: SalesOrderRecord; installment: InstallmentRecord; issuedBy: string; correlationId: string; now: Date },
    tx: PoolClient,
  ): Promise<SideEffects & { invoiceId: string; number: string }> {
    const { order, installment } = input;
    const versions = await this.commercial.listQuoteVersions(order.customerQuoteId, tx);
    const accepted = versions.find((v) => v.id === order.acceptedQuoteVersionId);
    if (!accepted) throw new Error(`accepted version missing for order ${order.number}`);
    const part = splitSchedule({
      totalMinor: accepted.totalMinor,
      taxMinor: accepted.taxMinor,
      advanceBp: accepted.advanceBp,
      balanceTrigger: accepted.balanceTrigger,
    }).find((p) => p.seq === installment.seq);
    if (!part || part.amountMinor !== installment.amountMinor) {
      throw new Error(`instalment ${installment.seq} of ${order.number} does not match its schedule`);
    }

    const credit = await this.finance.findCreditProfile(order.customerOrganizationId, tx);
    const dueDays =
      installment.trigger === 'net_30' ? 30 : installment.kind === 'advance' ? ADVANCE_DUE_DAYS : credit?.termsDays || ADVANCE_DUE_DAYS;
    const dueAt = new Date(input.now.getTime() + dueDays * 86_400_000);
    const number = await this.orders.allocateNumber('INV', input.now, tx);
    const lines = [
      {
        lineNo: 1,
        description: `${part.label} — order ${order.number}: ${order.title}`,
        quantity: 1,
        unit: 'lot',
        unitPriceMinor: part.subtotalMinor,
        amountMinor: part.subtotalMinor,
      },
    ];
    const contentHash = sha256({
      number,
      orderNumber: order.number,
      currency: order.currency,
      lines,
      subtotalMinor: part.subtotalMinor,
      taxRateBp: accepted.taxRateBp,
      taxMinor: part.taxMinor,
      totalMinor: part.amountMinor,
      dueAt: dueAt.toISOString().slice(0, 10),
    });
    const invoiceId = await this.finance.createInvoice(
      {
        number,
        salesOrderId: order.id,
        installmentId: installment.id,
        customerOrganizationId: order.customerOrganizationId,
        kind: installment.kind,
        currency: order.currency,
        lines,
        subtotalMinor: part.subtotalMinor,
        taxRateBp: accepted.taxRateBp,
        taxMinor: part.taxMinor,
        totalMinor: part.amountMinor,
        contentHash,
        issuedBy: input.issuedBy,
        dueAt,
      },
      tx,
    );
    await this.finance.setInstallmentStatus({ installmentId: installment.id, status: 'invoiced', invoiceId }, tx);
    // doc 10 §6: receivable against revenue and the output-tax liability.
    const journalId = await this.finance.postJournal(
      {
        sourceType: 'invoice',
        sourceId: invoiceId,
        description: `Invoice ${number} for ${order.number}`,
        currency: order.currency,
        correlationId: input.correlationId,
        lines: [
          { account: 'customer_receivable', debitMinor: part.amountMinor, costObjectType: 'sales_order', costObjectId: order.id },
          { account: 'revenue', creditMinor: part.subtotalMinor, costObjectType: 'sales_order', costObjectId: order.id },
          { account: 'gst_output', creditMinor: part.taxMinor },
        ],
      },
      tx,
    );
    return {
      invoiceId,
      number,
      audit: [
        {
          action: 'finance.invoice_issued',
          subjectType: 'invoice',
          subjectId: invoiceId,
          data: { number, orderId: order.id, kind: installment.kind, totalMinor: part.amountMinor, contentHash, journalId },
        },
      ],
      outbox: [
        {
          eventType: 'finance.invoice_issued.v1',
          aggregateType: 'invoice',
          aggregateId: invoiceId,
          data: { invoiceId, number, orderId: order.id, customerOrganizationId: order.customerOrganizationId, totalMinor: part.amountMinor, dueAt: dueAt.toISOString() },
        },
      ],
    };
  }

  // ----------------------------------------------------------------- receipts

  /**
   * Apply received money to an invoice (doc 10 §§6–7). Whatever the invoice can take is
   * allocated against the receivable; anything beyond its open balance stays the
   * customer's, as visible unapplied credit — never a wallet (`D-03`). One balanced
   * journal records both. A settled advance then re-asks the release gate.
   */
  async applyReceipt(
    input: {
      transactionId: string;
      invoice: InvoiceRecord;
      amountMinor: number;
      sourceAccount: 'gateway_clearing' | 'bank' | 'suspense';
      allocatedBy: string | null;
      approvalRequestId: string | null;
      correlationId: string;
    },
    tx: PoolClient,
  ): Promise<SideEffects & { allocatedMinor: number; unappliedMinor: number; journalId: string; released: boolean }> {
    const { invoice } = input;
    const open = invoice.status === 'issued' || invoice.status === 'partially_paid' ? invoice.totalMinor - invoice.paidMinor : 0;
    const allocatedMinor = Math.min(input.amountMinor, Math.max(open, 0));
    const unappliedMinor = input.amountMinor - allocatedMinor;

    const journalId = await this.finance.postJournal(
      {
        sourceType: 'payment_transaction',
        sourceId: input.transactionId,
        description: `Receipt against ${invoice.number}`,
        currency: invoice.currency,
        correlationId: input.correlationId,
        lines: [
          { account: input.sourceAccount, debitMinor: input.amountMinor },
          { account: 'customer_receivable', creditMinor: allocatedMinor, costObjectType: 'sales_order', costObjectId: invoice.salesOrderId },
          { account: 'unapplied_cash', creditMinor: unappliedMinor },
        ],
      },
      tx,
    );

    const effects: SideEffects = { audit: [], outbox: [] };
    let status = invoice.status;
    if (allocatedMinor > 0) {
      await this.finance.createAllocation(
        { transactionId: input.transactionId, invoiceId: invoice.id, amountMinor: allocatedMinor, allocatedBy: input.allocatedBy, approvalRequestId: input.approvalRequestId, journalId },
        tx,
      );
      const applied = await this.finance.applyPayment({ invoiceId: invoice.id, amountMinor: allocatedMinor }, tx);
      status = applied.status;
      if (applied.status === 'paid' && invoice.installmentId) {
        await this.finance.setInstallmentStatus({ installmentId: invoice.installmentId, status: 'paid' }, tx);
      }
    }
    if (unappliedMinor > 0) {
      await this.finance.createUnappliedCredit(
        { customerOrganizationId: invoice.customerOrganizationId, transactionId: input.transactionId, amountMinor: unappliedMinor, currency: invoice.currency },
        tx,
      );
    }
    effects.audit.push({
      action: 'finance.payment_applied',
      subjectType: 'invoice',
      subjectId: invoice.id,
      data: { transactionId: input.transactionId, allocatedMinor, unappliedMinor, status, journalId, approvalRequestId: input.approvalRequestId },
    });
    effects.outbox.push({
      eventType: 'finance.payment_received.v1',
      aggregateType: 'invoice',
      aggregateId: invoice.id,
      data: { invoiceId: invoice.id, number: invoice.number, orderId: invoice.salesOrderId, customerOrganizationId: invoice.customerOrganizationId, allocatedMinor, unappliedMinor, status },
    });

    let released = false;
    if (status === 'paid' && invoice.kind === 'advance') {
      const release = await this.releaseIfGatePasses(invoice.salesOrderId, tx, `advance ${invoice.number} settled`);
      released = release.released;
      effects.audit.push(...release.audit);
      effects.outbox.push(...release.outbox);
    }
    return { ...effects, allocatedMinor, unappliedMinor, journalId, released };
  }
}
