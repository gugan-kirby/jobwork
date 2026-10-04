import { Injectable } from '@nestjs/common';
import type { SupplierCapability, WithdrawDeclarationRequest } from '@jobwork/contracts';
import { type Actor, requireOrganization, requireTransactionalStrength } from '../../iam';
import { NotAuthorized } from '../../iam/domain/errors';
import { DomainError } from '../../../platform/http/domain-error';
import { SupplierNotFound } from '../domain/errors';
import { assertMayMaintainProfile } from '../domain/supplier-policy';
import { SupplierRepository } from '../infrastructure/supplier.repository';
import { contextFromActor } from '../../../platform/commands/command';
import { CommandExecutor } from '../../../platform/commands/execute';

export type DeclarationKind = 'capability' | 'machine' | 'capacity';

const TABLES: Record<DeclarationKind, 'supplier_capability' | 'machine' | 'capacity_window'> = {
  capability: 'supplier_capability',
  machine: 'machine',
  capacity: 'capacity_window',
};

class DeclarationNotLive extends DomainError {
  constructor(kind: DeclarationKind) {
    super(
      'DECLARATION_NOT_LIVE',
      409,
      `That ${kind} is not the live one`,
      'It has already been superseded or withdrawn. Reload to see what is current.',
    );
  }
}

/**
 * withdraw-declaration (F-SN.3). A supplier stops offering something.
 *
 * The row is marked `withdrawn`, never deleted: an RFQ that matched against version 2
 * must still be able to read exactly what version 2 said (UC-11). Withdrawal therefore
 * changes what the supplier is matched for tomorrow, and nothing about yesterday.
 */
@Injectable()
export class WithdrawDeclarationCommand {
  constructor(
    private readonly repo: SupplierRepository,
    private readonly executor: CommandExecutor,
  ) {}

  async execute(
    actor: Actor,
    kind: DeclarationKind,
    declarationId: string,
    input: WithdrawDeclarationRequest,
    opts: { idempotencyKey?: string | undefined } = {},
  ): Promise<{ withdrawn: true; kind: DeclarationKind; declarationId: string }> {
    requireTransactionalStrength(actor);
    const organizationId = requireOrganization(actor);
    if (actor.organizationType !== 'supplier') {
      throw new NotAuthorized('Only a supplier withdraws its own declarations');
    }
    assertMayMaintainProfile(actor);

    const profile = await this.repo.findProfileByOrganization(organizationId);
    if (!profile) throw new SupplierNotFound();

    return this.executor.execute(
      {
        operation: `supplier.withdraw-${kind}`,
        handler: async (tx, _ctx, cmd: WithdrawDeclarationRequest) => {
          const withdrawn = await this.repo.withdrawDeclaration(
            TABLES[kind],
            { id: declarationId, supplierProfileId: profile.id },
            tx,
          );
          if (!withdrawn) throw new DeclarationNotLive(kind);

          return {
            result: { withdrawn: true as const, kind, declarationId },
            audit: [
              {
                action: `supplier.${kind}_withdrawn`,
                subjectType: kind === 'capability' ? 'supplier_capability' : kind,
                subjectId: declarationId,
                ...(cmd.reason ? { reason: cmd.reason } : {}),
                data: { supplierProfileId: profile.id, organizationId },
              },
            ],
            outbox: [
              {
                eventType: 'supplier.declaration_withdrawn.v1',
                aggregateType: 'supplier_profile',
                aggregateId: profile.id,
                data: { kind, declarationId, organizationId },
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

  /** The live declarations a withdraw can name, for the page that offers the action. */
  async liveCapabilities(actor: Actor): Promise<SupplierCapability[]> {
    const organizationId = requireOrganization(actor);
    const profile = await this.repo.findProfileByOrganization(organizationId);
    if (!profile) throw new SupplierNotFound();
    const rows = await this.repo.listSupplierCapabilities(profile.id, false);
    return rows.map((row) => ({
      supplierCapabilityId: row.id,
      capability: { capabilityId: row.capabilityId, code: row.code, kind: row.kind, label: row.label },
      versionNo: row.versionNo,
      status: row.status,
      attributes: row.attributes,
      validFrom: row.validFrom.toISOString(),
      validUntil: row.validUntil ? row.validUntil.toISOString() : null,
    }));
  }
}
