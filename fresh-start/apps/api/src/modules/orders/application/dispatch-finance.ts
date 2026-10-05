import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { BalanceTrigger } from '@jobwork/contracts';
import { FinanceRepository } from '../infrastructure/finance.repository';
import { OrdersRepository } from '../infrastructure/orders.repository';
import { MoneyFlow, type SideEffects } from './money-flow';

/** Instalments the goods may not leave without (doc 10 §4): what falls due on acceptance or before dispatch. */
const DUE_BEFORE_DISPATCH: readonly BalanceTrigger[] = ['on_acceptance', 'before_dispatch'];

export interface DispatchPaymentFacts {
  currency: string;
  holds: string[];
  unpaid: Array<{ label: string; invoiceNumber: string | null; openMinor: number }>;
  credit: { usable: boolean; limitMinor: number; exposureMinor: number } | null;
}

/**
 * The money side of customer dispatch and delivery (IN-17), owned by orders and called inside the
 * logistics command's transaction: an instalment becomes an invoice when its trigger is met, and
 * the dispatch gate reads what is paid, open and covered by credit from finance's own records.
 */
@Injectable()
export class DispatchFinance {
  constructor(
    private readonly orders: OrdersRepository,
    private readonly finance: FinanceRepository,
    private readonly money: MoneyFlow,
  ) {}

  /**
   * Issue every pending instalment whose trigger is met: `before_dispatch` when the first dispatch is
   * planned; `on_delivery` and `net_30` once the goods are handed over.
   */
  async issueDue(salesOrderId: string, at: 'dispatch_planned' | 'delivered', issuedBy: string, correlationId: string, tx: PoolClient): Promise<SideEffects & { invoiceNumbers: string[] }> {
    const order = await this.orders.findSalesOrder(salesOrderId, tx);
    if (!order) return { audit: [], outbox: [], invoiceNumbers: [] };
    const triggers: readonly BalanceTrigger[] = at === 'dispatch_planned' ? ['before_dispatch'] : ['on_delivery', 'net_30'];
    const due = (await this.finance.listInstallments(salesOrderId, tx)).filter((i) => i.status === 'pending' && i.kind === 'balance' && triggers.includes(i.trigger));
    const out: SideEffects & { invoiceNumbers: string[] } = { audit: [], outbox: [], invoiceNumbers: [] };
    for (const installment of due) {
      const issued = await this.money.issueInstallmentInvoice({ order, installment, issuedBy, correlationId, now: new Date() }, tx);
      out.audit.push(...issued.audit);
      out.outbox.push(...issued.outbox);
      out.invoiceNumbers.push(issued.number);
    }
    return out;
  }

  async paymentFacts(salesOrderId: string, tx?: PoolClient): Promise<DispatchPaymentFacts | null> {
    const order = await this.orders.findSalesOrder(salesOrderId, tx);
    if (!order) return null;
    const installments = await this.finance.listInstallments(salesOrderId, tx);
    const invoices = await this.finance.listInvoicesForOrder(salesOrderId, tx);
    const holds = await this.finance.listActiveHolds(order.customerOrganizationId, tx);
    const credit = await this.finance.findCreditProfile(order.customerOrganizationId, tx);
    const exposure = await this.finance.openReceivables(order.customerOrganizationId, null, tx);
    const unpaid: DispatchPaymentFacts['unpaid'] = [];
    for (const i of installments) {
      if (!DUE_BEFORE_DISPATCH.includes(i.trigger) || i.status === 'paid' || i.status === 'waived') continue;
      const invoice = i.invoiceId ? invoices.find((x) => x.id === i.invoiceId) : undefined;
      if (!invoice) unpaid.push({ label: i.label, invoiceNumber: null, openMinor: i.amountMinor });
      else if (invoice.status !== 'paid' && invoice.status !== 'void') unpaid.push({ label: i.label, invoiceNumber: invoice.number, openMinor: invoice.totalMinor - invoice.paidMinor });
    }
    const today = new Date().toISOString().slice(0, 10);
    return {
      currency: order.currency,
      holds: holds.map((h) => h.reason),
      unpaid,
      credit: credit
        ? { usable: credit.currency === order.currency && (credit.validUntil === null || credit.validUntil >= today), limitMinor: credit.limitMinor, exposureMinor: exposure }
        : null,
    };
  }

  /** An invoice of this order by number, for the dispatch documents' consistency check (doc 10 §8). */
  async invoiceOfOrder(salesOrderId: string, number: string, tx?: PoolClient): Promise<{ invoiceId: string; status: string } | null> {
    const invoice = (await this.finance.listInvoicesForOrder(salesOrderId, tx)).find((i) => i.number === number.trim());
    return invoice ? { invoiceId: invoice.id, status: invoice.status } : null;
  }

  /** The order's issued invoices, for the planner's choice of the tax invoice. */
  async issuedInvoices(salesOrderId: string): Promise<Array<{ number: string; kind: string; status: string }>> {
    return (await this.finance.listInvoicesForOrder(salesOrderId)).filter((i) => i.status !== 'void').map((i) => ({ number: i.number, kind: i.kind, status: i.status }));
  }
}
