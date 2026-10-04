import { Injectable } from '@nestjs/common';
import type {
  DecideLeakageReviewRequest,
  ExternalAudience,
  LeakageReviewDetail,
  LeakageReviewListItem,
} from '@jobwork/contracts';
import { type Actor, requireRole, requireTransactionalStrength } from '../../iam';
import { NotAuthorized } from '../../iam/domain/errors';
import { DETECTOR_VERSION, redact } from '../domain/leakage';
import {
  LeakageReviewNotFound,
  RedactionStillFlagged,
  ReviewAlreadyDecided,
  SelfReview,
} from '../domain/errors';
import { CommunicationRepository, type ReviewRecord } from '../infrastructure/communication.repository';
import { ContextResolver, type ResolvedContext } from '../infrastructure/context.resolver';
import { LeakageGate } from './leakage-gate';
import { contextFromActor, type OutboxSpec } from '../../../platform/commands/command';
import { CommandExecutor } from '../../../platform/commands/execute';
import { VersionConflict } from '../../../platform/http/domain-error';

/** Who reviews held messages. Not sales: the person closing a deal is not its leak check. */
export const REVIEWER_ROLES = ['jobwork_support', 'jobwork_sourcing'];

type Opts = { idempotencyKey?: string | undefined };

/** Outbox payload for a message becoming readable; F-10.3 turns it into notifications. */
export function messageEvent(
  eventType: string,
  m: { id: string; conversationId: string; audience: string; counterpartOrganizationId: string | null; authorParty: string },
  context: { type: string; id: string },
  extra: Record<string, unknown> = {},
): OutboxSpec {
  return {
    eventType,
    aggregateType: 'message',
    aggregateId: m.id,
    data: {
      messageId: m.id,
      conversationId: m.conversationId,
      contextType: context.type,
      contextId: context.id,
      audience: m.audience,
      counterpartOrganizationId: m.counterpartOrganizationId,
      authorParty: m.authorParty,
      ...extra,
    },
  };
}

/**
 * Human review of held messages (`FR-1002`, doc 07 §12, UC-40): release as written,
 * release a redacted copy (the original is kept, superseded, with lineage), or reject.
 * Nothing a person wrote is edited in place, and nobody reviews their own message.
 */
@Injectable()
export class LeakageReviews {
  constructor(
    private readonly repo: CommunicationRepository,
    private readonly contexts: ContextResolver,
    private readonly gate: LeakageGate,
    private readonly executor: CommandExecutor,
  ) {}

  private requireReviewer(actor: Actor): void {
    if (!actor.isInternal) throw new NotAuthorized('JobWork only');
    requireRole(actor, ...REVIEWER_ROLES);
  }

  private readerLabel(audience: ExternalAudience, review: ReviewRecord, context: ResolvedContext | null): string {
    if (audience === 'shared_technical') return 'every invited supplier';
    if (audience === 'supplier') return `${review.message.counterpartName ?? 'a supplier'} (supplier)`;
    return `${context?.customerName ?? 'the customer'} (customer)`;
  }

  private async summary(review: ReviewRecord): Promise<{ item: LeakageReviewListItem; context: ResolvedContext | null }> {
    const m = review.message;
    const context = await this.contexts.resolve(m.contextType, m.contextId);
    const audience = m.audience as ExternalAudience;
    return {
      context,
      item: {
        reviewId: review.id,
        status: review.status,
        action: review.action,
        createdAt: review.createdAt.toISOString(),
        context: { type: m.contextType, id: m.contextId, label: context?.label ?? m.contextType },
        audience,
        readerLabel: this.readerLabel(audience, review, context),
        authorName: m.authorName,
        findingCount: review.findings.length,
        href: context?.links.internal ?? '/',
      },
    };
  }

  async list(actor: Actor, status: 'open' | 'decided'): Promise<LeakageReviewListItem[]> {
    this.requireReviewer(actor);
    const reviews = await this.repo.reviews(status);
    return Promise.all(reviews.map(async (r) => (await this.summary(r)).item));
  }

  async detail(actor: Actor, reviewId: string): Promise<LeakageReviewDetail> {
    this.requireReviewer(actor);
    const review = await this.repo.review(reviewId);
    if (!review || review.action !== 'quarantine') throw new LeakageReviewNotFound();
    const { item } = await this.summary(review);
    const ownMessage = review.message.authorUserId === actor.userId;
    const decided = review.status !== 'open';
    return {
      ...item,
      messageId: review.message.id,
      body: review.message.body,
      findings: review.findings,
      suggestedRedaction: redact(review.message.body, review.findings),
      aggregateVersion: review.aggregateVersion,
      decidedByName: review.decidedByName,
      decidedAt: review.decidedAt ? review.decidedAt.toISOString() : null,
      decisionReason: review.decisionReason,
      derivedMessageId: review.derivedMessageId,
      canDecide: !decided && !ownMessage,
      cannotDecideReason: decided
        ? 'Already decided.'
        : ownMessage
          ? 'You wrote this message; another reviewer must decide.'
          : null,
    };
  }

  async decide(actor: Actor, reviewId: string, request: DecideLeakageReviewRequest, opts: Opts): Promise<LeakageReviewDetail> {
    this.requireReviewer(actor);
    requireTransactionalStrength(actor);
    await this.executor.execute(
      {
        operation: 'communication.decide-leakage-review',
        handler: async (tx) => {
          const review = await this.repo.review(reviewId, tx, true);
          if (!review || review.action !== 'quarantine') throw new LeakageReviewNotFound();
          if (review.status !== 'open') throw new ReviewAlreadyDecided();
          if (review.aggregateVersion !== request.expectedVersion) throw new VersionConflict();
          const m = review.message;
          if (m.authorUserId === actor.userId) throw new SelfReview();
          const contextRef = { type: m.contextType, id: m.contextId };

          let derivedMessageId: string | null = null;
          const outbox: OutboxSpec[] = [];
          if (request.decision === 'release') {
            await this.repo.setMessageStatus(tx, m.id, 'visible');
            await this.repo.decideReview(tx, review.id, { status: 'released', decidedBy: actor.userId, reason: request.reason, derivedMessageId: null });
            outbox.push(messageEvent('communication.message_released.v1', m, contextRef, { reviewId: review.id }));
          } else if (request.decision === 'release_redacted') {
            const context = await this.contexts.resolve(m.contextType, m.contextId, tx);
            if (!context) throw new LeakageReviewNotFound();
            const body = request.redactedBody!;
            // The reviewer's rewrite goes out under JobWork's name, so it meets JobWork's bar.
            const rescan = await this.gate.check(
              { context, audience: m.audience as ExternalAudience, counterpartOrganizationId: m.counterpartOrganizationId, authorParty: 'internal', body },
              tx,
            );
            if (rescan.action === 'quarantine') throw new RedactionStillFlagged(rescan.findings);
            derivedMessageId = await this.repo.insertMessage(tx, {
              conversationId: m.conversationId,
              audience: m.audience,
              counterpartOrganizationId: m.counterpartOrganizationId,
              authorUserId: actor.userId,
              authorOrganizationId: actor.organizationId!,
              authorParty: 'internal',
              body,
              status: 'visible',
              derivedFromMessageId: m.id,
              derivation: 'redacted',
            });
            if (rescan.action === 'warn') {
              await this.repo.insertReview(tx, { messageId: derivedMessageId, action: 'warn', findings: rescan.findings, detectorVersion: DETECTOR_VERSION });
            }
            await this.repo.setMessageStatus(tx, m.id, 'superseded');
            await this.repo.decideReview(tx, review.id, { status: 'released_redacted', decidedBy: actor.userId, reason: request.reason, derivedMessageId });
            outbox.push(
              messageEvent(
                'communication.message_released.v1',
                { ...m, id: derivedMessageId, authorParty: 'internal' },
                contextRef,
                { reviewId: review.id, derivedFromMessageId: m.id },
              ),
            );
          } else {
            await this.repo.setMessageStatus(tx, m.id, 'rejected');
            await this.repo.decideReview(tx, review.id, { status: 'rejected', decidedBy: actor.userId, reason: request.reason, derivedMessageId: null });
            outbox.push(messageEvent('communication.message_rejected.v1', m, contextRef, { reviewId: review.id, authorUserId: m.authorUserId }));
          }

          return {
            result: { reviewId: review.id },
            audit: [
              {
                action: 'communication.leakage_review.decided',
                subjectType: 'leakage_review',
                subjectId: review.id,
                subjectVersion: review.aggregateVersion + 1,
                reason: request.reason,
                data: { decision: request.decision, messageId: m.id, derivedMessageId, findingKinds: [...new Set(review.findings.map((f) => f.kind))] },
              },
            ],
            outbox,
          };
        },
      },
      contextFromActor(actor),
      { reviewId, ...request },
      opts,
    );
    return this.detail(actor, reviewId);
  }
}
