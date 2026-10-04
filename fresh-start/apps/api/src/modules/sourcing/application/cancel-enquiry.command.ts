import { Injectable } from '@nestjs/common';
import type { CancelEnquiryRequest, Enquiry } from '@jobwork/contracts';
import { type Actor, requireOrganization, requireTransactionalStrength } from '../../iam';
import { assertMayAuthorEnquiry } from '../domain/enquiry-policy';
import { EnquiryNotFound, assertTransition, assertVersion } from '../domain/enquiry';
import { EnquiryRepository } from '../infrastructure/enquiry.repository';
import { contextFromActor } from '../../../platform/commands/command';
import { CommandExecutor } from '../../../platform/commands/execute';

/**
 * cancel-enquiry (doc 06 §3). Only before sourcing: once suppliers have been asked to
 * spend time on it, withdrawing is a different, compensating conversation and not this
 * command — the state machine refuses it rather than this code apologising for it.
 */
@Injectable()
export class CancelEnquiryCommand {
  constructor(
    private readonly repo: EnquiryRepository,
    private readonly executor: CommandExecutor,
  ) {}

  async execute(
    actor: Actor,
    enquiryId: string,
    input: CancelEnquiryRequest,
    opts: { idempotencyKey?: string | undefined } = {},
  ): Promise<Enquiry> {
    requireTransactionalStrength(actor);
    const organizationId = requireOrganization(actor);
    assertMayAuthorEnquiry(actor);

    const ctx = contextFromActor({ userId: actor.userId, organizationId });
    return this.executor.execute(
      {
        operation: 'sourcing.cancel-enquiry',
        handler: async (tx, _ctx, cmd: CancelEnquiryRequest) => {
          const enquiry = await this.repo.findForUpdate(enquiryId, tx);
          if (!enquiry || enquiry.customerOrganizationId !== organizationId) {
            throw new EnquiryNotFound();
          }
          assertVersion(cmd.expectedVersion, enquiry.aggregateVersion);
          assertTransition(enquiry.status, 'cancelled');

          await this.repo.transition(
            enquiryId,
            'cancelled',
            { decidedBy: actor.userId, decisionReason: cmd.reason },
            tx,
          );
          const cancelled = (await this.repo.find(enquiryId, tx))!;

          return {
            result: cancelled,
            audit: [
              {
                action: 'sourcing.enquiry_cancelled',
                subjectType: 'enquiry',
                subjectId: enquiryId,
                subjectVersion: cancelled.aggregateVersion,
                reason: cmd.reason,
                data: { previousStatus: enquiry.status },
              },
            ],
            outbox: [
              {
                eventType: 'sourcing.enquiry_cancelled',
                aggregateType: 'enquiry',
                aggregateId: enquiryId,
                aggregateVersion: cancelled.aggregateVersion,
                data: { previousStatus: enquiry.status },
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
