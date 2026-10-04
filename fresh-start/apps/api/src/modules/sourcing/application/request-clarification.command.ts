import { Injectable } from '@nestjs/common';
import type { Enquiry, RequestClarificationRequest } from '@jobwork/contracts';
import { type Actor, requireTransactionalStrength } from '../../iam';
import { assertMayTriage } from '../domain/enquiry-policy';
import { EnquiryNotFound, assertTransition, assertVersion } from '../domain/enquiry';
import { EnquiryRepository } from '../infrastructure/enquiry.repository';
import { contextFromActor } from '../../../platform/commands/command';
import { CommandExecutor } from '../../../platform/commands/execute';

/**
 * request-clarification (`FR-303`).
 *
 * The requirement the customer submitted is **not touched**. Questions are appended as
 * their own rows, each recording the revision it was asked against, so months later it
 * is still readable which version of the requirement a question was about. That is the
 * difference between asking a question and quietly editing what someone asked for.
 */
@Injectable()
export class RequestClarificationCommand {
  constructor(
    private readonly repo: EnquiryRepository,
    private readonly executor: CommandExecutor,
  ) {}

  async execute(
    actor: Actor,
    enquiryId: string,
    input: RequestClarificationRequest,
    opts: { idempotencyKey?: string | undefined } = {},
  ): Promise<Enquiry> {
    requireTransactionalStrength(actor);
    assertMayTriage(actor);

    const ctx = contextFromActor({ userId: actor.userId, organizationId: actor.organizationId });
    return this.executor.execute(
      {
        operation: 'sourcing.request-clarification',
        handler: async (tx, _ctx, cmd: RequestClarificationRequest) => {
          const enquiry = await this.repo.findForUpdate(enquiryId, tx);
          if (!enquiry) throw new EnquiryNotFound();
          assertVersion(cmd.expectedVersion, enquiry.aggregateVersion);
          assertTransition(enquiry.status, 'clarification_required');

          const created = await this.repo.appendClarifications(
            {
              enquiryId,
              askedBy: actor.userId,
              askedAgainstRevisionNo: enquiry.currentRevisionNo ?? 1,
              questions: cmd.questions.map((q) => ({
                topic: q.topic,
                question: q.question,
                ...(q.lineNo !== undefined ? { lineNo: q.lineNo } : {}),
              })),
            },
            tx,
          );
          await this.repo.transition(enquiryId, 'clarification_required', {}, tx);

          const updated = (await this.repo.find(enquiryId, tx))!;
          return {
            result: updated,
            audit: [
              {
                action: 'sourcing.clarification_requested',
                subjectType: 'enquiry',
                subjectId: enquiryId,
                subjectVersion: updated.aggregateVersion,
                data: {
                  roundNo: created[0]?.roundNo ?? 1,
                  questionCount: created.length,
                  askedAgainstRevisionNo: enquiry.currentRevisionNo ?? 1,
                  topics: [...new Set(created.map((c) => c.topic))],
                },
              },
            ],
            outbox: [
              {
                eventType: 'sourcing.clarification_requested',
                aggregateType: 'enquiry',
                aggregateId: enquiryId,
                aggregateVersion: updated.aggregateVersion,
                data: {
                  customerOrganizationId: enquiry.customerOrganizationId,
                  roundNo: created[0]?.roundNo ?? 1,
                  questionCount: created.length,
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
