import { Controller, Get, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  acceptQuoteRequestSchema,
  simulatePaymentRequestSchema,
  type CustomerInvoice,
  type CustomerOrder,
  type CustomerOrderListItem,
  type CustomerPaymentIntent,
  type CustomerPayments,
} from '@jobwork/contracts';
import { type Actor, requireOrganization, requireRole } from '../../iam';
import { NotAuthorized } from '../../iam/domain/errors';
import { AcceptQuoteCommand } from '../application/accept-quote.command';
import { OrdersView } from '../application/orders-view';
import { PaymentCommand } from '../application/payment.command';
import { OrderNotFound } from '../domain/errors';
import { OrdersRepository } from '../infrastructure/orders.repository';
import { renderInvoiceDocument } from './invoice-document';
import { CurrentActor } from '../../../platform/http/actor.decorator';
import { parseBody } from '../../../platform/http/validation';
import { RateLimit } from '../../../platform/http/rate-limit/rate-limit.decorator';

function idempotencyKey(request: FastifyRequest): string | undefined {
  const header = request.headers['idempotency-key'];
  return typeof header === 'string' ? header : undefined;
}

const CUSTOMER_ROLES = ['customer_requester', 'customer_approver', 'org_admin'];

function requireCustomer(actor: Actor): string {
  if (actor.organizationType !== 'customer') throw new NotAuthorized('Customer organizations only');
  requireRole(actor, ...CUSTOMER_ROLES);
  return requireOrganization(actor);
}

/** UC-05 acceptance — its own controller beside the IN-07 quotation reads. */
@Controller('quotations')
export class AcceptQuoteController {
  constructor(
    private readonly accept: AcceptQuoteCommand,
    private readonly orders: OrdersRepository,
    private readonly view: OrdersView,
  ) {}

  @Post(':quotationId/accept')
  async acceptQuote(@CurrentActor() actor: Actor, @Param('quotationId') quotationId: string, @Req() request: FastifyRequest): Promise<CustomerOrder> {
    const body = parseBody(acceptQuoteRequestSchema, request.body);
    const { orderId } = await this.accept.execute(actor, quotationId, body, { idempotencyKey: idempotencyKey(request) });
    const order = await this.orders.findSalesOrder(orderId);
    if (!order) throw new OrderNotFound();
    return this.view.customerOrder(order);
  }
}

/** The customer's orders (prototype tiles 11–12, corrected): JobWork's commitment, no supplier anywhere. */
@Controller('orders')
export class CustomerOrdersController {
  constructor(
    private readonly orders: OrdersRepository,
    private readonly view: OrdersView,
  ) {}

  @Get()
  async list(@CurrentActor() actor: Actor): Promise<{ orders: CustomerOrderListItem[] }> {
    const organizationId = requireCustomer(actor);
    const rows = await this.orders.listSalesOrdersForCustomer(organizationId);
    return { orders: await Promise.all(rows.map((row) => this.view.customerOrderListItem(row))) };
  }

  @Get(':orderId')
  async get(@CurrentActor() actor: Actor, @Param('orderId') orderId: string): Promise<CustomerOrder> {
    const organizationId = requireCustomer(actor);
    const order = await this.orders.findSalesOrder(orderId);
    if (!order || order.customerOrganizationId !== organizationId) throw new OrderNotFound();
    return this.view.customerOrder(order);
  }
}

/** Invoices (prototype tile 13): issued once, never edited; pay opens a server-made intent. */
@Controller('invoices')
export class CustomerInvoicesController {
  constructor(private readonly payments: PaymentCommand) {}

  @Get()
  async list(@CurrentActor() actor: Actor): Promise<{ invoices: CustomerInvoice[] }> {
    return { invoices: await this.payments.customerInvoices(actor) };
  }

  @Get(':invoiceId')
  async get(@CurrentActor() actor: Actor, @Param('invoiceId') invoiceId: string): Promise<CustomerInvoice> {
    return this.payments.customerInvoice(actor, invoiceId);
  }

  @RateLimit('export')
  @Get(':invoiceId/document')
  async document(@CurrentActor() actor: Actor, @Param('invoiceId') invoiceId: string): Promise<{ html: string; contentHash: string }> {
    const invoice = await this.payments.ownedInvoice(actor, invoiceId);
    return { html: renderInvoiceDocument(invoice), contentHash: invoice.contentHash };
  }

  @RateLimit('payment')
  @Post(':invoiceId/pay')
  async pay(@CurrentActor() actor: Actor, @Param('invoiceId') invoiceId: string, @Req() request: FastifyRequest): Promise<CustomerPaymentIntent> {
    return this.payments.createIntent(actor, invoiceId, { idempotencyKey: idempotencyKey(request) });
  }
}

/** Payments (prototype tile 14, corrected): receipts matched to invoices — no wallet, no "add money". */
@Controller('payments')
export class CustomerPaymentsController {
  constructor(private readonly payments: PaymentCommand) {}

  @Get()
  async list(@CurrentActor() actor: Actor): Promise<CustomerPayments> {
    return this.payments.customerPayments(actor);
  }

  @Get('intents/:intentId')
  async intent(@CurrentActor() actor: Actor, @Param('intentId') intentId: string): Promise<CustomerPaymentIntent> {
    return this.payments.customerIntent(actor, intentId);
  }

  @RateLimit('payment')
  @Post('intents/:intentId/simulate')
  async simulate(@CurrentActor() actor: Actor, @Param('intentId') intentId: string, @Req() request: FastifyRequest): Promise<CustomerPaymentIntent> {
    const body = parseBody(simulatePaymentRequestSchema, request.body);
    return this.payments.simulate(actor, intentId, body);
  }
}
