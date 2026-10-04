import { Injectable } from '@nestjs/common';
import type { ReviewVerificationRequest, VerificationItem } from '@jobwork/contracts';
import { type Actor, requireOrganization, requireTransactionalStrength } from '../../iam';
import { assertMayReview } from '../domain/supplier-policy';
import {
  assertTransition,
  SelfReviewRejected,
  VerificationItemNotFound,
} from '../domain/verification';
import { SupplierRepository } from '../infrastructure/supplier.repository';
import { toVerificationItem } from './verification-view';
import { contextFromActor } from '../../../platform/commands/command';
import { CommandExecutor } from '../../../platform/commands/execute';

/**
 * review-verification (doc 06 §14). A JobWork reviewer either verifies an item or
 * returns it with a reason the supplier can act on. The submitter can never be the
 * reviewer — checked here, and again by a database constraint, because a self-verified
 * supplier is exactly the failure this whole lifecycle exists to prevent (doc 03 §5).
 */
@Injectable()
export class ReviewVerificationCommand {
  constructor(
    private readonly repo: SupplierRepository,
    private readonly executor: CommandExecutor,
  ) {}

  async execute(
    actor: Actor,
    verificationItemId: string,
    input: ReviewVerificationRequest,
    opts: { idempotencyKey?: string | undefined } = {},
  ): Promise<VerificationItem> {
    requireTransactionalStrength(actor);
    const organizationId = requireOrganization(actor);
    assertMayReview(actor);

    const ctx = contextFromActor({ userId: actor.userId, organizationId });
    return this.executor.execute(
      {
        operation: 'supplier.review-verification',
        handler: async (tx, _ctx, cmd: ReviewVerificationRequest) => {
          const item = await this.repo.lockVerificationItem(verificationItemId, tx);
          if (!item) throw new VerificationItemNotFound();
          if (item.submittedBy === actor.userId) throw new SelfReviewRejected();

          // Re-deciding a settled item is a no-op, not a second decision.
          const target = cmd.decision === 'verify' ? 'verified' : 'returned_for_evidence';
          if (item.status === target) {
            return { result: toVerificationItem(item), audit: [] };
          }

          // Picking an item up puts it under review first, so the queue shows what is
          // being worked rather than pretending decisions are instantaneous.
          let current = item;
          if (current.status === 'submitted' && target === 'verified') {
            current = await this.repo.setVerificationStatus(
              { id: current.id, status: 'under_review' },
              tx,
            );
          }
          assertTransition(current.status, target);

          const updated = await this.repo.setVerificationStatus(
            {
              id: current.id,
              status: target,
              reviewedBy: actor.userId,
              reviewReason: cmd.reason ?? null,
              expiresAt: cmd.expiresAt ? new Date(cmd.expiresAt) : null,
            },
            tx,
          );

          // Verifying the last mandatory item does not admit the supplier: admission is
          // a decision somebody makes and signs for (F-SO.5), not a side effect of the
          // final tick. The eligibility verdict stays computed either way (FR-202).

          return {
            result: toVerificationItem(updated),
            audit: [
              {
                action:
                  target === 'verified'
                    ? 'supplier.verification_verified'
                    : 'supplier.verification_returned',
                subjectType: 'verification_item',
                subjectId: updated.id,
                subjectVersion: updated.versionNo,
                ...(cmd.reason ? { reason: cmd.reason } : {}),
                data: {
                  supplierProfileId: updated.supplierProfileId,
                  kind: updated.kind,
                  expiresAt: updated.expiresAt ? updated.expiresAt.toISOString() : null,
                },
              },
            ],
            outbox: [
              {
                eventType:
                  target === 'verified'
                    ? 'supplier.verification_verified'
                    : 'supplier.verification_returned',
                aggregateType: 'verification_item',
                aggregateId: updated.id,
                aggregateVersion: updated.versionNo,
                data: {
                  supplierProfileId: updated.supplierProfileId,
                  kind: updated.kind,
                  decision: cmd.decision,
                },
              },
            ],
          };
        },
      },
      ctx,
      input,
      opts,
    );
  }
}
