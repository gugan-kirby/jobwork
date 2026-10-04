import { Injectable } from '@nestjs/common';
import type { Enquiry, StartTriageRequest } from '@jobwork/contracts';
import { type Actor, requireTransactionalStrength } from '../../iam';
import { assertMayTriage } from '../domain/enquiry-policy';
import { EnquiryNotFound, assertTransition, assertVersion } from '../domain/enquiry';
import { EnquiryRepository } from '../infrastructure/enquiry.repository';
import { contextFromActor } from '../../../platform/commands/command';
import { CommandExecutor } from '../../../platform/commands/execute';

/** start-triage (`FR-303`, doc 14 §6): a named reviewer takes the enquiry off the queue. */
@Injectable()
export class StartTriageCommand {
  constructor(
    private readonly repo: EnquiryRepository,
    private readonly executor: CommandExecutor,
  ) {}

  async execute(
    actor: Actor,
    enquiryId: string,
    input: StartTriageRequest,
    opts: { idempotencyKey?: string | undefined } = {},
  ): Promise<Enquiry> {
    requireTransactionalStrength(actor);
    assertMayTriage(actor);

    const ctx = contextFromActor({ userId: actor.userId, organizationId: actor.organizationId });
    return this.executor.execute(
      {
        operation: 'sourcing.start-triage',
        handler: async (tx, _ctx, cmd: StartTriageRequest) => {
          const enquiry = await this.repo.findForUpdate(enquiryId, tx);
          if (!enquiry) throw new EnquiryNotFound();
          assertVersion(cmd.expectedVersion, enquiry.aggregateVersion);
          assertTransition(enquiry.status, 'under_review');

          await this.repo.transition(enquiryId, 'under_review', {}, tx);
          const updated = (await this.repo.find(enquiryId, tx))!;
          return {
            result: updated,
            audit: [
              {
                action: 'sourcing.triage_started',
                subjectType: 'enquiry',
                subjectId: enquiryId,
                subjectVersion: updated.aggregateVersion,
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
