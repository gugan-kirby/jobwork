import { Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  addCaseEventRequestSchema,
  caseReasonRequestSchema,
  caseVersionRequestSchema,
  executeActionRequestSchema,
  openCaseRequestSchema,
  proposeResolutionRequestSchema,
  verifyActionRequestSchema,
  type CustomerCase,
  type SupportCase,
} from '@jobwork/contracts';
import type { Actor } from '../../iam';
import { CurrentActor } from '../../../platform/http/actor.decorator';
import { parseBody } from '../../../platform/http/validation';
import { CaseCommand } from '../application/case.command';

const opts = (request: FastifyRequest) => {
  const header = request.headers['idempotency-key'];
  return { idempotencyKey: typeof header === 'string' ? header : undefined };
};

/** The customer's cases (UC-09 onward, UC-34): open, follow, add, withdraw. */
@Controller('support/cases')
export class CustomerCasesController {
  constructor(private readonly cases: CaseCommand) {}

  @Get()
  list(@CurrentActor() actor: Actor, @Query() query: unknown): Promise<CustomerCase[]> {
    const { orderId } = parseBody(z.object({ orderId: z.uuid().optional() }), query ?? {});
    return this.cases.customerList(actor, orderId);
  }

  @Post()
  async open(@CurrentActor() actor: Actor, @Req() request: FastifyRequest): Promise<CustomerCase> {
    const { caseId } = await this.cases.open(actor, parseBody(openCaseRequestSchema, request.body), opts(request));
    return this.cases.customerGet(actor, caseId);
  }

  @Get(':caseId')
  get(@CurrentActor() actor: Actor, @Param('caseId') id: string): Promise<CustomerCase> {
    return this.cases.customerGet(actor, parseBody(z.uuid(), id));
  }

  @Post(':caseId/events')
  async event(@CurrentActor() actor: Actor, @Param('caseId') id: string, @Req() request: FastifyRequest): Promise<CustomerCase> {
    await this.cases.addEvent(actor, id, parseBody(addCaseEventRequestSchema, request.body), opts(request));
    return this.cases.customerGet(actor, id);
  }

  @Post(':caseId/withdraw')
  withdraw(@CurrentActor() actor: Actor, @Param('caseId') id: string, @Req() request: FastifyRequest): Promise<CustomerCase> {
    return this.cases.withdraw(actor, id, parseBody(caseReasonRequestSchema, request.body), opts(request));
  }
}

/** JobWork's case center (doc 06 §15). */
@Controller()
export class CasesController {
  constructor(private readonly cases: CaseCommand) {}

  @Get('cases')
  list(@CurrentActor() actor: Actor, @Query() query: unknown): Promise<SupportCase[]> {
    const { salesOrderId, open } = parseBody(z.object({ salesOrderId: z.uuid().optional(), open: z.enum(['true', 'false']).optional() }), query ?? {});
    return this.cases.list(actor, { ...(salesOrderId ? { salesOrderId } : {}), ...(open ? { open: open === 'true' } : {}) });
  }

  @Post('cases')
  async open(@CurrentActor() actor: Actor, @Req() request: FastifyRequest): Promise<SupportCase> {
    const { caseId } = await this.cases.open(actor, parseBody(openCaseRequestSchema, request.body), opts(request));
    return this.cases.get(actor, caseId);
  }

  @Get('cases/:caseId')
  get(@CurrentActor() actor: Actor, @Param('caseId') id: string): Promise<SupportCase> {
    return this.cases.get(actor, parseBody(z.uuid(), id));
  }

  @Post('cases/:caseId/triage')
  triage(@CurrentActor() actor: Actor, @Param('caseId') id: string, @Req() request: FastifyRequest): Promise<SupportCase> {
    return this.cases.triage(actor, id, parseBody(caseVersionRequestSchema, request.body), opts(request));
  }

  @Post('cases/:caseId/investigate')
  investigate(@CurrentActor() actor: Actor, @Param('caseId') id: string, @Req() request: FastifyRequest): Promise<SupportCase> {
    return this.cases.investigate(actor, id, parseBody(caseVersionRequestSchema, request.body), opts(request));
  }

  @Post('cases/:caseId/events')
  async event(@CurrentActor() actor: Actor, @Param('caseId') id: string, @Req() request: FastifyRequest): Promise<SupportCase> {
    await this.cases.addEvent(actor, id, parseBody(addCaseEventRequestSchema, request.body), opts(request));
    return this.cases.get(actor, id);
  }

  @Post('cases/:caseId/proposal')
  propose(@CurrentActor() actor: Actor, @Param('caseId') id: string, @Req() request: FastifyRequest): Promise<SupportCase> {
    return this.cases.propose(actor, id, parseBody(proposeResolutionRequestSchema, request.body), opts(request));
  }

  @Post('cases/:caseId/reject')
  reject(@CurrentActor() actor: Actor, @Param('caseId') id: string, @Req() request: FastifyRequest): Promise<SupportCase> {
    return this.cases.reject(actor, id, parseBody(caseReasonRequestSchema, request.body), opts(request));
  }

  @Post('cases/:caseId/close')
  close(@CurrentActor() actor: Actor, @Param('caseId') id: string, @Req() request: FastifyRequest): Promise<SupportCase> {
    return this.cases.close(actor, id, parseBody(caseReasonRequestSchema, request.body), opts(request));
  }

  @Post('case-actions/:actionId/execute')
  execute(@CurrentActor() actor: Actor, @Param('actionId') id: string, @Req() request: FastifyRequest): Promise<SupportCase> {
    return this.cases.execute(actor, parseBody(z.uuid(), id), parseBody(executeActionRequestSchema, request.body), opts(request));
  }

  @Post('case-actions/:actionId/verify')
  verify(@CurrentActor() actor: Actor, @Param('actionId') id: string, @Req() request: FastifyRequest): Promise<SupportCase> {
    return this.cases.verify(actor, parseBody(z.uuid(), id), parseBody(verifyActionRequestSchema, request.body), opts(request));
  }

  @Post('case-actions/:actionId/cancel')
  cancel(@CurrentActor() actor: Actor, @Param('actionId') id: string, @Req() request: FastifyRequest): Promise<SupportCase> {
    return this.cases.cancelAction(actor, parseBody(z.uuid(), id), parseBody(verifyActionRequestSchema, request.body), opts(request));
  }
}
