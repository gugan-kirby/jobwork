import { Injectable } from '@nestjs/common';
import type { SubmitVerificationRequest, VerificationItem } from '@jobwork/contracts';
import { type Actor, requireOrganization, requireTransactionalStrength } from '../../iam';
import { NotAuthorized } from '../../iam/domain/errors';
import { EvidenceNotUsable } from '../domain/verification';
import { assertMayMaintainProfile } from '../domain/supplier-policy';
import { SupplierRepository } from '../infrastructure/supplier.repository';
import { toVerificationItem } from './verification-view';
import { contextFromActor } from '../../../platform/commands/command';
import { CommandExecutor } from '../../../platform/commands/execute';

/**
 * submit-verification (`FR-105`, doc 06 §14). The supplier submits one evidence item;
 * a resubmission after a return, or a renewal after expiry, appends a new version
 * rather than reopening the settled one — so what was true when an RFQ ran stays
 * readable forever.
 */
@Injectable()
export class SubmitVerificationCommand {
  constructor(
    private readonly repo: SupplierRepository,
    private readonly executor: CommandExecutor,
  ) {}

  async execute(
    actor: Actor,
    input: SubmitVerificationRequest,
    opts: { idempotencyKey?: string | undefined } = {},
  ): Promise<VerificationItem> {
    requireTransactionalStrength(actor);
    const organizationId = requireOrganization(actor);
    if (actor.organizationType !== 'supplier') {
      throw new NotAuthorized('Only a supplier organization submits verification evidence');
    }
    assertMayMaintainProfile(actor);

    // Evidence has to be a document this organization owns and the scanner cleared;
    // a quarantined or still-processing file cannot back a verification (`BR-ENG-08`).
    if (input.evidenceDocumentVersionId) {
      const usable = await this.repo.evidenceUsable(
        input.evidenceDocumentVersionId,
        organizationId,
      );
      if (!usable.usable) throw new EvidenceNotUsable(usable.reason);
    }

    const ctx = contextFromActor({ userId: actor.userId, organizationId });
    return this.executor.execute(
      {
        operation: 'supplier.submit-verification',
        handler: async (tx, _ctx, cmd: SubmitVerificationRequest) => {
          const profile = await this.repo.ensureProfile(
            { organizationId, createdBy: actor.userId },
            tx,
          );
          const previous = await this.repo.findLatestVerification(profile.id, cmd.kind, tx);

          // An item already waiting on a reviewer is not resubmitted into a queue twice.
          if (previous && ['submitted', 'under_review'].includes(previous.status)) {
            return { result: toVerificationItem(previous), audit: [] };
          }

          const item = await this.repo.appendVerificationItem(
            {
              supplierProfileId: profile.id,
              kind: cmd.kind,
              versionNo: (previous?.versionNo ?? 0) + 1,
              referenceValue: cmd.referenceValue ?? null,
              evidenceDocumentVersionId: cmd.evidenceDocumentVersionId ?? null,
              expiresAt: cmd.expiresAt ? new Date(cmd.expiresAt) : null,
              submittedBy: actor.userId,
              supersedesId: previous?.id ?? null,
            },
            tx,
          );

          return {
            result: toVerificationItem(item),
            audit: [
              {
                action: 'supplier.verification_submitted',
                subjectType: 'verification_item',
                subjectId: item.id,
                subjectVersion: item.versionNo,
                data: {
                  supplierProfileId: profile.id,
                  kind: cmd.kind,
                  hasEvidence: Boolean(cmd.evidenceDocumentVersionId),
                  expiresAt: cmd.expiresAt ?? null,
                },
              },
            ],
            outbox: [
              {
                eventType: 'supplier.verification_submitted',
                aggregateType: 'verification_item',
                aggregateId: item.id,
                aggregateVersion: item.versionNo,
                data: { supplierProfileId: profile.id, kind: cmd.kind },
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
