import { Controller, Get, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  confirmDeliveryAddressRequestSchema,
  planCustomerDispatchRequestSchema,
  recordAddressConfirmationRequestSchema,
  replanCustomerDispatchRequestSchema,
  requestDispatchOverrideRequestSchema,
  shipmentVersionRequestSchema,
  type CustomerDelivery,
  type CustomerOrderDocument,
  type DispatchContext,
  type Shipment,
} from '@jobwork/contracts';
import type { Actor } from '../../iam';
import { CurrentActor } from '../../../platform/http/actor.decorator';
import { RateLimit } from '../../../platform/http/rate-limit/rate-limit.decorator';
import { parseBody } from '../../../platform/http/validation';
import { CustomerDeliveries } from '../application/customer-deliveries';
import { CustomerDispatchCommand } from '../application/customer-dispatch.command';
import { LogisticsRepository } from '../infrastructure/logistics.repository';
import { renderConformityCertificate, renderDeliveryNote, renderShippingLabels, type RenderedDocument } from './customer-documents';
import { InternalOnly } from '../../../platform/http/public.decorator';

function idempotencyKey(request: FastifyRequest): string | undefined {
  const header = request.headers['idempotency-key'];
  return typeof header === 'string' ? header : undefined;
}

const opts = (request: FastifyRequest) => ({ idempotencyKey: idempotencyKey(request) });

/** JobWork logistics: plan, confirm, override and release a delivery to the customer (doc 08 `dispatch-to-customer`). */
@InternalOnly()
@Controller()
export class CustomerDispatchController {
  constructor(
    private readonly dispatch: CustomerDispatchCommand,
    private readonly deliveries: CustomerDeliveries,
    private readonly repo: LogisticsRepository,
  ) {}

  @Get('logistics/sales-orders/:salesOrderId/dispatch-context')
  context(@CurrentActor() actor: Actor, @Param('salesOrderId') id: string): Promise<DispatchContext> {
    return this.dispatch.context(actor, parseBody(z.uuid(), id));
  }

  @Post('customer-dispatches')
  plan(@CurrentActor() actor: Actor, @Req() request: FastifyRequest): Promise<Shipment> {
    return this.dispatch.plan(actor, parseBody(planCustomerDispatchRequestSchema, request.body), opts(request));
  }

  @Post('customer-dispatches/:shipmentId/replan')
  replan(@CurrentActor() actor: Actor, @Param('shipmentId') id: string, @Req() request: FastifyRequest): Promise<Shipment> {
    return this.dispatch.replan(actor, id, parseBody(replanCustomerDispatchRequestSchema, request.body), opts(request));
  }

  @Post('customer-dispatches/:shipmentId/address-confirmations')
  confirm(@CurrentActor() actor: Actor, @Param('shipmentId') id: string, @Req() request: FastifyRequest): Promise<Shipment> {
    return this.dispatch.recordAddressConfirmation(actor, id, parseBody(recordAddressConfirmationRequestSchema, request.body), opts(request));
  }

  @Post('customer-dispatches/:shipmentId/submit')
  submit(@CurrentActor() actor: Actor, @Param('shipmentId') id: string, @Req() request: FastifyRequest): Promise<Shipment> {
    return this.dispatch.submit(actor, id, parseBody(shipmentVersionRequestSchema, request.body), opts(request));
  }

  @Post('customer-dispatches/:shipmentId/overrides')
  override(@CurrentActor() actor: Actor, @Param('shipmentId') id: string, @Req() request: FastifyRequest): Promise<Shipment> {
    return this.dispatch.requestOverride(actor, id, parseBody(requestDispatchOverrideRequestSchema, request.body), opts(request));
  }

  @Post('customer-dispatches/:shipmentId/release')
  release(@CurrentActor() actor: Actor, @Param('shipmentId') id: string, @Req() request: FastifyRequest): Promise<Shipment> {
    return this.dispatch.release(actor, id, parseBody(shipmentVersionRequestSchema, request.body), opts(request));
  }

  @RateLimit('export')
  @Get('customer-dispatches/:shipmentId/label')
  async label(@CurrentActor() actor: Actor, @Param('shipmentId') id: string): Promise<RenderedDocument> {
    const delivery = await this.dispatch.customerView(actor, id);
    return renderShippingLabels(delivery, await this.consignor(id));
  }

  @RateLimit('export')
  @Get('customer-dispatches/:shipmentId/delivery-note')
  async deliveryNote(@CurrentActor() actor: Actor, @Param('shipmentId') id: string): Promise<RenderedDocument> {
    const delivery = await this.dispatch.customerView(actor, id);
    return renderDeliveryNote(delivery, await this.consignor(id), (await this.repo.acceptancePolicy()).warrantyStatement);
  }

  @RateLimit('export')
  @Get('customer-dispatches/:shipmentId/conformity')
  async conformity(@CurrentActor() actor: Actor, @Param('shipmentId') id: string): Promise<RenderedDocument> {
    const delivery = await this.dispatch.customerView(actor, id);
    return renderConformityCertificate(delivery, await this.deliveries.conformity((await this.repo.find(id))!), await this.consignor(id));
  }

  /** JobWork's hub city, from the frozen origin once released. */
  private async consignor(shipmentId: string): Promise<{ name: 'JobWork'; city: string }> {
    const s = await this.repo.find(shipmentId);
    const origin = s?.originSnapshot ?? (s?.originSiteId ? await this.repo.site(s.originSiteId) : null);
    return { name: 'JobWork', city: origin?.city ?? '' };
  }
}

/** The customer's deliveries: track, confirm the address, and keep the delivery note. */
@Controller()
export class CustomerDeliveriesController {
  constructor(
    private readonly deliveries: CustomerDeliveries,
    private readonly dispatch: CustomerDispatchCommand,
    private readonly repo: LogisticsRepository,
  ) {}

  @Get('orders/:orderId/deliveries')
  list(@CurrentActor() actor: Actor, @Param('orderId') orderId: string): Promise<CustomerDelivery[]> {
    return this.deliveries.list(actor, parseBody(z.uuid(), orderId));
  }

  @Get('orders/:orderId/documents')
  documents(@CurrentActor() actor: Actor, @Param('orderId') orderId: string): Promise<CustomerOrderDocument[]> {
    return this.deliveries.documents(actor, parseBody(z.uuid(), orderId));
  }

  @RateLimit('export')
  @Get('deliveries/:shipmentId/conformity')
  async conformity(@CurrentActor() actor: Actor, @Param('shipmentId') id: string): Promise<RenderedDocument> {
    const delivery = await this.deliveries.get(actor, parseBody(z.uuid(), id));
    const s = (await this.repo.find(delivery.shipmentId))!;
    const origin = s.originSnapshot ?? (s.originSiteId ? await this.repo.site(s.originSiteId) : null);
    return renderConformityCertificate(delivery, await this.deliveries.conformity(s), { name: 'JobWork', city: origin?.city ?? '' });
  }

  @Get('deliveries/:shipmentId')
  get(@CurrentActor() actor: Actor, @Param('shipmentId') id: string): Promise<CustomerDelivery> {
    return this.deliveries.get(actor, parseBody(z.uuid(), id));
  }

  @Post('deliveries/:shipmentId/confirm-address')
  confirmAddress(@CurrentActor() actor: Actor, @Param('shipmentId') id: string, @Req() request: FastifyRequest): Promise<CustomerDelivery> {
    return this.dispatch.confirmAddress(actor, id, parseBody(confirmDeliveryAddressRequestSchema, request.body), opts(request));
  }

  @RateLimit('export')
  @Get('deliveries/:shipmentId/delivery-note')
  async deliveryNote(@CurrentActor() actor: Actor, @Param('shipmentId') id: string): Promise<RenderedDocument> {
    const delivery = await this.deliveries.get(actor, parseBody(z.uuid(), id));
    const s = await this.repo.find(delivery.shipmentId);
    const origin = s?.originSnapshot ?? (s?.originSiteId ? await this.repo.site(s.originSiteId) : null);
    return renderDeliveryNote(delivery, { name: 'JobWork', city: origin?.city ?? '' }, (await this.repo.acceptancePolicy()).warrantyStatement);
  }
}
