import { Injectable } from '@nestjs/common';
import type { JobMargin } from '@jobwork/contracts';
import { type Actor, requireRole } from '../../iam';
import { NotAuthorized } from '../../iam/domain/errors';
import { DomainError } from '../../../platform/http/domain-error';
import { OrdersRepository, type SalesOrderRecord } from '../infrastructure/orders.repository';
import { SettlementRepository } from '../infrastructure/settlement.repository';

/**
 * Margin realization (IN-18 F-18.3; doc 05 §8; doc 01 §7): what the approved cost sheet promised
 * against what the order's postings say happened. Revenue is net of credit notes; cost is the
 * supplier's billed work less recoveries, plus change and warranty cost. Internal only (BR-COM-05).
 */
@Injectable()
export class JobMarginView {
  constructor(
    private readonly orders: OrdersRepository,
    private readonly settlement: SettlementRepository,
  ) {}

  private require(actor: Actor): void {
    if (!actor.isInternal) throw new NotAuthorized('JobWork only');
    requireRole(actor, 'jobwork_finance', 'jobwork_sales');
  }

  async forOrder(actor: Actor, salesOrderId: string): Promise<JobMargin> {
    this.require(actor);
    const order = await this.orders.findSalesOrder(salesOrderId);
    if (!order) throw new DomainError('ORDER_NOT_FOUND', 404, 'Order not found');
    return this.margin(order);
  }

  async list(actor: Actor): Promise<JobMargin[]> {
    this.require(actor);
    const rows = (await this.orders.listSalesOrders({}, 100)).filter((o) => o.status !== 'cancelled' && o.status !== 'pending_commercial_release');
    return Promise.all(rows.map((o) => this.margin(o)));
  }

  private async margin(order: SalesOrderRecord): Promise<JobMargin> {
    const f = await this.settlement.marginFacts(order.id);
    const net = (account: string, side: 'debit' | 'credit'): number => {
      const p = f.posted[account] ?? { debit: 0, credit: 0 };
      return side === 'debit' ? p.debit - p.credit : p.credit - p.debit;
    };
    const revenue = f.posted['revenue']?.credit ?? 0;
    const credits = f.posted['revenue']?.debit ?? 0;
    const cogs = f.posted['cost_of_goods']?.debit ?? 0;
    const recoveries = f.posted['cost_of_goods']?.credit ?? 0;
    const change = net('change_cost', 'debit');
    const warranty = net('warranty_cost', 'debit');
    const margin = revenue - credits - (cogs - recoveries) - change - warranty;
    const netRevenue = revenue - credits;
    return {
      salesOrderId: order.id,
      orderNumber: order.number,
      customerDisplayName: order.customerDisplayName,
      status: order.status,
      currency: order.currency,
      planned: f.plan ? { sellMinor: f.plan.sell, landedMinor: f.plan.landed, marginMinor: f.plan.margin, marginBp: f.plan.marginBp } : null,
      actual: {
        revenueMinor: revenue,
        creditNotesMinor: credits,
        costOfGoodsMinor: cogs,
        recoveriesMinor: recoveries,
        changeCostMinor: change,
        warrantyCostMinor: warranty,
        marginMinor: margin,
        marginBp: netRevenue > 0 ? Math.round((margin * 10_000) / netRevenue) : null,
      },
      varianceMinor: f.plan && f.billsComplete ? margin - f.plan.margin : null,
      billsComplete: f.billsComplete,
    };
  }
}
