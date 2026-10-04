import { Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  decideLeakageReviewRequestSchema,
  type LeakageReviewDetail,
  type LeakageReviewListItem,
} from '@jobwork/contracts';
import type { Actor } from '../../iam';
import { LeakageReviews } from '../application/leakage-review.command';
import { CurrentActor } from '../../../platform/http/actor.decorator';
import { parseBody } from '../../../platform/http/validation';

function idempotencyKey(request: FastifyRequest): string | undefined {
  const header = request.headers['idempotency-key'];
  return typeof header === 'string' ? header : undefined;
}

/** The held-message queue (F-10.4): JobWork reviewers only. */
@Controller('leakage-reviews')
export class LeakageReviewsController {
  constructor(private readonly reviews: LeakageReviews) {}

  @Get()
  async list(@CurrentActor() actor: Actor, @Query('status') status?: string): Promise<{ reviews: LeakageReviewListItem[] }> {
    return { reviews: await this.reviews.list(actor, status === 'decided' ? 'decided' : 'open') };
  }

  @Get(':reviewId')
  detail(@CurrentActor() actor: Actor, @Param('reviewId') reviewId: string): Promise<LeakageReviewDetail> {
    return this.reviews.detail(actor, reviewId);
  }

  @Post(':reviewId/decide')
  decide(@CurrentActor() actor: Actor, @Param('reviewId') reviewId: string, @Req() request: FastifyRequest): Promise<LeakageReviewDetail> {
    return this.reviews.decide(actor, reviewId, parseBody(decideLeakageReviewRequestSchema, request.body), { idempotencyKey: idempotencyKey(request) });
  }
}
