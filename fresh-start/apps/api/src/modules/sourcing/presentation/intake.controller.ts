import { Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  approveForSourcingRequestSchema,
  reviseRequirementRequestSchema,
  declineEnquiryRequestSchema,
  requestClarificationRequestSchema,
  startTriageRequestSchema,
  type CompletenessFlag,
  type Enquiry,
  type RequirementRevision,
} from '@jobwork/contracts';
import { z } from 'zod';
import type { Actor } from '../../iam';
import { ApproveForSourcingCommand } from '../application/approve-for-sourcing.command';
import { DeclineEnquiryCommand } from '../application/decline-enquiry.command';
import { RequestClarificationCommand } from '../application/request-clarification.command';
import { StartTriageCommand } from '../application/start-triage.command';
import { evaluateCompleteness } from '../domain/completeness';
import { assertMayTriage } from '../domain/enquiry-policy';
import { EnquiryNotFound } from '../domain/enquiry';
import { EnquiryRepository } from '../infrastructure/enquiry.repository';
import { CurrentActor } from '../../../platform/http/actor.decorator';
import { parseBody } from '../../../platform/http/validation';
import { ReviseRequirementCommand, type RevisedRequirement } from '../application/revise-requirement.command';

const queueQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

function idempotencyKey(request: FastifyRequest): string | undefined {
  const header = request.headers['idempotency-key'];
  return typeof header === 'string' ? header : undefined;
}

/** The operations intake workspace (doc 14 §6): full state, every guard, the checklist. */
@Controller('intake')
export class IntakeController {
  constructor(
    private readonly startTriage: StartTriageCommand,
    private readonly requestClarification: RequestClarificationCommand,
    private readonly approve: ApproveForSourcingCommand,
    private readonly revise: ReviseRequirementCommand,
    private readonly decline: DeclineEnquiryCommand,
    private readonly repo: EnquiryRepository,
  ) {}

  @Get('queue')
  async queue(
    @CurrentActor() actor: Actor,
    @Query() query: unknown,
  ): Promise<{ enquiries: Enquiry[] }> {
    assertMayTriage(actor);
    const { limit } = parseBody(queueQuerySchema, query);
    return { enquiries: await this.repo.listTriageQueue(limit) };
  }

  @Get(':enquiryId')
  async detail(
    @CurrentActor() actor: Actor,
    @Param('enquiryId') enquiryId: string,
  ): Promise<{
    enquiry: Enquiry;
    completeness: CompletenessFlag[];
    revisions: RequirementRevision[];
    documentTypes: Record<string, string>;
  }> {
    assertMayTriage(actor);
    const enquiry = await this.repo.find(enquiryId);
    if (!enquiry) throw new EnquiryNotFound();
    const types = await this.repo.documentTypes(enquiryId);
    return {
      enquiry,
      completeness: evaluateCompleteness(enquiry, types),
      revisions: await this.repo.listRevisions(enquiryId),
      documentTypes: Object.fromEntries(types),
    };
  }

  @Post(':enquiryId/triage')
  async triage(
    @CurrentActor() actor: Actor,
    @Param('enquiryId') enquiryId: string,
    @Req() request: FastifyRequest,
  ): Promise<Enquiry> {
    const body = parseBody(startTriageRequestSchema, request.body);
    return this.startTriage.execute(actor, enquiryId, body, {
      idempotencyKey: idempotencyKey(request),
    });
  }

  @Post(':enquiryId/clarifications')
  async clarify(
    @CurrentActor() actor: Actor,
    @Param('enquiryId') enquiryId: string,
    @Req() request: FastifyRequest,
  ): Promise<Enquiry> {
    const body = parseBody(requestClarificationRequestSchema, request.body);
    return this.requestClarification.execute(actor, enquiryId, body, {
      idempotencyKey: idempotencyKey(request),
    });
  }

  @Post(':enquiryId/approve')
  async approveForSourcing(
    @CurrentActor() actor: Actor,
    @Param('enquiryId') enquiryId: string,
    @Req() request: FastifyRequest,
  ): Promise<Enquiry> {
    const body = parseBody(approveForSourcingRequestSchema, request.body);
    return this.approve.execute(actor, enquiryId, body, {
      idempotencyKey: idempotencyKey(request),
    });
  }

  /** F-12.5: engineering revises the requirement while it is being sourced. */
  @Post(':enquiryId/revise')
  async reviseRequirement(
    @CurrentActor() actor: Actor,
    @Param('enquiryId') enquiryId: string,
    @Req() request: FastifyRequest,
  ): Promise<RevisedRequirement> {
    const body = parseBody(reviseRequirementRequestSchema, request.body);
    return this.revise.execute(actor, enquiryId, body, { idempotencyKey: idempotencyKey(request) });
  }

  @Post(':enquiryId/decline')
  async declineEnquiry(
    @CurrentActor() actor: Actor,
    @Param('enquiryId') enquiryId: string,
    @Req() request: FastifyRequest,
  ): Promise<Enquiry> {
    const body = parseBody(declineEnquiryRequestSchema, request.body);
    return this.decline.execute(actor, enquiryId, body, {
      idempotencyKey: idempotencyKey(request),
    });
  }
}
