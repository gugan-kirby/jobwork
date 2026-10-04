import { Injectable } from '@nestjs/common';
import type { Enquiry, SubmitClarificationRequest } from '@jobwork/contracts';
import { type Actor, requireOrganization, requireTransactionalStrength } from '../../iam';
import { assertMayAuthorEnquiry } from '../domain/enquiry-policy';
import {
  ClarificationNotOpen,
  EnquiryNotFound,
  assertTransition,
} from '../domain/enquiry';
import { requirementSnapshot } from './enquiry-snapshot';
import { EnquiryRepository } from '../infrastructure/enquiry.repository';
import { contextFromActor } from '../../../platform/commands/command';
import { CommandExecutor } from '../../../platform/commands/execute';

/**
 * submit-clarification (`FR-303`, UC-04). The customer answers; the enquiry goes back
 * under review.
 *
 * Answering freezes a **reviewed** revision. The intake revision the customer submitted
 * stays exactly as it was — it is never rewritten — and the reviewed revision becomes
 * the one sourcing quotes against, with `supersedes_id` linking the two. So "what did
 * they originally ask for" and "what are we sourcing" are both answerable, which is the
 * whole reason clarification is a separate mechanism from editing.
 */
@Injectable()
export class SubmitClarificationCommand {
  constructor(
    private readonly repo: EnquiryRepository,
    private readonly executor: CommandExecutor,
  ) {}

  async execute(
    actor: Actor,
    enquiryId: string,
    input: SubmitClarificationRequest,
    opts: { idempotencyKey?: string | undefined } = {},
  ): Promise<Enquiry> {
    requireTransactionalStrength(actor);
    const organizationId = requireOrganization(actor);
    assertMayAuthorEnquiry(actor);

    const ctx = contextFromActor({ userId: actor.userId, organizationId });
    return this.executor.execute(
      {
        operation: 'sourcing.submit-clarification',
        handler: async (tx, _ctx, cmd: SubmitClarificationRequest) => {
          const enquiry = await this.repo.findForUpdate(enquiryId, tx);
          if (!enquiry || enquiry.customerOrganizationId !== organizationId) {
            throw new EnquiryNotFound();
          }
          assertTransition(enquiry.status, 'under_review');

          for (const answer of cmd.answers) {
            const answered = await this.repo.answerClarification(
              {
                clarificationId: answer.clarificationId,
                enquiryId,
                answer: answer.answer,
                answerDocumentVersionId: answer.answerDocumentVersionId,
                answeredBy: actor.userId,
              },
              tx,
            );
            if (!answered) throw new ClarificationNotOpen();
          }

          // Re-read so the reviewed revision carries the answers alongside the
          // requirement they qualify.
          const answeredEnquiry = (await this.repo.find(enquiryId, tx))!;
          const revision = await this.repo.freezeRequirement(
            {
              enquiryId,
              kind: 'reviewed',
              frozenBy: actor.userId,
              snapshot: {
                ...requirementSnapshot(answeredEnquiry),
                clarifications: answeredEnquiry.clarifications
                  .filter((c) => c.status === 'answered')
                  .map((c) => ({
                    sequenceNo: c.sequenceNo,
                    roundNo: c.roundNo,
                    topic: c.topic,
                    question: c.question,
                    answer: c.answer,
                    askedAgainstRevisionNo: c.askedAgainstRevisionNo,
                  })),
              },
            },
            tx,
          );
          await this.repo.transition(
            enquiryId,
            'under_review',
            { currentRevisionNo: revision.revisionNo },
            tx,
          );

          const updated = (await this.repo.find(enquiryId, tx))!;
          return {
            result: updated,
            audit: [
              {
                action: 'sourcing.clarification_answered',
                subjectType: 'enquiry',
                subjectId: enquiryId,
                subjectVersion: updated.aggregateVersion,
                data: {
                  answerCount: cmd.answers.length,
                  revisionNo: revision.revisionNo,
                  contentHash: revision.contentHash,
                  // The intake revision is unchanged; state that in the record.
                  submittedRevisionNo: updated.submittedRevisionNo,
                },
              },
            ],
            outbox: [
              {
                eventType: 'sourcing.clarification_answered',
                aggregateType: 'enquiry',
                aggregateId: enquiryId,
                aggregateVersion: updated.aggregateVersion,
                data: { revisionNo: revision.revisionNo, answerCount: cmd.answers.length },
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
