import { Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  cancelEnquiryRequestSchema,
  copyEnquiryRequestSchema,
  saveDraftRequestSchema,
  submitClarificationRequestSchema,
  submitEnquiryRequestSchema,
  type CustomerEnquiry,
  type Enquiry,
} from '@jobwork/contracts';
import { z } from 'zod';
import { type Actor, requireOrganization } from '../../iam';
import { CancelEnquiryCommand } from '../application/cancel-enquiry.command';
import { CopyEnquiryCommand } from '../application/copy-enquiry.command';
import { SaveDraftCommand } from '../application/save-draft.command';
import { SubmitClarificationCommand } from '../application/submit-clarification.command';
import { SubmitEnquiryCommand } from '../application/submit-enquiry.command';
import { assertMayAuthorEnquiry } from '../domain/enquiry-policy';
import { EnquiryNotFound } from '../domain/enquiry';
import { EnquiryRepository } from '../infrastructure/enquiry.repository';
import { projectClarifications, projectForCustomer } from './enquiry-projection';
import { CurrentActor } from '../../../platform/http/actor.decorator';
import { parseBody } from '../../../platform/http/validation';

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** Withdrawn work is history, not a to-do: kept, retrievable, out of the way. */
  includeCancelled: z.coerce.boolean().default(false),
});

function idempotencyKey(request: FastifyRequest): string | undefined {
  const header = request.headers['idempotency-key'];
  return typeof header === 'string' ? header : undefined;
}

/**
 * The customer surface. Every read here returns the curated projection; the full
 * `Enquiry` shape is returned only from the write commands, and only to the author's
 * own organization, because the wizard has to render back what it just saved.
 */
@Controller('enquiries')
export class EnquiriesController {
  constructor(
    private readonly saveDraft: SaveDraftCommand,
    private readonly submit: SubmitEnquiryCommand,
    private readonly cancel: CancelEnquiryCommand,
    private readonly copy: CopyEnquiryCommand,
    private readonly answer: SubmitClarificationCommand,
    private readonly repo: EnquiryRepository,
  ) {}

  private async ownedByActor(actor: Actor, enquiryId: string): Promise<Enquiry> {
    const organizationId = requireOrganization(actor);
    const enquiry = await this.repo.find(enquiryId);
    // Absent and not-yours are the same answer on purpose (doc 11 §5).
    if (!enquiry || enquiry.customerOrganizationId !== organizationId) throw new EnquiryNotFound();
    return enquiry;
  }

  @Get()
  async list(
    @CurrentActor() actor: Actor,
    @Query() query: unknown,
  ): Promise<{ enquiries: CustomerEnquiry[] }> {
    assertMayAuthorEnquiry(actor);
    const organizationId = requireOrganization(actor);
    const { limit, includeCancelled } = parseBody(listQuerySchema, query);
    const rows = await this.repo.listForOrganization(organizationId, limit);
    const projected = rows.map(projectForCustomer);
    return {
      enquiries: includeCancelled
        ? projected
        : projected.filter((enquiry) => enquiry.status !== 'cancelled'),
    };
  }

  /** Creating a draft is the same command as saving one; the wizard need not branch. */
  @Post('draft')
  async createDraft(
    @CurrentActor() actor: Actor,
    @Req() request: FastifyRequest,
  ): Promise<Enquiry> {
    const body = parseBody(saveDraftRequestSchema, request.body ?? {});
    return this.saveDraft.execute(actor, null, body, {
      idempotencyKey: idempotencyKey(request),
    });
  }

  @Post(':enquiryId/draft')
  async saveExistingDraft(
    @CurrentActor() actor: Actor,
    @Param('enquiryId') enquiryId: string,
    @Req() request: FastifyRequest,
  ): Promise<Enquiry> {
    const body = parseBody(saveDraftRequestSchema, request.body ?? {});
    return this.saveDraft.execute(actor, enquiryId, body, {
      idempotencyKey: idempotencyKey(request),
    });
  }

  @Post(':enquiryId/submit')
  async submitEnquiry(
    @CurrentActor() actor: Actor,
    @Param('enquiryId') enquiryId: string,
    @Req() request: FastifyRequest,
  ): Promise<Enquiry> {
    const body = parseBody(submitEnquiryRequestSchema, request.body);
    return this.submit.execute(actor, enquiryId, body, {
      idempotencyKey: idempotencyKey(request),
    });
  }

  @Post(':enquiryId/cancel')
  async cancelEnquiry(
    @CurrentActor() actor: Actor,
    @Param('enquiryId') enquiryId: string,
    @Req() request: FastifyRequest,
  ): Promise<Enquiry> {
    const body = parseBody(cancelEnquiryRequestSchema, request.body);
    return this.cancel.execute(actor, enquiryId, body, {
      idempotencyKey: idempotencyKey(request),
    });
  }

  @Post(':enquiryId/copy')
  async copyEnquiry(
    @CurrentActor() actor: Actor,
    @Param('enquiryId') enquiryId: string,
    @Req() request: FastifyRequest,
  ): Promise<Enquiry> {
    const body = parseBody(copyEnquiryRequestSchema, request.body ?? {});
    return this.copy.execute(actor, enquiryId, body, {
      idempotencyKey: idempotencyKey(request),
    });
  }

  @Post(':enquiryId/clarifications')
  async answerClarifications(
    @CurrentActor() actor: Actor,
    @Param('enquiryId') enquiryId: string,
    @Req() request: FastifyRequest,
  ): Promise<Enquiry> {
    const body = parseBody(submitClarificationRequestSchema, request.body);
    return this.answer.execute(actor, enquiryId, body, {
      idempotencyKey: idempotencyKey(request),
    });
  }

  /**
   * The customer's own view. A draft is returned in full — it is their unsubmitted
   * text — but anything past submit comes back only as the curated projection plus
   * their clarification thread.
   */
  @Get(':enquiryId')
  async detail(
    @CurrentActor() actor: Actor,
    @Param('enquiryId') enquiryId: string,
  ): Promise<{
    enquiry: CustomerEnquiry;
    draft: Enquiry | null;
    clarifications: ReturnType<typeof projectClarifications>;
  }> {
    assertMayAuthorEnquiry(actor);
    const enquiry = await this.ownedByActor(actor, enquiryId);
    return {
      enquiry: projectForCustomer(enquiry),
      draft: enquiry.status === 'draft' ? enquiry : null,
      clarifications: projectClarifications(enquiry),
    };
  }
}
