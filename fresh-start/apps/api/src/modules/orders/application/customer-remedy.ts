import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { AuditSpec, OutboxSpec } from '../../../platform/commands/command';
import { DomainError } from '../../../platform/http/domain-error';
import { FinanceRepository } from '../infrastructure/finance.repository';
import { SettlementRepository } from '../infrastructure/settlement.repository';
import { sha256 } from './money-flow';

type Effects = { audit: AuditSpec[]; outbox: OutboxSpec[] };

/**
 * The money side of a case's remedies (IN-18 F-18.2; doc 10 §§6, 15; FR-806; BR-FIN-04, BR-FIN-06),
 * run inside the case command's transaction. A credit note corrects an invoice by a linked record and
 * the invoice stands; a refund pays the customer back; a recovery books what the supplier owes JobWork.
 * Each posts its own balanced journal, and none touches another party's money.
 */
@Injectable()
export class CustomerRemedy {
  constructor(
    private readonly finance: FinanceRepository,
    private readonly settlement: SettlementRepository,
  ) {}

  /** A credit note for `totalMinor` (tax included) against one of the order's invoices, split at its tax rate. */
  async creditNote(input: { salesOrderId: string; invoiceId: string; totalMinor: number; reason: string; caseId: string; by: string; correlationId: string }, tx: PoolClient): Promise<Effects & { creditNoteId: string; number: string }> {
    const invoice = await this.finance.findInvoice(input.invoiceId, tx, true);
    if (!invoice || invoice.salesOrderId !== input.salesOrderId) throw new DomainError('INVOICE_NOT_FOUND', 404, 'Invoice not found on this order');
    if (invoice.status === 'void') throw new DomainError('INVOICE_VOID', 409, `${invoice.number} is void`);
    const room = invoice.totalMinor - (await this.settlement.creditedOn(invoice.id, tx));
    if (input.totalMinor > room) throw new DomainError('CREDIT_BEYOND_INVOICE', 422, `At most ${(room / 100).toFixed(2)} can still be credited on ${invoice.number}`);
    const taxMinor = Math.round((input.totalMinor * invoice.taxRateBp) / (10_000 + invoice.taxRateBp));
    const taxableMinor = input.totalMinor - taxMinor;
    const number = await this.settlement.allocateNumber('CN', 'finance.credit_note', new Date(), tx);
    const journalId = await this.finance.postJournal(
      {
        sourceType: 'credit_note',
        sourceId: null,
        description: `Credit note ${number} on ${invoice.number}: ${input.reason}`,
        currency: invoice.currency,
        correlationId: input.correlationId,
        lines: [
          { account: 'revenue', debitMinor: taxableMinor, costObjectType: 'sales_order', costObjectId: input.salesOrderId },
          { account: 'gst_output', debitMinor: taxMinor },
          { account: 'customer_receivable', creditMinor: input.totalMinor, costObjectType: 'sales_order', costObjectId: input.salesOrderId },
        ],
      },
      tx,
    );
    const contentHash = sha256({ number, invoice: invoice.number, taxableMinor, taxMinor, totalMinor: input.totalMinor, reason: input.reason });
    const creditNoteId = await this.settlement.insertCreditNote(
      { number, invoiceId: invoice.id, salesOrderId: input.salesOrderId, customerOrganizationId: invoice.customerOrganizationId, currency: invoice.currency, reason: input.reason, taxableMinor, taxMinor, caseId: input.caseId, contentHash, journalId, by: input.by },
      tx,
    );
    return {
      creditNoteId,
      number,
      audit: [{ action: 'finance.credit_note_issued', subjectType: 'credit_note', subjectId: creditNoteId, data: { number, invoice: invoice.number, totalMinor: input.totalMinor, contentHash, journalId, caseId: input.caseId } }],
      outbox: [{ eventType: 'finance.credit_note_issued.v1', aggregateType: 'credit_note', aggregateId: creditNoteId, data: { creditNoteId, number, invoiceId: invoice.id, customerOrganizationId: invoice.customerOrganizationId } }],
    };
  }

  /** Money back to the customer, by bank transfer (no payout provider; `T-03`). */
  async refund(input: { salesOrderId: string; currency: string; amountMinor: number; reference: string; caseId: string; correlationId: string }, tx: PoolClient): Promise<Effects & { journalId: string }> {
    const journalId = await this.finance.postJournal(
      {
        sourceType: 'refund',
        sourceId: null,
        description: `Refund ${input.reference} for case ${input.caseId}`,
        currency: input.currency,
        correlationId: input.correlationId,
        lines: [
          { account: 'customer_receivable', debitMinor: input.amountMinor, costObjectType: 'sales_order', costObjectId: input.salesOrderId },
          { account: 'bank', creditMinor: input.amountMinor },
        ],
      },
      tx,
    );
    return { journalId, audit: [{ action: 'finance.refund_paid', subjectType: 'sales_order', subjectId: input.salesOrderId, data: { amountMinor: input.amountMinor, reference: input.reference, journalId, caseId: input.caseId } }], outbox: [{ eventType: 'finance.refund_paid.v1', aggregateType: 'sales_order', aggregateId: input.salesOrderId, data: { amountMinor: input.amountMinor, caseId: input.caseId } }] };
  }

  /** What the supplier owes JobWork back; its settlements stay held while the recovery is open (BR-FIN-04). */
  async recovery(input: { salesOrderId: string; purchaseOrderId: string | null; currency: string; amountMinor: number; reference: string; caseId: string; correlationId: string }, tx: PoolClient): Promise<Effects & { journalId: string }> {
    const journalId = await this.finance.postJournal(
      {
        sourceType: 'supplier_recovery',
        sourceId: null,
        description: `Supplier recovery ${input.reference} for case ${input.caseId}`,
        currency: input.currency,
        correlationId: input.correlationId,
        lines: [
          { account: 'supplier_recovery', debitMinor: input.amountMinor, ...(input.purchaseOrderId ? { costObjectType: 'purchase_order', costObjectId: input.purchaseOrderId } : {}) },
          { account: 'cost_of_goods', creditMinor: input.amountMinor, costObjectType: 'sales_order', costObjectId: input.salesOrderId },
        ],
      },
      tx,
    );
    return { journalId, audit: [{ action: 'finance.supplier_recovery_booked', subjectType: 'sales_order', subjectId: input.salesOrderId, data: { amountMinor: input.amountMinor, purchaseOrderId: input.purchaseOrderId, journalId, caseId: input.caseId } }], outbox: [] };
  }
}
