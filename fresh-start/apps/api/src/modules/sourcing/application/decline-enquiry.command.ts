import { Injectable } from '@nestjs/common';
import type { DeclineEnquiryRequest, Enquiry } from '@jobwork/contracts';
import { type Actor, requireTransactionalStrength } from '../../iam';
import { assertMayTriage } from '../domain/enquiry-policy';
import { EnquiryNotFound, assertTransition, assertVersion } from '../domain/enquiry';
import { EnquiryRepository } from '../infrastructure/enquiry.repository';
import { contextFromActor } from '../../../platform/commands/command';
import { CommandExecutor } from '../../../platform/commands/execute';

/**
 * decline-enquiry (doc 06 §3). A reason is required by the schema and again by a
 * database CHECK: a customer who is turned away is owed a sentence they can act on,
 * and "closed" with no explanation is not an outcome this system can record.
 */
@Injectable()
export class DeclineEnquiryCommand {
  constructor(
    private readonly repo: EnquiryRepository,
    private readonly executor: CommandExecutor,
  ) {}

  async execute(
    actor: Actor,
    enquiryId: string,
    input: DeclineEnquiryRequest,
    opts: { idempotencyKey?: string | undefined } = {},
  ): Promise<Enquiry> {
    requireTransactionalStrength(actor);
    assertMayTriage(actor);

    const ctx = contextFromActor({ userId: actor.userId, organizationId: actor.organizationId });
    return this.executor.execute(
      {
        operation: 'sourcing.decline-enquiry',
        handler: async (tx, _ctx, cmd: DeclineEnquiryRequest) => {
          const enquiry = await this.repo.findForUpdate(enquiryId, tx);
          if (!enquiry) throw new EnquiryNotFound();
          assertVersion(cmd.expectedVersion, enquiry.aggregateVersion);
          assertTransition(enquiry.status, 'closed');

          await this.repo.transition(
            enquiryId,
            'closed',
            { decidedBy: actor.userId, decisionReason: cmd.reason },
            tx,
          );
          const closed = (await this.repo.find(enquiryId, tx))!;

          return {
            result: closed,
            audit: [
              {
                action: 'sourcing.enquiry_declined',
                subjectType: 'enquiry',
                subjectId: enquiryId,
                subjectVersion: closed.aggregateVersion,
                reason: cmd.reason,
                data: { previousStatus: enquiry.status },
              },
            ],
            outbox: [
              {
                eventType: 'sourcing.enquiry_declined',
                aggregateType: 'enquiry',
                aggregateId: enquiryId,
                aggregateVersion: closed.aggregateVersion,
                data: { customerOrganizationId: closed.customerOrganizationId },
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
