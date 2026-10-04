import { Injectable } from '@nestjs/common';
import type {
  DeclareWorksSiteRequest,
  SupplierSelfView,
  UpdateSupplierProfileRequest,
} from '@jobwork/contracts';
import { type Actor, requireOrganization, requireTransactionalStrength } from '../../iam';
import { NotAuthorized } from '../../iam/domain/errors';
import { VersionConflict } from '../../../platform/http/domain-error';
import { assertMayMaintainProfile } from '../domain/supplier-policy';
import { SupplierRepository } from '../infrastructure/supplier.repository';
import { SupplierView } from './supplier-view';
import { contextFromActor } from '../../../platform/commands/command';
import { CommandExecutor } from '../../../platform/commands/execute';

/**
 * The supplier describing itself (F-SO.3): identity, contact and the address it makes
 * from. Everything here is the supplier's own claim — none of it is evidence, and none
 * of it moves the network state. `expectedVersion` is carried so two people editing one
 * profile end in a conversation rather than a silent overwrite.
 */
@Injectable()
export class UpdateSupplierProfileCommand {
  constructor(
    private readonly repo: SupplierRepository,
    private readonly view: SupplierView,
    private readonly executor: CommandExecutor,
  ) {}

  private async requireOwnProfile(actor: Actor): Promise<{
    organizationId: string;
    profileId: string;
  }> {
    requireTransactionalStrength(actor);
    const organizationId = requireOrganization(actor);
    if (actor.organizationType !== 'supplier') {
      throw new NotAuthorized('Only a supplier organization maintains a supplier profile');
    }
    assertMayMaintainProfile(actor);
    const profile = await this.repo.findProfileByOrganization(organizationId);
    if (!profile) throw new NotAuthorized('This organization has no supplier profile');
    return { organizationId, profileId: profile.id };
  }

  async updateProfile(
    actor: Actor,
    input: UpdateSupplierProfileRequest,
    opts: { idempotencyKey?: string | undefined } = {},
  ): Promise<SupplierSelfView> {
    const { organizationId, profileId } = await this.requireOwnProfile(actor);

    return this.executor.execute(
      {
        operation: 'supplier.update-profile',
        handler: async (tx, _ctx, cmd: UpdateSupplierProfileRequest) => {
          const updated = await this.repo.updateProfileDetails(
            {
              profileId,
              expectedVersion: cmd.expectedVersion,
              tradeName: cmd.tradeName,
              website: cmd.website,
              summary: cmd.summary,
              regionClass: cmd.regionClass,
              yearEstablished: cmd.yearEstablished,
              employeeBand: cmd.employeeBand,
              primaryContactName: cmd.primaryContactName,
              primaryContactEmail: cmd.primaryContactEmail,
              primaryContactPhone: cmd.primaryContactPhone,
            },
            tx,
          );
          if (!updated) throw new VersionConflict();

          return {
            result: await this.view.selfView(updated),
            audit: [
              {
                action: 'supplier.profile_updated',
                subjectType: 'supplier_profile',
                subjectId: profileId,
                subjectVersion: updated.aggregateVersion,
                data: { regionClass: cmd.regionClass },
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

  async declareWorksSite(
    actor: Actor,
    input: DeclareWorksSiteRequest,
    opts: { idempotencyKey?: string | undefined } = {},
  ): Promise<SupplierSelfView> {
    const { organizationId, profileId } = await this.requireOwnProfile(actor);

    return this.executor.execute(
      {
        operation: 'supplier.declare-works-site',
        handler: async (tx, _ctx, cmd: DeclareWorksSiteRequest) => {
          const current = await this.repo.findProfile(profileId, tx);
          if (!current) throw new NotAuthorized('This organization has no supplier profile');

          const siteId = await this.repo.upsertWorksSite(
            {
              profileId,
              organizationId,
              label: cmd.label,
              addressLine1: cmd.addressLine1,
              addressLine2: cmd.addressLine2,
              city: cmd.city,
              state: cmd.state,
              postalCode: cmd.postalCode,
              gstin: cmd.gstin ?? null,
              contactName: cmd.contactName,
              contactPhone: cmd.contactPhone,
              createdBy: actor.userId,
              existingSiteId: current.worksSiteId,
            },
            tx,
          );
          const updated = await this.repo.findProfile(profileId, tx);
          if (!updated) throw new NotAuthorized('This organization has no supplier profile');

          return {
            result: await this.view.selfView(updated),
            audit: [
              {
                action: 'supplier.works_site_declared',
                subjectType: 'supplier_profile',
                subjectId: profileId,
                subjectVersion: updated.aggregateVersion,
                // The address itself is not audit payload: it is internal detail about
                // a supplier, and the audit trail is read by more people than the file.
                data: { siteId, city: cmd.city, state: cmd.state },
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
