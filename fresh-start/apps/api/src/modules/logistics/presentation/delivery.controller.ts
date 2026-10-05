import { Controller, Get, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { SCAN_WORKER_PRINCIPAL } from '@jobwork/service-auth';
import {
  acceptDeliveryRequestSchema,
  recordPodRequestSchema,
  recordRefusalRequestSchema,
  reportDeliveryIssueRequestSchema,
  requestAddressChangeRequestSchema,
  resolveDeliveryExceptionRequestSchema,
  withdrawDeliveryIssueRequestSchema,
  type CustomerDelivery,
  type Shipment,
} from '@jobwork/contracts';
import type { Actor } from '../../iam';
import { CurrentActor } from '../../../platform/http/actor.decorator';
import { RateLimit } from '../../../platform/http/rate-limit/rate-limit.decorator';
import { ServiceOnly } from '../../../platform/http/service-principal.guard';
import { parseBody } from '../../../platform/http/validation';
import { CustomerDeliveries } from '../application/customer-deliveries';
import { CustomerDispatchCommand } from '../application/customer-dispatch.command';
import { DeliveryCommand } from '../application/delivery.command';
import { DispatchCommand } from '../application/dispatch.command';
import { LogisticsRepository } from '../infrastructure/logistics.repository';
import { renderProofOfDelivery, type RenderedDocument } from './customer-documents';

function idempotencyKey(request: FastifyRequest): string | undefined {
  const header = request.headers['idempotency-key'];
  return typeof header === 'string' ? header : undefined;
}

const opts = (request: FastifyRequest) => ({ idempotencyKey: idempotencyKey(request) });

/**
 * Leg 2's delivery (IN-17 F-17.3): JobWork records the POD, a refusal and an exception's
 * resolution; the customer accepts, reports, withdraws a report and asks for another address.
 */
@Controller()
export class DeliveryController {
  constructor(
    private readonly delivery: DeliveryCommand,
    private readonly deliveries: CustomerDeliveries,
    private readonly dispatch: DispatchCommand,
    private readonly customerDispatch: CustomerDispatchCommand,
    private readonly repo: LogisticsRepository,
  ) {}

  // ----------------------------------------------------------------- JobWork

  @Post('shipments/:shipmentId/pod')
  pod(@CurrentActor() actor: Actor, @Param('shipmentId') id: string, @Req() request: FastifyRequest): Promise<Shipment> {
    return this.delivery.recordPod(actor, id, parseBody(recordPodRequestSchema, request.body), opts(request));
  }

  @Post('shipments/:shipmentId/refusal')
  refusal(@CurrentActor() actor: Actor, @Param('shipmentId') id: string, @Req() request: FastifyRequest): Promise<Shipment> {
    return this.delivery.recordRefusal(actor, id, parseBody(recordRefusalRequestSchema, request.body), opts(request));
  }

  @Post('delivery-exceptions/:exceptionId/resolve')
  resolve(@CurrentActor() actor: Actor, @Param('exceptionId') id: string, @Req() request: FastifyRequest): Promise<Shipment> {
    return this.delivery.resolveException(actor, parseBody(z.uuid(), id), parseBody(resolveDeliveryExceptionRequestSchema, request.body), opts(request));
  }

  /** Sales or logistics records an address change the customer asked for by phone or mail. */
  @Post('customer-dispatches/:shipmentId/address-change')
  async addressChangeForCustomer(@CurrentActor() actor: Actor, @Param('shipmentId') id: string, @Req() request: FastifyRequest): Promise<Shipment> {
    await this.delivery.requestAddressChange(actor, id, parseBody(requestAddressChangeRequestSchema, request.body), opts(request));
    return this.dispatch.get(actor, id);
  }

  @RateLimit('export')
  @Get('customer-dispatches/:shipmentId/pod')
  async podDocument(@CurrentActor() actor: Actor, @Param('shipmentId') id: string): Promise<RenderedDocument> {
    return renderProofOfDelivery(await this.customerDispatch.customerView(actor, id), await this.consignor(id));
  }

  // ----------------------------------------------------------------- the customer

  @Post('deliveries/:shipmentId/accept')
  accept(@CurrentActor() actor: Actor, @Param('shipmentId') id: string, @Req() request: FastifyRequest): Promise<CustomerDelivery> {
    return this.delivery.accept(actor, parseBody(z.uuid(), id), parseBody(acceptDeliveryRequestSchema, request.body), opts(request));
  }

  @Post('deliveries/:shipmentId/issues')
  report(@CurrentActor() actor: Actor, @Param('shipmentId') id: string, @Req() request: FastifyRequest): Promise<CustomerDelivery> {
    return this.delivery.reportIssue(actor, parseBody(z.uuid(), id), parseBody(reportDeliveryIssueRequestSchema, request.body), opts(request));
  }

  @Post('deliveries/:shipmentId/address-change')
  async addressChange(@CurrentActor() actor: Actor, @Param('shipmentId') id: string, @Req() request: FastifyRequest): Promise<CustomerDelivery> {
    await this.delivery.requestAddressChange(actor, parseBody(z.uuid(), id), parseBody(requestAddressChangeRequestSchema, request.body), opts(request));
    return this.deliveries.get(actor, id);
  }

  @Post('delivery-exceptions/:exceptionId/withdraw')
  withdraw(@CurrentActor() actor: Actor, @Param('exceptionId') id: string, @Req() request: FastifyRequest): Promise<CustomerDelivery> {
    return this.delivery.withdrawIssue(actor, parseBody(z.uuid(), id), parseBody(withdrawDeliveryIssueRequestSchema, request.body ?? {}), opts(request));
  }

  @RateLimit('export')
  @Get('deliveries/:shipmentId/pod')
  async customerPod(@CurrentActor() actor: Actor, @Param('shipmentId') id: string): Promise<RenderedDocument> {
    const delivery = await this.deliveries.get(actor, parseBody(z.uuid(), id));
    return renderProofOfDelivery(delivery, await this.consignor(delivery.shipmentId));
  }

  /** JobWork's hub city, from the frozen origin once released. */
  private async consignor(shipmentId: string): Promise<{ name: 'JobWork'; city: string }> {
    const s = await this.repo.find(shipmentId);
    const origin = s?.originSnapshot ?? (s?.originSiteId ? await this.repo.site(s.originSiteId) : null);
    return { name: 'JobWork', city: origin?.city ?? '' };
  }
}

/** The acceptance window's tick (FR-905), reachable only by the worker's service principal (doc 20 §9). */
@ServiceOnly(SCAN_WORKER_PRINCIPAL.name)
@Controller('internal/deliveries')
export class InternalDeliveriesController {
  constructor(private readonly delivery: DeliveryCommand) {}

  @Post('acceptance-sweep')
  sweep(@CurrentActor() actor: Actor): Promise<{ deemed: number }> {
    return this.delivery.acceptanceSweep({ id: actor.userId });
  }
}
