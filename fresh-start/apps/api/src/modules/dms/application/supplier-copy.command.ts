import { Injectable } from '@nestjs/common';
import type { ConfirmSupplierCopyRequest, PrepareSupplierCopyRequest, SupplierCopy } from '@jobwork/contracts';
import { type Actor, requireRole, requireTransactionalStrength } from '../../iam';
import { DocumentNotFound } from '../domain/errors';
import { type SupplierCopyRow, DmsRepository } from '../infrastructure/dms.repository';
import { contextFromActor } from '../../../platform/commands/command';
import { CommandExecutor } from '../../../platform/commands/execute';
import { DomainError } from '../../../platform/http/domain-error';

/** Who prepares and who confirms a supplier copy: the people who send files to suppliers. */
const COPY_ROLES = ['jobwork_engineering', 'jobwork_sourcing'] as const;

export class SupplierCopyRefused extends DomainError {
  constructor(code: string, detail: string, status = 422) {
    super(code, status, 'The supplier copy cannot be recorded', detail);
  }
}

export function supplierCopyOf(row: SupplierCopyRow): SupplierCopy {
  return {
    sourceVersionId: row.sourceVersionId,
    copyVersionId: row.copyVersionId,
    copyFilename: row.copyFilename,
    preparedBy: row.preparedBy,
    preparedAt: row.preparedAt.toISOString(),
    note: row.note,
    confirmed: row.confirmedAt !== null,
    confirmedBy: row.confirmedBy,
    confirmedAt: row.confirmedAt ? row.confirmedAt.toISOString() : null,
    confirmNote: row.confirmNote,
  };
}

/**
 * `FR-305` (F-FP.5): JobWork's reviewed copy of a customer's file. One JobWork member uploads the
 * cleaned file (title block, notes and photos without the customer's identity) and maps it to the
 * customer's version; another confirms it. Only a confirmed copy is ever granted to a supplier —
 * the database refuses a grant of the customer's own version (`0031_supplier_copy.sql`).
 */
@Injectable()
export class SupplierCopyCommand {
  constructor(
    private readonly repo: DmsRepository,
    private readonly executor: CommandExecutor,
  ) {}

  async get(actor: Actor, sourceVersionId: string): Promise<SupplierCopy | null> {
    requireRole(actor, ...COPY_ROLES);
    const row = await this.repo.findSupplierCopy(sourceVersionId);
    return row ? supplierCopyOf(row) : null;
  }

  async prepare(actor: Actor, sourceVersionId: string, input: PrepareSupplierCopyRequest, opts: { idempotencyKey?: string | undefined } = {}): Promise<SupplierCopy> {
    requireRole(actor, ...COPY_ROLES);
    requireTransactionalStrength(actor);
    const [source, copy] = await Promise.all([this.repo.findVersionForRelease(sourceVersionId), this.repo.findVersionForRelease(input.copyVersionId)]);
    if (!source) throw new DocumentNotFound();
    const owners = await this.repo.ownerTypes([sourceVersionId, input.copyVersionId]);
    if (owners.get(sourceVersionId) !== 'customer') throw new SupplierCopyRefused('NOT_A_CUSTOMER_FILE', 'Only a customer’s own file needs a supplier copy.');
    if (!copy || owners.get(input.copyVersionId) !== 'internal') throw new SupplierCopyRefused('COPY_NOT_JOBWORKS', 'The copy is a file JobWork uploaded.');
    if (copy.versionStatus !== 'available' || copy.scanState !== 'clean') throw new SupplierCopyRefused('COPY_NOT_CLEAN', 'The copy has to finish its scan clean before it can stand in for the customer’s file.');

    await this.executor.execute(
      {
        operation: 'dms.prepare-supplier-copy',
        handler: async (tx, _ctx, cmd: PrepareSupplierCopyRequest) => {
          const existing = await this.repo.findSupplierCopy(sourceVersionId, tx, true);
          if (existing?.confirmedAt) throw new SupplierCopyRefused('COPY_CONFIRMED', 'This file already has a confirmed supplier copy; it is kept as confirmed.', 409);
          await this.repo.prepareSupplierCopy({ sourceVersionId, copyVersionId: cmd.copyVersionId, preparedBy: actor.userId, note: cmd.note }, tx);
          return {
            result: undefined,
            audit: [{ action: 'dms.supplier_copy_prepared', subjectType: 'document_version', subjectId: sourceVersionId, data: { copyVersionId: cmd.copyVersionId, replaced: existing?.copyVersionId ?? null } }],
            outbox: [{ eventType: 'dms.supplier_copy_prepared.v1', aggregateType: 'document_version', aggregateId: sourceVersionId, data: { copyVersionId: cmd.copyVersionId } }],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return supplierCopyOf((await this.repo.findSupplierCopy(sourceVersionId))!);
  }

  async confirm(actor: Actor, sourceVersionId: string, input: ConfirmSupplierCopyRequest, opts: { idempotencyKey?: string | undefined } = {}): Promise<SupplierCopy> {
    requireRole(actor, ...COPY_ROLES);
    requireTransactionalStrength(actor);
    await this.executor.execute(
      {
        operation: 'dms.confirm-supplier-copy',
        handler: async (tx, _ctx, cmd: ConfirmSupplierCopyRequest) => {
          const copy = await this.repo.findSupplierCopy(sourceVersionId, tx, true);
          if (!copy) throw new SupplierCopyRefused('NO_SUPPLIER_COPY', 'Prepare the supplier copy first.', 409);
          if (copy.confirmedAt) throw new SupplierCopyRefused('COPY_CONFIRMED', 'This supplier copy is already confirmed.', 409);
          if (copy.preparedBy === actor.userId) throw new SupplierCopyRefused('COPY_FOUR_EYES', 'Someone other than the person who prepared the copy confirms it is clean.', 409);
          await this.repo.confirmSupplierCopy({ sourceVersionId, confirmedBy: actor.userId, note: cmd.note }, tx);
          return {
            result: undefined,
            audit: [{ action: 'dms.supplier_copy_confirmed', subjectType: 'document_version', subjectId: sourceVersionId, reason: cmd.note, data: { copyVersionId: copy.copyVersionId, preparedBy: copy.preparedBy } }],
            outbox: [{ eventType: 'dms.supplier_copy_confirmed.v1', aggregateType: 'document_version', aggregateId: sourceVersionId, data: { copyVersionId: copy.copyVersionId } }],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return supplierCopyOf((await this.repo.findSupplierCopy(sourceVersionId))!);
  }
}
