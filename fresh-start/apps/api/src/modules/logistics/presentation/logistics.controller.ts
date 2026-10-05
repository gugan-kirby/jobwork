import { Controller, Get, HttpCode, Param, Post, Query, Req, type RawBodyRequest } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  cancelShipmentRequestSchema,
  planShipmentRequestSchema,
  recordCarrierEventRequestSchema,
  receiveShipmentRequestSchema,
  recordPickupRequestSchema,
  replanShipmentRequestSchema,
  resolveDiscrepancyRequestSchema,
  shipmentStatusSchema,
  shipmentVersionRequestSchema,
  type Shipment,
  type WorkPackageLogistics,
} from '@jobwork/contracts';
import type { Actor } from '../../iam';
import { CurrentActor } from '../../../platform/http/actor.decorator';
import { ValidationFailed } from '../../../platform/http/domain-error';
import { Public } from '../../../platform/http/public.decorator';
import { RateLimit } from '../../../platform/http/rate-limit/rate-limit.decorator';
import { parseBody } from '../../../platform/http/validation';
import { DispatchCommand } from '../application/dispatch.command';
import { LogisticsView } from '../application/logistics-view';
import { ReceivingCommand } from '../application/receiving.command';

function idempotencyKey(request: FastifyRequest): string | undefined {
  const header = request.headers['idempotency-key'];
  return typeof header === 'string' ? header : undefined;
}

const opts = (request: FastifyRequest) => ({ idempotencyKey: idempotencyKey(request) });

/** The supplier's side of leg 1: plan, submit, hand to the carrier (doc 08 §5 `/shipments`). */
@Controller('supplier/shipments')
export class SupplierShipmentController {
  constructor(private readonly dispatch: DispatchCommand) {}

  @Get()
  list(@CurrentActor() actor: Actor, @Query('workPackageId') workPackageId?: string): Promise<Shipment[]> {
    return this.dispatch.list(actor, workPackageId ? { workPackageId } : {});
  }

  @Post()
  plan(@CurrentActor() actor: Actor, @Req() request: FastifyRequest): Promise<Shipment> {
    return this.dispatch.plan(actor, parseBody(planShipmentRequestSchema, request.body), opts(request));
  }

  @Get(':shipmentId')
  get(@CurrentActor() actor: Actor, @Param('shipmentId') id: string): Promise<Shipment> {
    return this.dispatch.get(actor, id);
  }

  @Post(':shipmentId/replan')
  replan(@CurrentActor() actor: Actor, @Param('shipmentId') id: string, @Req() request: FastifyRequest): Promise<Shipment> {
    return this.dispatch.replan(actor, id, parseBody(replanShipmentRequestSchema, request.body), opts(request));
  }

  @Post(':shipmentId/submit')
  submit(@CurrentActor() actor: Actor, @Param('shipmentId') id: string, @Req() request: FastifyRequest): Promise<Shipment> {
    return this.dispatch.submit(actor, id, parseBody(shipmentVersionRequestSchema, request.body), opts(request));
  }

  @Post(':shipmentId/pickup')
  pickup(@CurrentActor() actor: Actor, @Param('shipmentId') id: string, @Req() request: FastifyRequest): Promise<Shipment> {
    return this.dispatch.recordPickup(actor, id, parseBody(recordPickupRequestSchema, request.body), opts(request));
  }

  @Post(':shipmentId/cancel')
  cancel(@CurrentActor() actor: Actor, @Param('shipmentId') id: string, @Req() request: FastifyRequest): Promise<Shipment> {
    return this.dispatch.cancel(actor, id, parseBody(cancelShipmentRequestSchema, request.body), opts(request));
  }
}

/** JobWork logistics: release, record the carrier, and see every leg. */
@Controller('shipments')
export class ShipmentController {
  constructor(
    private readonly dispatch: DispatchCommand,
    private readonly receiving: ReceivingCommand,
  ) {}

  @Get()
  list(@CurrentActor() actor: Actor, @Query('workPackageId') workPackageId?: string, @Query('salesOrderId') salesOrderId?: string, @Query('status') status?: string): Promise<Shipment[]> {
    const statuses = status ? status.split(',').map((s) => shipmentStatusSchema.parse(s)) : undefined;
    return this.dispatch.list(actor, { ...(workPackageId ? { workPackageId } : {}), ...(salesOrderId ? { salesOrderId } : {}), ...(statuses ? { statuses } : {}) });
  }

  @Get(':shipmentId')
  get(@CurrentActor() actor: Actor, @Param('shipmentId') id: string): Promise<Shipment> {
    return this.dispatch.get(actor, id);
  }

  @Post(':shipmentId/release')
  release(@CurrentActor() actor: Actor, @Param('shipmentId') id: string, @Req() request: FastifyRequest): Promise<Shipment> {
    return this.dispatch.release(actor, id, parseBody(shipmentVersionRequestSchema, request.body), opts(request));
  }

  @Post(':shipmentId/pickup')
  pickup(@CurrentActor() actor: Actor, @Param('shipmentId') id: string, @Req() request: FastifyRequest): Promise<Shipment> {
    return this.dispatch.recordPickup(actor, id, parseBody(recordPickupRequestSchema, request.body), opts(request));
  }

  @Post(':shipmentId/carrier-events')
  carrierEvent(@CurrentActor() actor: Actor, @Param('shipmentId') id: string, @Req() request: FastifyRequest): Promise<Shipment> {
    return this.dispatch.recordCarrierEvent(actor, id, parseBody(recordCarrierEventRequestSchema, request.body), opts(request));
  }

  @Post(':shipmentId/cancel')
  cancel(@CurrentActor() actor: Actor, @Param('shipmentId') id: string, @Req() request: FastifyRequest): Promise<Shipment> {
    return this.dispatch.cancel(actor, id, parseBody(cancelShipmentRequestSchema, request.body), opts(request));
  }

  @Post(':shipmentId/receive')
  receive(@CurrentActor() actor: Actor, @Param('shipmentId') id: string, @Req() request: FastifyRequest): Promise<Shipment> {
    return this.receiving.receive(actor, id, parseBody(receiveShipmentRequestSchema, request.body), opts(request));
  }
}

/** Receiving discrepancies are resolved once each (BR-LOG-04). */
@Controller('receiving-discrepancies')
export class DiscrepancyController {
  constructor(private readonly receiving: ReceivingCommand) {}

  @Post(':discrepancyId/resolve')
  resolve(@CurrentActor() actor: Actor, @Param('discrepancyId') id: string, @Req() request: FastifyRequest): Promise<Shipment> {
    return this.receiving.resolveDiscrepancy(actor, id, parseBody(resolveDiscrepancyRequestSchema, request.body), opts(request));
  }
}

/** JobWork's view of a work package's quantities and stock (doc 19 §8). */
@Controller('logistics')
export class LogisticsViewController {
  constructor(private readonly view: LogisticsView) {}

  @Get('work-packages/:workPackageId')
  workPackage(@CurrentActor() actor: Actor, @Param('workPackageId') id: string): Promise<WorkPackageLogistics> {
    return this.view.workPackage(actor, id);
  }
}

/** A carrier's signed status feed (`T-05`; doc 08 §11). Evidence only: it never receives anything. */
@RateLimit('webhook')
@Public()
@Controller('webhooks/carriers')
export class CarrierWebhookController {
  constructor(private readonly dispatch: DispatchCommand) {}

  @Post(':provider')
  @HttpCode(200)
  receive(@Param('provider') provider: string, @Req() request: RawBodyRequest<FastifyRequest>): Promise<{ outcome: string; reason: string }> {
    if (!request.rawBody) throw new ValidationFailed([{ path: 'body', message: 'A raw request body is required' }]);
    return this.dispatch.ingestWebhook(provider, request.rawBody, request.headers);
  }
}
