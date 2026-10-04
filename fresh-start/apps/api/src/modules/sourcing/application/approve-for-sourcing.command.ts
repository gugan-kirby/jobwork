import { Injectable } from '@nestjs/common';
import type { ApproveForSourcingRequest, Enquiry } from '@jobwork/contracts';
import { type Actor, requireTransactionalStrength } from '../../iam';
import { assertMayTriage } from '../domain/enquiry-policy';
import { EnquiryNotFound, assertTransition, assertVersion } from '../domain/enquiry';
import { assertReadyForSourcing, evaluateCompleteness } from '../domain/completeness';
import { requirementSnapshot } from './enquiry-snapshot';
import { EnquiryRepository } from '../infrastructure/enquiry.repository';
import { contextFromActor } from '../../../platform/commands/command';
import { CommandExecutor } from '../../../platform/commands/execute';
import { DomainError } from '../../../platform/http/domain-error';

class GoverningDocumentNotLinked extends DomainError {
  constructor() {
    super(
      'GOVERNING_DOCUMENT_NOT_LINKED',
      409,
      'That document is not attached to this enquiry',
      'The governing document has to be one of the enquiry’s own attachments.',
    );
  }
}

/**
 * approve-for-sourcing (`FR-303`, doc 06 §3). The gate between "a customer asked
 * something" and "suppliers are about to spend time on it".
 *
 * The completeness checklist is evaluated here, not trusted from the UI, and any
 * blocking flag refuses the command — including the doc 19 §3 CAD/2D conflict, which
 * clears only when a reviewer *declares* which document governs. The approved
 * requirement is frozen as its own reviewed revision so the RFQ cites one exact text.
 */
@Injectable()
export class ApproveForSourcingCommand {
  constructor(
    private readonly repo: EnquiryRepository,
    private readonly executor: CommandExecutor,
  ) {}

  async execute(
    actor: Actor,
    enquiryId: string,
    input: ApproveForSourcingRequest,
    opts: { idempotencyKey?: string | undefined } = {},
  ): Promise<Enquiry> {
    requireTransactionalStrength(actor);
    assertMayTriage(actor);

    const ctx = contextFromActor({ userId: actor.userId, organizationId: actor.organizationId });
    return this.executor.execute(
      {
        operation: 'sourcing.approve-for-sourcing',
        handler: async (tx, _ctx, cmd: ApproveForSourcingRequest) => {
          const enquiry = await this.repo.findForUpdate(enquiryId, tx);
          if (!enquiry) throw new EnquiryNotFound();
          assertVersion(cmd.expectedVersion, enquiry.aggregateVersion);
          assertTransition(enquiry.status, 'approved_for_sourcing');

          if (cmd.governingDocumentVersionId) {
            const linked = await this.repo.setGoverningDocument(
              enquiryId,
              cmd.governingDocumentVersionId,
              tx,
            );
            if (!linked) throw new GoverningDocumentNotLinked();
          }

          const current = (await this.repo.find(enquiryId, tx))!;
          const types = await this.repo.documentTypes(enquiryId, tx);
          assertReadyForSourcing(evaluateCompleteness(current, types));

          const revision = await this.repo.freezeRequirement(
            {
              enquiryId,
              kind: 'reviewed',
              frozenBy: actor.userId,
              snapshot: {
                ...requirementSnapshot(current),
                approvedForSourcing: true,
                ...(cmd.note ? { reviewerNote: cmd.note } : {}),
              },
            },
            tx,
          );
          await this.repo.transition(
            enquiryId,
            'approved_for_sourcing',
            { decidedBy: actor.userId, currentRevisionNo: revision.revisionNo },
            tx,
          );

          const approved = (await this.repo.find(enquiryId, tx))!;
          return {
            result: approved,
            audit: [
              {
                action: 'sourcing.enquiry_approved_for_sourcing',
                subjectType: 'enquiry',
                subjectId: enquiryId,
                subjectVersion: approved.aggregateVersion,
                data: {
                  revisionNo: revision.revisionNo,
                  contentHash: revision.contentHash,
                  governingDocumentDeclared: Boolean(cmd.governingDocumentVersionId),
                },
              },
            ],
            outbox: [
              {
                eventType: 'sourcing.enquiry_approved_for_sourcing',
                aggregateType: 'enquiry',
                aggregateId: enquiryId,
                aggregateVersion: approved.aggregateVersion,
                data: {
                  revisionNo: revision.revisionNo,
                  customerOrganizationId: approved.customerOrganizationId,
                  itemCount: approved.items.length,
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

export { GoverningDocumentNotLinked };
