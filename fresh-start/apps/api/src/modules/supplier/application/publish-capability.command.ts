import { Injectable } from '@nestjs/common';
import type {
  DeclareCapacityRequest,
  Machine,
  PublishCapabilityRequest,
  RegisterMachineRequest,
  SupplierCapability,
  CapacityWindow,
} from '@jobwork/contracts';
import { type Actor, requireOrganization, requireTransactionalStrength } from '../../iam';
import { NotAuthorized } from '../../iam/domain/errors';
import { assertMayMaintainProfile } from '../domain/supplier-policy';
import { CapabilityUnknown } from '../domain/errors';
import { EvidenceNotUsable } from '../domain/verification';
import {
  SupplierRepository,
  type CapacityWindowRow,
  type MachineRow,
  type SupplierCapabilityRow,
} from '../infrastructure/supplier.repository';
import { contextFromActor } from '../../../platform/commands/command';
import { CommandExecutor } from '../../../platform/commands/execute';

/**
 * The supplier's own declarations: what it can do, what it runs, and when it has room
 * (`FR-201`, UC-11).
 *
 * Every publish appends a version and supersedes the previous one. Nothing is edited
 * in place, because an RFQ evaluated against version 2 must still be able to say what
 * version 2 claimed — a corrected declaration is new evidence, not a correction of the
 * record. The database refuses an in-place edit of a settled version as well.
 *
 * Declaring is not proving: none of this makes a supplier eligible on its own, which
 * stays a verification question (`FR-202`).
 */
@Injectable()
export class PublishCapabilityCommand {
  constructor(
    private readonly repo: SupplierRepository,
    private readonly executor: CommandExecutor,
  ) {}

  private async profileFor(actor: Actor): Promise<{ organizationId: string }> {
    requireTransactionalStrength(actor);
    const organizationId = requireOrganization(actor);
    if (actor.organizationType !== 'supplier') {
      throw new NotAuthorized('Only a supplier organization maintains a supplier profile');
    }
    assertMayMaintainProfile(actor);
    return { organizationId };
  }

  async publishCapability(
    actor: Actor,
    input: PublishCapabilityRequest,
    opts: { idempotencyKey?: string | undefined } = {},
  ): Promise<SupplierCapability> {
    const { organizationId } = await this.profileFor(actor);

    if (input.evidenceDocumentVersionId) {
      const usable = await this.repo.evidenceUsable(
        input.evidenceDocumentVersionId,
        organizationId,
      );
      if (!usable.usable) throw new EvidenceNotUsable(usable.reason);
    }

    return this.executor.execute(
      {
        operation: 'supplier.publish-capability',
        handler: async (tx, _ctx, cmd: PublishCapabilityRequest) => {
          const capability = await this.repo.findCapabilityByCode(cmd.capabilityCode, tx);
          if (!capability || capability.status !== 'active') {
            throw new CapabilityUnknown(cmd.capabilityCode);
          }
          const profile = await this.repo.ensureProfile(
            { organizationId, createdBy: actor.userId },
            tx,
          );
          const published = await this.repo.publishCapabilityVersion(
            {
              supplierProfileId: profile.id,
              capabilityId: capability.id,
              attributes: cmd.attributes,
              evidenceDocumentVersionId: cmd.evidenceDocumentVersionId ?? null,
              validUntil: cmd.validUntil ? new Date(cmd.validUntil) : null,
              createdBy: actor.userId,
            },
            tx,
          );

          return {
            result: toCapability(published, capability),
            audit: [
              {
                action: 'supplier.capability_published',
                subjectType: 'supplier_capability',
                subjectId: published.id,
                subjectVersion: published.versionNo,
                data: {
                  supplierProfileId: profile.id,
                  capabilityCode: capability.code,
                  attributes: cmd.attributes,
                },
              },
            ],
            outbox: [
              {
                eventType: 'supplier.capability_published',
                aggregateType: 'supplier_capability',
                aggregateId: published.id,
                aggregateVersion: published.versionNo,
                data: { supplierProfileId: profile.id, capabilityCode: capability.code },
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

  async registerMachine(
    actor: Actor,
    input: RegisterMachineRequest,
    opts: { idempotencyKey?: string | undefined } = {},
  ): Promise<Machine> {
    const { organizationId } = await this.profileFor(actor);

    return this.executor.execute(
      {
        operation: 'supplier.register-machine',
        handler: async (tx, _ctx, cmd: RegisterMachineRequest) => {
          const capability = cmd.capabilityCode
            ? await this.repo.findCapabilityByCode(cmd.capabilityCode, tx)
            : null;
          if (cmd.capabilityCode && (!capability || capability.status !== 'active')) {
            throw new CapabilityUnknown(cmd.capabilityCode);
          }
          const profile = await this.repo.ensureProfile(
            { organizationId, createdBy: actor.userId },
            tx,
          );
          const machine = await this.repo.publishMachineVersion(
            {
              supplierProfileId: profile.id,
              machineKey: cmd.machineKey,
              label: cmd.label,
              capabilityId: capability?.id ?? null,
              quantity: cmd.quantity,
              axes: cmd.axes ?? null,
              envelope: cmd.envelope,
              createdBy: actor.userId,
            },
            tx,
          );

          return {
            result: toMachine(machine),
            audit: [
              {
                action: 'supplier.machine_registered',
                subjectType: 'machine',
                subjectId: machine.id,
                subjectVersion: machine.versionNo,
                data: {
                  supplierProfileId: profile.id,
                  machineKey: cmd.machineKey,
                  envelope: cmd.envelope,
                },
              },
            ],
            outbox: [
              {
                eventType: 'supplier.machine_registered',
                aggregateType: 'machine',
                aggregateId: machine.id,
                aggregateVersion: machine.versionNo,
                data: { supplierProfileId: profile.id, machineKey: cmd.machineKey },
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

  async declareCapacity(
    actor: Actor,
    input: DeclareCapacityRequest,
    opts: { idempotencyKey?: string | undefined } = {},
  ): Promise<CapacityWindow> {
    const { organizationId } = await this.profileFor(actor);

    return this.executor.execute(
      {
        operation: 'supplier.declare-capacity',
        handler: async (tx, _ctx, cmd: DeclareCapacityRequest) => {
          const capability = cmd.capabilityCode
            ? await this.repo.findCapabilityByCode(cmd.capabilityCode, tx)
            : null;
          if (cmd.capabilityCode && (!capability || capability.status !== 'active')) {
            throw new CapabilityUnknown(cmd.capabilityCode);
          }
          const profile = await this.repo.ensureProfile(
            { organizationId, createdBy: actor.userId },
            tx,
          );
          const window = await this.repo.publishCapacityVersion(
            {
              supplierProfileId: profile.id,
              capabilityId: capability?.id ?? null,
              windowStart: cmd.windowStart,
              windowEnd: cmd.windowEnd,
              availableHours: cmd.availableHours ?? null,
              note: cmd.note ?? null,
              createdBy: actor.userId,
            },
            tx,
          );

          return {
            result: toCapacity(window),
            audit: [
              {
                action: 'supplier.capacity_declared',
                subjectType: 'capacity_window',
                subjectId: window.id,
                subjectVersion: window.versionNo,
                data: {
                  supplierProfileId: profile.id,
                  windowStart: cmd.windowStart,
                  windowEnd: cmd.windowEnd,
                  availableHours: cmd.availableHours ?? null,
                },
              },
            ],
            outbox: [
              {
                eventType: 'supplier.capacity_declared',
                aggregateType: 'capacity_window',
                aggregateId: window.id,
                aggregateVersion: window.versionNo,
                data: { supplierProfileId: profile.id },
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

export function toCapability(
  row: SupplierCapabilityRow,
  capability?: { id: string; code: string; kind: string; label: string },
): SupplierCapability {
  return {
    supplierCapabilityId: row.id,
    capability: {
      capabilityId: capability?.id ?? row.capabilityId,
      code: capability?.code ?? row.code,
      kind: (capability?.kind ?? row.kind) as SupplierCapability['capability']['kind'],
      label: capability?.label ?? row.label,
    },
    versionNo: row.versionNo,
    status: row.status,
    attributes: row.attributes,
    validFrom: row.validFrom.toISOString(),
    validUntil: row.validUntil ? row.validUntil.toISOString() : null,
  };
}

export function toMachine(row: MachineRow): Machine {
  return {
    machineId: row.id,
    machineKey: row.machineKey,
    label: row.label,
    versionNo: row.versionNo,
    status: row.status,
    quantity: row.quantity,
    axes: row.axes,
    envelope: row.envelope,
    capability: row.capability
      ? {
          capabilityId: row.capability.capabilityId,
          code: row.capability.code,
          kind: row.capability.kind as Machine['capability'] extends null
            ? never
            : 'process' | 'material' | 'finish',
          label: row.capability.label,
        }
      : null,
  };
}

export function toCapacity(row: CapacityWindowRow): CapacityWindow {
  return {
    capacityWindowId: row.id,
    versionNo: row.versionNo,
    status: row.status,
    windowStart: row.windowStart,
    windowEnd: row.windowEnd,
    availableHours: row.availableHours,
    note: row.note,
    capability: row.capability
      ? {
          capabilityId: row.capability.capabilityId,
          code: row.capability.code,
          kind: row.capability.kind as 'process' | 'material' | 'finish',
          label: row.capability.label,
        }
      : null,
  };
}
