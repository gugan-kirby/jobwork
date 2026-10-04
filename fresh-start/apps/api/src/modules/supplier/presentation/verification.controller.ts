import { Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  reviewVerificationRequestSchema,
  revokeVerificationRequestSchema,
  submitVerificationRequestSchema,
  type ReviewQueueItem,
  type VerificationItem,
} from '@jobwork/contracts';
import { z } from 'zod';
import type { Actor } from '../../iam';
import { requireOrganization } from '../../iam';
import { ReviewVerificationCommand } from '../application/review-verification.command';
import { RevokeVerificationCommand } from '../application/revoke-verification.command';
import { SubmitVerificationCommand } from '../application/submit-verification.command';
import { toVerificationItem } from '../application/verification-view';
import { assertMayReview } from '../domain/supplier-policy';
import { SupplierProfileNotFound } from '../domain/verification';
import { SupplierRepository } from '../infrastructure/supplier.repository';
import { CurrentActor } from '../../../platform/http/actor.decorator';
import { parseBody } from '../../../platform/http/validation';

const queueQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

function idempotencyKey(request: FastifyRequest): string | undefined {
  const header = request.headers['idempotency-key'];
  return typeof header === 'string' ? header : undefined;
}

@Controller('suppliers')
export class VerificationController {
  constructor(
    private readonly submit: SubmitVerificationCommand,
    private readonly review: ReviewVerificationCommand,
    private readonly revoke: RevokeVerificationCommand,
    private readonly repo: SupplierRepository,
  ) {}

  /** Supplier side: submit or renew one evidence item. */
  @Post('me/verification')
  async submitVerification(
    @CurrentActor() actor: Actor,
    @Req() request: FastifyRequest,
  ): Promise<VerificationItem> {
    const body = parseBody(submitVerificationRequestSchema, request.body);
    return this.submit.execute(actor, body, { idempotencyKey: idempotencyKey(request) });
  }

  /** Supplier side: the supplier's own verification history, newest version first. */
  @Get('me/verification')
  async myVerification(@CurrentActor() actor: Actor): Promise<{ items: VerificationItem[] }> {
    const organizationId = requireOrganization(actor);
    const profile = await this.repo.findProfileByOrganization(organizationId);
    if (!profile) return { items: [] };
    const items = await this.repo.listVerificationItems(profile.id);
    return { items: items.map(toVerificationItem) };
  }

  /** Operations side: what is waiting on a reviewer. */
  @Get('verification/queue')
  async queue(
    @CurrentActor() actor: Actor,
    @Query() query: unknown,
  ): Promise<{ items: ReviewQueueItem[] }> {
    assertMayReview(actor);
    const { limit } = parseBody(queueQuerySchema, query);
    const rows = await this.repo.listReviewQueue(limit);
    return {
      items: rows.map((row) => ({
        ...toVerificationItem(row),
        organizationId: row.organizationId,
        organizationName: row.organizationName,
        submittedAt: row.submittedAt ? row.submittedAt.toISOString() : null,
      })),
    };
  }

  @Post('verification/:verificationItemId/review')
  async reviewItem(
    @CurrentActor() actor: Actor,
    @Param('verificationItemId') verificationItemId: string,
    @Req() request: FastifyRequest,
  ): Promise<VerificationItem> {
    const body = parseBody(reviewVerificationRequestSchema, request.body);
    return this.review.execute(actor, verificationItemId, body, {
      idempotencyKey: idempotencyKey(request),
    });
  }

  @Post('verification/:verificationItemId/revoke')
  async revokeItem(
    @CurrentActor() actor: Actor,
    @Param('verificationItemId') verificationItemId: string,
    @Req() request: FastifyRequest,
  ): Promise<VerificationItem> {
    const body = parseBody(revokeVerificationRequestSchema, request.body);
    return this.revoke.execute(actor, verificationItemId, body, {
      idempotencyKey: idempotencyKey(request),
    });
  }

  /** Operations side: one supplier's full verification history. */
  @Get(':supplierProfileId/verification')
  async supplierVerification(
    @CurrentActor() actor: Actor,
    @Param('supplierProfileId') supplierProfileId: string,
  ): Promise<{ items: VerificationItem[] }> {
    assertMayReview(actor);
    const profile = await this.repo.findProfile(supplierProfileId);
    if (!profile) throw new SupplierProfileNotFound();
    const items = await this.repo.listVerificationItems(profile.id);
    return { items: items.map(toVerificationItem) };
  }
}
