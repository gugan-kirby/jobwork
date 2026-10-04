import { Injectable } from '@nestjs/common';
import type { SetAvailabilityRequest, SupplierSelfView } from '@jobwork/contracts';
import { type Actor, requireOrganization, requireTransactionalStrength } from '../../iam';
import { NotAuthorized } from '../../iam/domain/errors';
import { SupplierNotFound, SupplierStateRejected } from '../domain/errors';
import { assertMayMaintainProfile } from '../domain/supplier-policy';
import { SupplierRepository } from '../infrastructure/supplier.repository';
import { SupplierView } from './supplier-view';
import { contextFromActor } from '../../../platform/commands/command';
import { CommandExecutor } from '../../../platform/commands/execute';

/**
 * set-availability (F-SN.1). The supplier's own statement that it can or cannot take
 * work in the next few weeks.
 *
 * Deliberately not the network status: a shop that is full is not a shop JobWork
 * stopped, and recording the two in one field would make every full order book look
 * like a suspension in the audit trail. Nobody reviews this — it is the supplier's to
 * say, and it takes effect immediately.
 */
@Injectable()
export class SetAvailabilityCommand {
  constructor(
    private readonly repo: SupplierRepository,
    private readonly view: SupplierView,
    private readonly executor: CommandExecutor,
  ) {}

  async execute(
    actor: Actor,
    input: SetAvailabilityRequest,
    opts: { idempotencyKey?: string | undefined } = {},
  ): Promise<SupplierSelfView> {
    requireTransactionalStrength(actor);
    const organizationId = requireOrganization(actor);
    if (actor.organizationType !== 'supplier') {
      throw new NotAuthorized('Only a supplier sets its own availability');
    }
    assertMayMaintainProfile(actor);

    const profile = await this.repo.findProfileByOrganization(organizationId);
    if (!profile) throw new SupplierNotFound();
    if (profile.status === 'exited') {
      throw new SupplierStateRejected(profile.status, 'made available again');
    }

    return this.executor.execute(
      {
        operation: 'supplier.set-availability',
        handler: async (tx, _ctx, cmd: SetAvailabilityRequest) => {
          const updated = await this.repo.setAvailability(
            {
              profileId: profile.id,
              acceptingWork: cmd.acceptingWork,
              note: cmd.note,
              acceptingWorkUntil: cmd.acceptingWorkUntil ?? null,
            },
            tx,
          );
          if (!updated) throw new SupplierNotFound();

          return {
            result: await this.view.selfView(updated),
            audit: [
              {
                action: cmd.acceptingWork
                  ? 'supplier.availability_resumed'
                  : 'supplier.availability_paused',
                subjectType: 'supplier_profile',
                subjectId: profile.id,
                subjectVersion: updated.aggregateVersion,
                ...(cmd.note ? { reason: cmd.note } : {}),
                data: {
                  organizationId,
                  acceptingWork: cmd.acceptingWork,
                  until: cmd.acceptingWorkUntil ?? null,
                },
              },
            ],
            outbox: [
              {
                eventType: 'supplier.availability_changed.v1',
                aggregateType: 'supplier_profile',
                aggregateId: profile.id,
                aggregateVersion: updated.aggregateVersion,
                data: { organizationId, acceptingWork: cmd.acceptingWork },
              },
            ],
          };
        },
      },
      contextFromActor({ userId: actor.userId, organizationId }),
      input,
      opts,
    );
  }
}
