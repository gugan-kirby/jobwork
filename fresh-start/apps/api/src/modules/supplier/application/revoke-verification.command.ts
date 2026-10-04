import { Injectable } from '@nestjs/common';
import type { RevokeVerificationRequest, VerificationItem } from '@jobwork/contracts';
import { type Actor, requireOrganization, requireTransactionalStrength } from '../../iam';
import { assertMayReview } from '../domain/supplier-policy';
import { assertTransition, VerificationItemNotFound } from '../domain/verification';
import { SupplierRepository } from '../infrastructure/supplier.repository';
import { toVerificationItem } from './verification-view';
import { contextFromActor } from '../../../platform/commands/command';
import { CommandExecutor } from '../../../platform/commands/execute';

/**
 * revoke-verification (doc 06 §14). Revocation takes effect immediately and requires a
 * reason — it is the lever for evidence discovered to be false or withdrawn. Like
 * expiry it changes what happens *next*: the RFQs and awards made while the item was
 * valid keep their history, and the gates at award and release re-check the current
 * state rather than trusting an old verdict (doc 19 §4).
 */
@Injectable()
export class RevokeVerificationCommand {
  constructor(
    private readonly repo: SupplierRepository,
    private readonly executor: CommandExecutor,
  ) {}

  async execute(
    actor: Actor,
    verificationItemId: string,
    input: RevokeVerificationRequest,
    opts: { idempotencyKey?: string | undefined } = {},
  ): Promise<VerificationItem> {
    requireTransactionalStrength(actor);
    const organizationId = requireOrganization(actor);
    assertMayReview(actor);

    const ctx = contextFromActor({ userId: actor.userId, organizationId });
    return this.executor.execute(
      {
        operation: 'supplier.revoke-verification',
        handler: async (tx, _ctx, cmd: RevokeVerificationRequest) => {
          const item = await this.repo.lockVerificationItem(verificationItemId, tx);
          if (!item) throw new VerificationItemNotFound();
          if (item.status === 'revoked') {
            return { result: toVerificationItem(item), audit: [] };
          }
          assertTransition(item.status, 'revoked');

          const updated = await this.repo.setVerificationStatus(
            {
              id: item.id,
              status: 'revoked',
              reviewedBy: actor.userId,
              reviewReason: cmd.reason,
            },
            tx,
          );

          return {
            result: toVerificationItem(updated),
            audit: [
              {
                action: 'supplier.verification_revoked',
                subjectType: 'verification_item',
                subjectId: updated.id,
                subjectVersion: updated.versionNo,
                reason: cmd.reason,
                data: { supplierProfileId: updated.supplierProfileId, kind: updated.kind },
              },
            ],
            outbox: [
              {
                eventType: 'supplier.verification_revoked',
                aggregateType: 'verification_item',
                aggregateId: updated.id,
                aggregateVersion: updated.versionNo,
                data: { supplierProfileId: updated.supplierProfileId, kind: updated.kind },
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
