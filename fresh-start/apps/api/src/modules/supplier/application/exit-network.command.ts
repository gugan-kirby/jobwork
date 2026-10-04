import { Injectable } from '@nestjs/common';
import type { ExitNetworkRequest, SupplierSelfView } from '@jobwork/contracts';
import { type Actor, requireOrganization, requireTransactionalStrength } from '../../iam';
import { NotAuthorized } from '../../iam/domain/errors';
import { DomainError } from '../../../platform/http/domain-error';
import { SupplierNotFound, SupplierStateRejected } from '../domain/errors';
import { assertMayDecideAdmission, assertMayMaintainProfile } from '../domain/supplier-policy';
import { SupplierRepository } from '../infrastructure/supplier.repository';
import { SupplierView } from './supplier-view';
import { contextFromActor } from '../../../platform/commands/command';
import { CommandExecutor } from '../../../platform/commands/execute';

class ConfirmationMismatch extends DomainError {
  constructor(expected: string) {
    super(
      'CONFIRMATION_MISMATCH',
      422,
      'That is not the name of this organization',
      `Type “${expected}” exactly to confirm leaving the network.`,
    );
  }
}

/**
 * exit-network (F-SN.1). Leaving is terminal, so it is typed rather than clicked: the
 * supplier confirms with its own display name, the way an irreversible thing should be
 * confirmed, and JobWork's own offboarding carries a reason instead.
 *
 * Nothing is deleted. Every declaration, every verified item and every award made while
 * the supplier was in the network stays exactly as it was — leaving changes what happens
 * next, not what happened.
 */
@Injectable()
export class ExitNetworkCommand {
  constructor(
    private readonly repo: SupplierRepository,
    private readonly view: SupplierView,
    private readonly executor: CommandExecutor,
  ) {}

  async bySupplier(
    actor: Actor,
    input: ExitNetworkRequest,
    opts: { idempotencyKey?: string | undefined } = {},
  ): Promise<SupplierSelfView> {
    requireTransactionalStrength(actor);
    const organizationId = requireOrganization(actor);
    if (actor.organizationType !== 'supplier') {
      throw new NotAuthorized('Only a supplier leaves on its own behalf');
    }
    assertMayMaintainProfile(actor);
    const profile = await this.repo.findProfileByOrganization(organizationId);
    if (!profile) throw new SupplierNotFound();
    if (input.confirmation.trim().toLowerCase() !== profile.displayName.trim().toLowerCase()) {
      throw new ConfirmationMismatch(profile.displayName);
    }
    return this.exit(actor, profile.id, organizationId, 'supplier', input.reason, opts);
  }

  async byJobWork(
    actor: Actor,
    supplierProfileId: string,
    input: ExitNetworkRequest,
    opts: { idempotencyKey?: string | undefined } = {},
  ): Promise<SupplierSelfView> {
    requireTransactionalStrength(actor);
    assertMayDecideAdmission(actor);
    const profile = await this.repo.findProfile(supplierProfileId);
    if (!profile) throw new SupplierNotFound();
    if (input.confirmation.trim().toLowerCase() !== profile.displayName.trim().toLowerCase()) {
      throw new ConfirmationMismatch(profile.displayName);
    }
    return this.exit(
      actor,
      profile.id,
      profile.organizationId,
      'jobwork',
      input.reason,
      opts,
    );
  }

  private async exit(
    actor: Actor,
    profileId: string,
    organizationId: string,
    initiatedBy: 'supplier' | 'jobwork',
    reason: string,
    opts: { idempotencyKey?: string | undefined },
  ): Promise<SupplierSelfView> {
    return this.executor.execute(
      {
        operation: 'supplier.exit-network',
        handler: async (tx, _ctx) => {
          const current = await this.repo.findProfile(profileId, tx);
          if (!current) throw new SupplierNotFound();
          if (current.status === 'exited') throw new SupplierStateRejected('exited', 'exited');

          const updated = await this.repo.exitNetwork(profileId, tx);
          if (!updated) throw new SupplierNotFound();

          return {
            result: await this.view.selfView(updated),
            audit: [
              {
                action: 'supplier.exited',
                subjectType: 'supplier_profile',
                subjectId: profileId,
                subjectVersion: updated.aggregateVersion,
                ...(reason ? { reason } : {}),
                data: { organizationId, initiatedBy, previousStatus: current.status },
              },
            ],
            outbox: [
              {
                eventType: 'supplier.exited.v1',
                aggregateType: 'supplier_profile',
                aggregateId: profileId,
                aggregateVersion: updated.aggregateVersion,
                data: { organizationId, initiatedBy },
              },
            ],
          };
        },
      },
      contextFromActor(actor.organizationId ? actor : { ...actor, organizationId }),
      { reason, initiatedBy },
      opts,
    );
  }
}
