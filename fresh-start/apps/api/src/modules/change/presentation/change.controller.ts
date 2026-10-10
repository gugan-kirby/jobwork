import { Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  changeVersionRequestSchema,
  classifyChangeSchema,
  customerChangeDecisionSchema,
  issueInterimDecisionSchema,
  liftInterimDecisionSchema,
  proposeChangeRequestSchema,
  provideChangeInfoSchema,
  recordImpactSchema,
  requestChangeInfoSchema,
  supplierChangeAcknowledgeSchema,
  supplierImpactSchema,
  verifyChangeSchema,
  withdrawChangeSchema,
  type ChangeRequest,
  type CustomerChange,
  type SupplierChange,
} from '@jobwork/contracts';
import type { Actor } from '../../iam';
import { ChangeCommand } from '../application/change.command';
import { CurrentActor } from '../../../platform/http/actor.decorator';
import { parseBody } from '../../../platform/http/validation';
import { InternalOnly } from '../../../platform/http/public.decorator';

function idempotencyKey(request: FastifyRequest): string | undefined {
  const header = request.headers['idempotency-key'];
  return typeof header === 'string' ? header : undefined;
}

/** JobWork's change desk (IN-13): every step of doc 06 §9, by name. */
@InternalOnly()
@Controller('changes')
export class ChangeController {
  constructor(private readonly changes: ChangeCommand) {}

  @Get()
  list(@CurrentActor() actor: Actor, @Query('salesOrderId') salesOrderId?: string): Promise<ChangeRequest[]> {
    return this.changes.list(actor, salesOrderId ? { salesOrderId } : {});
  }

  @Post()
  propose(@CurrentActor() actor: Actor, @Req() request: FastifyRequest): Promise<{ changeRequestId: string; number: string }> {
    return this.changes.propose(actor, parseBody(proposeChangeRequestSchema, request.body), { idempotencyKey: idempotencyKey(request) });
  }

  @Get(':changeId')
  get(@CurrentActor() actor: Actor, @Param('changeId') changeId: string): Promise<ChangeRequest> {
    return this.changes.get(actor, changeId);
  }

  @Post(':changeId/triage')
  triage(@CurrentActor() actor: Actor, @Param('changeId') changeId: string, @Req() request: FastifyRequest): Promise<ChangeRequest> {
    return this.changes.startTriage(actor, changeId, parseBody(changeVersionRequestSchema, request.body), { idempotencyKey: idempotencyKey(request) });
  }

  @Post(':changeId/request-info')
  requestInfo(@CurrentActor() actor: Actor, @Param('changeId') changeId: string, @Req() request: FastifyRequest): Promise<ChangeRequest> {
    return this.changes.requestInfo(actor, changeId, parseBody(requestChangeInfoSchema, request.body), { idempotencyKey: idempotencyKey(request) });
  }

  @Post(':changeId/provide-info')
  async provideInfo(@CurrentActor() actor: Actor, @Param('changeId') changeId: string, @Req() request: FastifyRequest): Promise<ChangeRequest> {
    await this.changes.provideInfo(actor, changeId, parseBody(provideChangeInfoSchema, request.body), { idempotencyKey: idempotencyKey(request) });
    return this.changes.get(actor, changeId);
  }

  @Post(':changeId/classify')
  classify(@CurrentActor() actor: Actor, @Param('changeId') changeId: string, @Req() request: FastifyRequest): Promise<ChangeRequest> {
    return this.changes.classify(actor, changeId, parseBody(classifyChangeSchema, request.body), { idempotencyKey: idempotencyKey(request) });
  }

  @Post(':changeId/withdraw')
  async withdraw(@CurrentActor() actor: Actor, @Param('changeId') changeId: string, @Req() request: FastifyRequest): Promise<ChangeRequest> {
    await this.changes.withdraw(actor, changeId, parseBody(withdrawChangeSchema, request.body), { idempotencyKey: idempotencyKey(request) });
    return this.changes.get(actor, changeId);
  }

  @Post(':changeId/interim-decisions')
  interim(@CurrentActor() actor: Actor, @Param('changeId') changeId: string, @Req() request: FastifyRequest): Promise<ChangeRequest> {
    return this.changes.issueInterim(actor, changeId, parseBody(issueInterimDecisionSchema, request.body), { idempotencyKey: idempotencyKey(request) });
  }

  @Post(':changeId/interim-decisions/:interimId/lift')
  lift(@CurrentActor() actor: Actor, @Param('changeId') changeId: string, @Param('interimId') interimId: string, @Req() request: FastifyRequest): Promise<ChangeRequest> {
    return this.changes.liftInterim(actor, changeId, interimId, parseBody(liftInterimDecisionSchema, request.body), { idempotencyKey: idempotencyKey(request) });
  }

  @Post(':changeId/impact')
  impact(@CurrentActor() actor: Actor, @Param('changeId') changeId: string, @Req() request: FastifyRequest): Promise<ChangeRequest> {
    return this.changes.recordImpact(actor, changeId, parseBody(recordImpactSchema, request.body), { idempotencyKey: idempotencyKey(request) });
  }

  @Post(':changeId/complete-impact')
  completeImpact(@CurrentActor() actor: Actor, @Param('changeId') changeId: string, @Req() request: FastifyRequest): Promise<ChangeRequest> {
    return this.changes.completeImpact(actor, changeId, parseBody(changeVersionRequestSchema, request.body), { idempotencyKey: idempotencyKey(request) });
  }

  @Post(':changeId/release')
  release(@CurrentActor() actor: Actor, @Param('changeId') changeId: string, @Req() request: FastifyRequest): Promise<ChangeRequest> {
    return this.changes.release(actor, changeId, parseBody(changeVersionRequestSchema, request.body), { idempotencyKey: idempotencyKey(request) });
  }

  @Post(':changeId/verify')
  verify(@CurrentActor() actor: Actor, @Param('changeId') changeId: string, @Req() request: FastifyRequest): Promise<ChangeRequest> {
    return this.changes.verify(actor, changeId, parseBody(verifyChangeSchema, request.body), { idempotencyKey: idempotencyKey(request) });
  }

  @Post(':changeId/close')
  close(@CurrentActor() actor: Actor, @Param('changeId') changeId: string, @Req() request: FastifyRequest): Promise<ChangeRequest> {
    return this.changes.close(actor, changeId, parseBody(changeVersionRequestSchema, request.body), { idempotencyKey: idempotencyKey(request) });
  }
}

/** The customer's side of a change: propose on its order, answer, decide. */
@Controller()
export class CustomerChangeController {
  constructor(private readonly changes: ChangeCommand) {}

  @Get('orders/:orderId/changes')
  list(@CurrentActor() actor: Actor, @Param('orderId') orderId: string): Promise<CustomerChange[]> {
    return this.changes.customerList(actor, orderId);
  }

  @Post('orders/:orderId/changes')
  async propose(@CurrentActor() actor: Actor, @Param('orderId') orderId: string, @Req() request: FastifyRequest): Promise<CustomerChange> {
    const body = parseBody(proposeChangeRequestSchema, { ...(request.body as Record<string, unknown>), salesOrderId: orderId });
    const { origin: _ignored, ...input } = body;
    const created = await this.changes.propose(actor, input, { idempotencyKey: idempotencyKey(request) });
    return this.changes.customerGet(actor, created.changeRequestId);
  }

  @Get('customer/changes/:changeId')
  get(@CurrentActor() actor: Actor, @Param('changeId') changeId: string): Promise<CustomerChange> {
    return this.changes.customerGet(actor, changeId);
  }

  @Post('customer/changes/:changeId/provide-info')
  async provideInfo(@CurrentActor() actor: Actor, @Param('changeId') changeId: string, @Req() request: FastifyRequest): Promise<CustomerChange> {
    await this.changes.provideInfo(actor, changeId, parseBody(provideChangeInfoSchema, request.body), { idempotencyKey: idempotencyKey(request) });
    return this.changes.customerGet(actor, changeId);
  }

  @Post('customer/changes/:changeId/decide')
  decide(@CurrentActor() actor: Actor, @Param('changeId') changeId: string, @Req() request: FastifyRequest): Promise<CustomerChange> {
    return this.changes.customerDecide(actor, changeId, parseBody(customerChangeDecisionSchema, request.body), { idempotencyKey: idempotencyKey(request) });
  }

  @Post('customer/changes/:changeId/withdraw')
  async withdraw(@CurrentActor() actor: Actor, @Param('changeId') changeId: string, @Req() request: FastifyRequest): Promise<CustomerChange> {
    await this.changes.withdraw(actor, changeId, parseBody(withdrawChangeSchema, request.body), { idempotencyKey: idempotencyKey(request) });
    return this.changes.customerGet(actor, changeId);
  }
}

/** The supplier's side: JobWork's brief, its impact estimate, its acknowledgment. */
@Controller('supplier/changes')
export class SupplierChangeController {
  constructor(private readonly changes: ChangeCommand) {}

  @Get()
  list(@CurrentActor() actor: Actor): Promise<SupplierChange[]> {
    return this.changes.supplierList(actor);
  }

  @Get(':changeId')
  get(@CurrentActor() actor: Actor, @Param('changeId') changeId: string): Promise<SupplierChange> {
    return this.changes.supplierGet(actor, changeId);
  }

  @Post(':changeId/impact')
  impact(@CurrentActor() actor: Actor, @Param('changeId') changeId: string, @Req() request: FastifyRequest): Promise<SupplierChange> {
    return this.changes.submitSupplierImpact(actor, changeId, parseBody(supplierImpactSchema, request.body), { idempotencyKey: idempotencyKey(request) });
  }

  @Post(':changeId/acknowledge')
  acknowledge(@CurrentActor() actor: Actor, @Param('changeId') changeId: string, @Req() request: FastifyRequest): Promise<SupplierChange> {
    return this.changes.supplierAcknowledge(actor, changeId, parseBody(supplierChangeAcknowledgeSchema, request.body), { idempotencyKey: idempotencyKey(request) });
  }
}
