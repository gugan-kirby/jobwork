import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { AuditSpec } from '../../../platform/commands/command';
import { OrdersRepository } from '../infrastructure/orders.repository';
import { SettlementRepository } from '../infrastructure/settlement.repository';

/**
 * Doc 06 §7's last state from real facts (IN-18): an order the customer accepted is `closed` once
 * every purchase order of it is billed and paid and no support case is open. Called inside whichever
 * command made the last of those true: a settlement paid, a case closed, a delivery accepted.
 */
@Injectable()
export class OrderClosure {
  constructor(
    private readonly orders: OrdersRepository,
    private readonly settlement: SettlementRepository,
  ) {}

  async closeIfDone(salesOrderId: string, cause: string, tx: PoolClient): Promise<AuditSpec[]> {
    const order = await this.orders.findSalesOrder(salesOrderId, tx, true);
    if (!order || order.status !== 'customer_accepted') return [];
    if (!(await this.settlement.orderSettled(order.id, tx))) return [];
    await this.orders.setSalesOrderStatus({ orderId: order.id, status: 'closed' }, tx);
    return [{ action: 'orders.sales_order_closed', subjectType: 'sales_order', subjectId: order.id, data: { number: order.number, cause } }];
  }
}
