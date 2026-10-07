import { Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  billVersionRequestSchema,
  markSettlementPaidRequestSchema,
  rejectBillRequestSchema,
  requestBillExceptionRequestSchema,
  scheduleSettlementRequestSchema,
  submitSupplierBillRequestSchema,
  supplierBillStatusSchema,
  type SupplierBill,
} from '@jobwork/contracts';
import type { Actor } from '../../iam';
import { CurrentActor } from '../../../platform/http/actor.decorator';
import { parseBody } from '../../../platform/http/validation';
import { SettlementCommand } from '../application/settlement.command';

const opts = (request: FastifyRequest) => {
  const header = request.headers['idempotency-key'];
  return { idempotencyKey: typeof header === 'string' ? header : undefined };
};
const listQuerySchema = z.object({ status: supplierBillStatusSchema.optional(), purchaseOrderId: z.uuid().optional() });

/** The supplier's bills to JobWork and what became of them (UC-31). */
@Controller('supplier/bills')
export class SupplierBillsController {
  constructor(private readonly settlement: SettlementCommand) {}

  @Get()
  list(@CurrentActor() actor: Actor, @Query() query: unknown): Promise<SupplierBill[]> {
    const { status, purchaseOrderId } = parseBody(listQuerySchema, query ?? {});
    return this.settlement.list(actor, { ...(status ? { status } : {}), ...(purchaseOrderId ? { purchaseOrderId } : {}) });
  }

  @Post()
  submit(@CurrentActor() actor: Actor, @Req() request: FastifyRequest): Promise<SupplierBill> {
    return this.settlement.submit(actor, parseBody(submitSupplierBillRequestSchema, request.body), opts(request));
  }

  @Get(':billId')
  get(@CurrentActor() actor: Actor, @Param('billId') id: string): Promise<SupplierBill> {
    return this.settlement.get(actor, parseBody(z.uuid(), id));
  }
}

/** JobWork finance: match, decide exceptions, settle (doc 10 §5; BR-FIN-07). */
@Controller('supplier-bills')
export class FinanceBillsController {
  constructor(private readonly settlement: SettlementCommand) {}

  @Get()
  list(@CurrentActor() actor: Actor, @Query() query: unknown): Promise<SupplierBill[]> {
    const { status, purchaseOrderId } = parseBody(listQuerySchema, query ?? {});
    return this.settlement.list(actor, { ...(status ? { status } : {}), ...(purchaseOrderId ? { purchaseOrderId } : {}) });
  }

  @Get(':billId')
  get(@CurrentActor() actor: Actor, @Param('billId') id: string): Promise<SupplierBill> {
    return this.settlement.get(actor, parseBody(z.uuid(), id));
  }

  @Post(':billId/match')
  match(@CurrentActor() actor: Actor, @Param('billId') id: string, @Req() request: FastifyRequest): Promise<SupplierBill> {
    return this.settlement.match(actor, id, parseBody(billVersionRequestSchema, request.body), opts(request));
  }

  @Post(':billId/exception')
  exception(@CurrentActor() actor: Actor, @Param('billId') id: string, @Req() request: FastifyRequest): Promise<SupplierBill> {
    return this.settlement.requestException(actor, id, parseBody(requestBillExceptionRequestSchema, request.body), opts(request));
  }

  @Post(':billId/reject')
  reject(@CurrentActor() actor: Actor, @Param('billId') id: string, @Req() request: FastifyRequest): Promise<SupplierBill> {
    return this.settlement.reject(actor, id, parseBody(rejectBillRequestSchema, request.body), opts(request));
  }

  @Post(':billId/settlement/recheck')
  recheck(@CurrentActor() actor: Actor, @Param('billId') id: string, @Req() request: FastifyRequest): Promise<SupplierBill> {
    return this.settlement.recheck(actor, id, opts(request));
  }

  @Post(':billId/settlement/schedule')
  schedule(@CurrentActor() actor: Actor, @Param('billId') id: string, @Req() request: FastifyRequest): Promise<SupplierBill> {
    return this.settlement.schedule(actor, id, parseBody(scheduleSettlementRequestSchema, request.body), opts(request));
  }

  @Post(':billId/settlement/pay')
  pay(@CurrentActor() actor: Actor, @Param('billId') id: string, @Req() request: FastifyRequest): Promise<SupplierBill> {
    return this.settlement.markPaid(actor, id, parseBody(markSettlementPaidRequestSchema, request.body), opts(request));
  }
}
