import { Controller, Get, HttpCode, Param, Post, Query, Req, type RawBodyRequest } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  acknowledgePurchaseOrderRequestSchema,
  issueInstallmentInvoiceRequestSchema,
  orderVersionRequestSchema,
  placeCreditHoldRequestSchema,
  proposeAllocationRequestSchema,
  recordBankTransferRequestSchema,
  releaseCreditHoldRequestSchema,
  salesOrderStatusSchema,
  setCreditProfileRequestSchema,
  type CreditProfile,
  type Invoice,
  type PaymentTransaction,
  type ReconciliationQueue,
  type SalesOrder,
  type SupplierPurchaseOrder,
} from '@jobwork/contracts';
import { z } from 'zod';
import { type Actor, requireRole } from '../../iam';
import { NotAuthorized } from '../../iam/domain/errors';
import { OrderCommand, ORDER_READ_ROLES } from '../application/order.command';
import { OrdersView } from '../application/orders-view';
import { PaymentCommand, type WebhookOutcome } from '../application/payment.command';
import { OrderNotFound } from '../domain/errors';
import { FinanceRepository } from '../infrastructure/finance.repository';
import { OrdersRepository } from '../infrastructure/orders.repository';
import { CurrentActor } from '../../../platform/http/actor.decorator';
import { Public } from '../../../platform/http/public.decorator';
import { ServiceOnly } from '../../../platform/http/service-principal.guard';
import { SCAN_WORKER_PRINCIPAL } from '@jobwork/service-auth';
import { ValidationFailed } from '../../../platform/http/domain-error';
import { parseBody } from '../../../platform/http/validation';
import { RateLimit } from '../../../platform/http/rate-limit/rate-limit.decorator';

function idempotencyKey(request: FastifyRequest): string | undefined {
  const header = request.headers['idempotency-key'];
  return typeof header === 'string' ? header : undefined;
}

const orderListQuerySchema = z.object({
  status: salesOrderStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

const invoiceListQuerySchema = z.object({
  status: z.enum(['issued', 'partially_paid', 'paid', 'void']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

/** JobWork's view of sales orders: purchase orders, release gate, instalments. */
@Controller('sales-orders')
export class SalesOrdersController {
  constructor(
    private readonly commands: OrderCommand,
    private readonly orders: OrdersRepository,
  ) {}

  @Get()
  async list(@CurrentActor() actor: Actor, @Query() query: unknown): Promise<{ salesOrders: SalesOrder[] }> {
    const { status, limit } = parseBody(orderListQuerySchema, query);
    return { salesOrders: await this.commands.list(actor, { status }, limit) };
  }

  @Get(':orderId')
  async get(@CurrentActor() actor: Actor, @Param('orderId') orderId: string): Promise<SalesOrder> {
    return this.commands.get(actor, orderId);
  }

  /** The frozen contract snapshot the acceptance created (FR-501). */
  @Get(':orderId/contract')
  async contract(@CurrentActor() actor: Actor, @Param('orderId') orderId: string): Promise<{ snapshot: unknown; contentHash: string }> {
    if (!actor.isInternal) throw new NotAuthorized('JobWork only');
    requireRole(actor, ...ORDER_READ_ROLES);
    const order = await this.orders.findSalesOrder(orderId);
    if (!order) throw new OrderNotFound();
    return (await this.orders.findContractSnapshot(order.contractSnapshotId))!;
  }

  @Post(':orderId/purchase-orders')
  async issuePurchaseOrders(@CurrentActor() actor: Actor, @Param('orderId') orderId: string, @Req() request: FastifyRequest): Promise<SalesOrder> {
    const body = parseBody(orderVersionRequestSchema, request.body);
    return this.commands.issuePurchaseOrders(actor, orderId, body, { idempotencyKey: idempotencyKey(request) });
  }

  @Post(':orderId/release-commercial')
  async releaseCommercial(@CurrentActor() actor: Actor, @Param('orderId') orderId: string, @Req() request: FastifyRequest): Promise<SalesOrder> {
    const body = parseBody(orderVersionRequestSchema, request.body);
    return this.commands.releaseCommercial(actor, orderId, body, { idempotencyKey: idempotencyKey(request) });
  }

  @Post(':orderId/invoices')
  async issueInvoice(@CurrentActor() actor: Actor, @Param('orderId') orderId: string, @Req() request: FastifyRequest): Promise<SalesOrder> {
    const body = parseBody(issueInstallmentInvoiceRequestSchema, request.body);
    return this.commands.issueInstallmentInvoice(actor, orderId, body, { idempotencyKey: idempotencyKey(request) });
  }
}

/** Finance: reconciliation, bank receipts, maker-checker allocation, credit. */
@Controller('finance')
export class FinanceController {
  constructor(
    private readonly payments: PaymentCommand,
    private readonly commands: OrderCommand,
    private readonly finance: FinanceRepository,
    private readonly view: OrdersView,
  ) {}

  @Get('reconciliation')
  async reconciliation(@CurrentActor() actor: Actor): Promise<ReconciliationQueue> {
    return this.payments.reconciliation(actor);
  }

  @Get('invoices')
  async invoices(@CurrentActor() actor: Actor, @Query() query: unknown): Promise<{ invoices: Invoice[] }> {
    if (!actor.isInternal) throw new NotAuthorized('JobWork only');
    requireRole(actor, 'jobwork_finance', 'jobwork_sales');
    const { status, limit } = parseBody(invoiceListQuerySchema, query);
    return { invoices: (await this.finance.listInvoices({ status }, limit)).map((row) => this.view.invoice(row)) };
  }

  @Get('transactions/:transactionId')
  async transaction(@CurrentActor() actor: Actor, @Param('transactionId') transactionId: string): Promise<PaymentTransaction> {
    return this.payments.transaction(actor, transactionId);
  }

  @Post('bank-transfers')
  async bankTransfer(@CurrentActor() actor: Actor, @Req() request: FastifyRequest): Promise<PaymentTransaction> {
    const body = parseBody(recordBankTransferRequestSchema, request.body);
    return this.payments.recordBankTransfer(actor, body, { idempotencyKey: idempotencyKey(request) });
  }

  @Post('allocations')
  async propose(@CurrentActor() actor: Actor, @Req() request: FastifyRequest): Promise<ReconciliationQueue> {
    const body = parseBody(proposeAllocationRequestSchema, request.body);
    return this.payments.proposeAllocation(actor, body, { idempotencyKey: idempotencyKey(request) });
  }

  @Get('credit/:organizationId')
  async credit(@CurrentActor() actor: Actor, @Param('organizationId') organizationId: string): Promise<{ credit: CreditProfile | null }> {
    return { credit: await this.commands.getCredit(actor, organizationId) };
  }

  @Post('credit/:organizationId')
  async setCredit(@CurrentActor() actor: Actor, @Param('organizationId') organizationId: string, @Req() request: FastifyRequest): Promise<{ credit: CreditProfile | null }> {
    const body = parseBody(setCreditProfileRequestSchema, request.body);
    return { credit: await this.commands.setCredit(actor, organizationId, body, { idempotencyKey: idempotencyKey(request) }) };
  }

  @Post('credit/:organizationId/holds')
  async placeHold(@CurrentActor() actor: Actor, @Param('organizationId') organizationId: string, @Req() request: FastifyRequest): Promise<{ credit: CreditProfile | null }> {
    const body = parseBody(placeCreditHoldRequestSchema, request.body);
    return { credit: await this.commands.placeHold(actor, organizationId, body, { idempotencyKey: idempotencyKey(request) }) };
  }

  @Post('credit/:organizationId/holds/:holdId/release')
  async releaseHold(
    @CurrentActor() actor: Actor,
    @Param('organizationId') organizationId: string,
    @Param('holdId') holdId: string,
    @Req() request: FastifyRequest,
  ): Promise<{ credit: CreditProfile | null }> {
    const body = parseBody(releaseCreditHoldRequestSchema, request.body);
    return { credit: await this.commands.releaseHold(actor, organizationId, holdId, body, { idempotencyKey: idempotencyKey(request) }) };
  }
}

/** The supplier's purchase orders: its own lines and price, no customer, no sell side. */
@Controller('supplier/purchase-orders')
export class SupplierPurchaseOrdersController {
  constructor(private readonly commands: OrderCommand) {}

  @Get()
  async list(@CurrentActor() actor: Actor): Promise<{ purchaseOrders: SupplierPurchaseOrder[] }> {
    return { purchaseOrders: await this.commands.supplierList(actor) };
  }

  @Get(':purchaseOrderId')
  async get(@CurrentActor() actor: Actor, @Param('purchaseOrderId') id: string): Promise<SupplierPurchaseOrder> {
    return this.commands.supplierGet(actor, id);
  }

  @Post(':purchaseOrderId/acknowledge')
  async acknowledge(@CurrentActor() actor: Actor, @Param('purchaseOrderId') id: string, @Req() request: FastifyRequest): Promise<SupplierPurchaseOrder> {
    const body = parseBody(acknowledgePurchaseOrderRequestSchema, request.body);
    return this.commands.acknowledge(actor, id, body, { idempotencyKey: idempotencyKey(request) });
  }
}

/** The scheduled reconcile tick, reachable only by the worker's service principal (doc 20 §9). */
@ServiceOnly(SCAN_WORKER_PRINCIPAL.name)
@Controller('internal/payments')
export class InternalPaymentsController {
  constructor(private readonly payments: PaymentCommand) {}

  @Post('reconcile-sweep')
  async sweep(@CurrentActor() actor: Actor): Promise<{ expired: number }> {
    return this.payments.reconcileSweep({ id: actor.userId });
  }
}

/**
 * Provider callbacks (doc 08 §11). No session, no CSRF token — the signature over the
 * raw bytes is the only credential, and the ingestion command decides what is true.
 */
@RateLimit('webhook')
@Public()
@Controller('webhooks/payments')
export class PaymentWebhookController {
  constructor(private readonly payments: PaymentCommand) {}

  @Post(':provider')
  @HttpCode(200)
  async receive(@Param('provider') provider: string, @Req() request: RawBodyRequest<FastifyRequest>): Promise<WebhookOutcome> {
    if (!request.rawBody) throw new ValidationFailed([{ path: 'body', message: 'A raw request body is required' }]);
    return this.payments.ingestWebhook(provider, request.rawBody, request.headers);
  }
}
