import { Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  closeRfqRequestSchema,
  createRfqRequestSchema,
  inviteSupplierRequestSchema,
  releaseRfqRequestSchema,
  revokeInvitationRequestSchema,
  rfqStatusSchema,
  type MatchResult,
  type Rfq,
} from '@jobwork/contracts';
import type { Actor } from '../../iam';
import { NotAuthorized } from '../../iam/domain/errors';
import { MatchSuppliersQuery } from '../application/match-suppliers.query';
import { RfqLifecycleCommand } from '../application/rfq-lifecycle.command';
import { RfqView } from '../application/rfq-view';
import { RfqNotFound, singleSourceRisk } from '../domain/rfq';
import { RfqRepository } from '../infrastructure/rfq.repository';
import { CurrentActor } from '../../../platform/http/actor.decorator';
import { parseBody } from '../../../platform/http/validation';
import { RateLimit } from '../../../platform/http/rate-limit/rate-limit.decorator';

const listQuerySchema = z.object({ status: rfqStatusSchema.optional() });

function idempotencyKey(request: FastifyRequest): string | undefined {
  const header = request.headers['idempotency-key'];
  return typeof header === 'string' ? header : undefined;
}

/**
 * The RFQ control room (IN-06, internal audience only). Everything on this controller
 * names suppliers and prices, so the first line of every handler establishes that the
 * caller is internal.
 */
@Controller('rfqs')
export class RfqsController {
  constructor(
    private readonly lifecycle: RfqLifecycleCommand,
    private readonly matcher: MatchSuppliersQuery,
    private readonly view: RfqView,
    private readonly repo: RfqRepository,
  ) {}

  private assertInternal(actor: Actor): void {
    if (!actor.isInternal) throw new NotAuthorized('Internal audience only');
  }

  @RateLimit('search')
  @Get('match')
  async match(
    @CurrentActor() actor: Actor,
    @Query() query: unknown,
  ): Promise<MatchResult> {
    this.assertInternal(actor);
    const { enquiryId } = parseBody(z.object({ enquiryId: z.uuid() }), query ?? {});
    return this.matcher.execute(actor, enquiryId);
  }

  @Post()
  async create(
    @CurrentActor() actor: Actor,
    @Req() request: FastifyRequest,
  ): Promise<{ rfqId: string }> {
    this.assertInternal(actor);
    const body = parseBody(createRfqRequestSchema, request.body);
    const created = await this.lifecycle.create(actor, body, {
      idempotencyKey: idempotencyKey(request),
    });
    // The matching that justified this round is recorded with it (`FR-204`).
    await this.lifecycle.recordMatch(actor, body.enquiryId, created.rfqId);
    return created;
  }

  @Get()
  async list(
    @CurrentActor() actor: Actor,
    @Query() query: unknown,
  ): Promise<{ rfqs: Array<Rfq & { singleSourceRisk: boolean }> }> {
    this.assertInternal(actor);
    const { status } = parseBody(listQuerySchema, query ?? {});
    const rows = await this.repo.listRfqs({ status });
    const rfqs = await Promise.all(
      rows.map(async (row) => {
        const view = await this.view.internalView(row);
        const responded = view.invitations.filter((i) => i.status === 'responded').length;
        return {
          ...view,
          singleSourceRisk: singleSourceRisk(responded, view.invitations.length),
        };
      }),
    );
    return { rfqs };
  }

  @Get(':rfqId')
  async detail(
    @CurrentActor() actor: Actor,
    @Param('rfqId') rfqId: string,
  ): Promise<{
    rfq: Rfq;
    singleSourceRisk: boolean;
    bids: Awaited<ReturnType<RfqView['bidsForEvaluation']>>;
  }> {
    this.assertInternal(actor);
    const row = await this.repo.findRfq(rfqId);
    if (!row) throw new RfqNotFound();
    const rfq = await this.view.internalView(row);
    const responded = rfq.invitations.filter((i) => i.status === 'responded').length;
    return {
      rfq,
      singleSourceRisk: singleSourceRisk(responded, rfq.invitations.length),
      bids: await this.view.bidsForEvaluation(rfqId),
    };
  }

  @Post(':rfqId/invitations')
  async invite(
    @CurrentActor() actor: Actor,
    @Param('rfqId') rfqId: string,
    @Req() request: FastifyRequest,
  ): Promise<{ rfqSupplierId: string }> {
    this.assertInternal(actor);
    const body = parseBody(inviteSupplierRequestSchema, request.body);
    return this.lifecycle.invite(actor, rfqId, body, {
      idempotencyKey: idempotencyKey(request),
    });
  }

  @Post(':rfqId/release')
  async release(
    @CurrentActor() actor: Actor,
    @Param('rfqId') rfqId: string,
    @Req() request: FastifyRequest,
  ): Promise<{ rfqId: string; reference: string; invited: number; documents: number }> {
    this.assertInternal(actor);
    const body = parseBody(releaseRfqRequestSchema, request.body);
    return this.lifecycle.release(actor, rfqId, body, {
      idempotencyKey: idempotencyKey(request),
    });
  }

  @Post(':rfqId/invitations/:invitationId/revoke')
  async revoke(
    @CurrentActor() actor: Actor,
    @Param('rfqId') rfqId: string,
    @Param('invitationId') invitationId: string,
    @Req() request: FastifyRequest,
  ): Promise<{ revoked: true; grantsRevoked: number }> {
    this.assertInternal(actor);
    const body = parseBody(revokeInvitationRequestSchema, request.body);
    return this.lifecycle.revokeInvitation(actor, rfqId, invitationId, body, {
      idempotencyKey: idempotencyKey(request),
    });
  }

  @Post(':rfqId/close')
  async close(
    @CurrentActor() actor: Actor,
    @Param('rfqId') rfqId: string,
    @Req() request: FastifyRequest,
  ): Promise<{ status: string; responded: number; reason: string }> {
    this.assertInternal(actor);
    const body = parseBody(closeRfqRequestSchema, request.body);
    return this.lifecycle.close(actor, rfqId, body, {
      idempotencyKey: idempotencyKey(request),
    });
  }
}
