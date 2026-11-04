import { Injectable } from '@nestjs/common';
import type { RateSupplierRequest } from '@jobwork/contracts';
import { OrderNotFound } from '../domain/errors';
import { customerStatusOf } from '../domain/customer-status';
import { OrdersRepository } from '../infrastructure/orders.repository';
import { contextFromActor } from '../../../platform/commands/command';
import { CommandExecutor } from '../../../platform/commands/execute';
import { DomainError } from '../../../platform/http/domain-error';
import type { Actor } from '../../iam';

/**
 * rate-supplier (ADR-0007): a rating is earned. One per order, only once the order is
 * complete, only from the customer who received it, and only for the supplier its quote
 * named. It is append-only; a customer cannot revise it into another number later.
 */
@Injectable()
export class RateSupplierCommand {
  constructor(
    private readonly orders: OrdersRepository,
    private readonly executor: CommandExecutor,
  ) {}

  async execute(
    actor: Actor,
    organizationId: string,
    orderId: string,
    input: RateSupplierRequest,
    opts: { idempotencyKey?: string | undefined } = {},
  ): Promise<void> {
    await this.executor.execute(
      {
        operation: 'orders.rate-supplier',
        handler: async (tx, _ctx, cmd: RateSupplierRequest) => {
          const order = await this.orders.findSalesOrder(orderId, tx, true);
          // Not yours and does not exist are the same answer (doc 11 §5).
          if (!order || order.customerOrganizationId !== organizationId) throw new OrderNotFound();
          if (customerStatusOf(order.status) !== 'completed') {
            throw new DomainError('ORDER_NOT_COMPLETE', 409, 'Rate the order once it is complete', 'A rating follows delivery.');
          }
          const supplierOrganizationId = await this.orders.supplierIdOf(order.customerQuoteId, tx);
          if (!supplierOrganizationId) {
            throw new DomainError('ORDER_NAMES_NO_SUPPLIER', 422, 'This order names no single supplier', 'There is no one supplier to rate.');
          }
          if (await this.orders.findRating(orderId, tx)) {
            throw new DomainError('ORDER_ALREADY_RATED', 409, 'This order is already rated', 'One rating per order.');
          }
          const ratingId = await this.orders.insertRating(
            { orderId, supplierOrganizationId, customerOrganizationId: organizationId, score: cmd.score, note: cmd.note, createdBy: actor.userId },
            tx,
          );
          return {
            result: undefined,
            audit: [{ action: 'orders.supplier_rated', subjectType: 'sales_order', subjectId: orderId, data: { ratingId, score: cmd.score } }],
            outbox: [{ eventType: 'orders.supplier_rated.v1', aggregateType: 'sales_order', aggregateId: orderId, data: { ratingId, score: cmd.score } }],
          };
        },
      },
      contextFromActor({ userId: actor.userId, organizationId }),
      input,
      opts,
    );
  }
}
