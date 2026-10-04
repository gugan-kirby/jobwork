import { Injectable } from '@nestjs/common';
import type { Instrument, RecordCalibrationRequest, RegisterInstrumentRequest, RetireInstrumentRequest } from '@jobwork/contracts';
import { type Actor, requireTransactionalStrength } from '../../iam';
import { contextFromActor } from '../../../platform/commands/command';
import { CommandExecutor } from '../../../platform/commands/execute';
import { DomainError } from '../../../platform/http/domain-error';
import { QualityRefused } from '../domain/inspection';
import { type CalibrationRow, type InstrumentRow, QualityRepository } from '../infrastructure/quality.repository';
import { QUALITY, QUALITY_READERS } from './quality-plan.command';

type Opts = { idempotencyKey?: string | undefined };

/** Who looks after a supplier's own measuring equipment (doc 03 §2: supplier quality). */
export const SUPPLIER_INSPECTORS = ['supplier_quality', 'org_admin'];
const SUPPLIER_READERS = ['supplier_quality', 'org_admin', 'supplier_production', 'supplier_estimator'];

/** The calibration standing of an instrument at `at` (BR-QLT-05). */
export function calibrationStanding(calibration: CalibrationRow | null, at: Date): { status: 'valid' | 'expired' | 'uncalibrated'; calibrationId: string | null } {
  if (!calibration || calibration.outcome !== 'pass') return { status: 'uncalibrated', calibrationId: calibration?.id ?? null };
  if (calibration.dueAt.getTime() <= at.getTime()) return { status: 'expired', calibrationId: calibration.id };
  return { status: 'valid', calibrationId: calibration.id };
}

/**
 * Instruments and their calibrations (IN-14 F-14.3; FR-702; BR-QLT-05). Each organization
 * registers and calibrates its own equipment, every calibration with its certificate; an
 * instrument is never edited, only retired.
 */
@Injectable()
export class InstrumentCommand {
  constructor(
    private readonly repo: QualityRepository,
    private readonly executor: CommandExecutor,
  ) {}

  /** The organization whose equipment `actor` may manage. */
  private ownerFor(actor: Actor): string {
    if (actor.isInternal) {
      if (!actor.roles.some((r) => QUALITY.includes(r))) throw new DomainError('NOT_AUTHORIZED', 403, 'Not permitted', 'Requires jobwork_quality.');
      requireTransactionalStrength(actor);
    } else if (actor.organizationType !== 'supplier' || !actor.roles.some((r) => SUPPLIER_INSPECTORS.includes(r))) {
      throw new DomainError('NOT_AUTHORIZED', 403, 'Not permitted', 'Requires supplier quality.');
    }
    if (!actor.organizationId) throw new DomainError('NOT_AUTHORIZED', 403, 'No organization');
    return actor.organizationId;
  }

  async register(actor: Actor, input: RegisterInstrumentRequest, opts: Opts = {}): Promise<Instrument> {
    const owner = this.ownerFor(actor);
    const id = await this.executor.execute(
      {
        operation: 'quality.register-instrument',
        handler: async (tx, _ctx, cmd: RegisterInstrumentRequest) => {
          if (cmd.unit && !(await this.repo.unitCodes(tx)).has(cmd.unit)) throw new QualityRefused('UNKNOWN_UNIT', 'Unknown unit', cmd.unit, 422);
          const instrumentId = await this.repo.insertInstrument({ ownerOrganizationId: owner, ...cmd, by: actor.userId }, tx);
          if (!instrumentId) throw new QualityRefused('ASSET_TAG_TAKEN', 'That asset tag is already registered', cmd.assetTag);
          return {
            result: instrumentId,
            audit: [{ action: 'quality.instrument_registered', subjectType: 'instrument', subjectId: instrumentId, subjectVersion: 1, data: { assetTag: cmd.assetTag, kind: cmd.kind, ownerOrganizationId: owner } }],
            outbox: [
              {
                eventType: 'quality.instrument_registered.v1',
                aggregateType: 'instrument',
                aggregateId: instrumentId,
                aggregateVersion: 1,
                data: { instrumentId, ownerOrganizationId: owner },
              },
            ],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.get(actor, id);
  }

  async recordCalibration(actor: Actor, instrumentId: string, input: RecordCalibrationRequest, opts: Opts = {}): Promise<Instrument> {
    const owner = this.ownerFor(actor);
    await this.executor.execute(
      {
        operation: 'quality.record-calibration',
        handler: async (tx, _ctx, cmd: RecordCalibrationRequest) => {
          const instrument = await this.repo.findInstrument(instrumentId, tx, true);
          if (!instrument || instrument.ownerOrganizationId !== owner) throw new DomainError('INSTRUMENT_NOT_FOUND', 404, 'Instrument not found');
          if (instrument.status !== 'in_service') throw new QualityRefused('INSTRUMENT_RETIRED', 'This instrument is retired');
          const performedAt = new Date(cmd.performedAt);
          const dueAt = new Date(cmd.dueAt);
          if (performedAt.getTime() > Date.now() + 5 * 60_000) throw new QualityRefused('CALIBRATION_IN_FUTURE', 'A calibration is recorded after it is done', undefined, 422);
          if (dueAt <= performedAt) throw new QualityRefused('CALIBRATION_DUE_BEFORE_PERFORMED', 'The next due date must follow the calibration', undefined, 422);
          const certificate = await this.repo.ownCleanVersion(cmd.certificateDocumentVersionId, owner, tx);
          if (!certificate) throw new QualityRefused('CERTIFICATE_UNAVAILABLE', 'Upload the calibration certificate first', 'It must be your own file and scanned clean.', 422);
          const calibrationId = await this.repo.insertCalibration({ instrumentId, performedAt, dueAt, outcome: cmd.outcome, certificateDocumentVersionId: cmd.certificateDocumentVersionId, certificateSha256: certificate.sha256, note: cmd.note, by: actor.userId }, tx);
          const version = instrument.aggregateVersion + 1;
          return {
            result: undefined,
            audit: [{ action: 'quality.calibration_recorded', subjectType: 'instrument', subjectId: instrumentId, subjectVersion: version, data: { calibrationId, outcome: cmd.outcome, performedAt: cmd.performedAt, dueAt: cmd.dueAt, certificateSha256: certificate.sha256 } }],
            outbox: [
              {
                eventType: 'quality.calibration_recorded.v1',
                aggregateType: 'instrument',
                aggregateId: instrumentId,
                aggregateVersion: version,
                data: { instrumentId, calibrationId, outcome: cmd.outcome, dueAt: cmd.dueAt },
              },
            ],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.get(actor, instrumentId);
  }

  async retire(actor: Actor, instrumentId: string, input: RetireInstrumentRequest, opts: Opts = {}): Promise<Instrument> {
    const owner = this.ownerFor(actor);
    await this.executor.execute(
      {
        operation: 'quality.retire-instrument',
        handler: async (tx, _ctx, cmd: RetireInstrumentRequest) => {
          const instrument = await this.repo.findInstrument(instrumentId, tx, true);
          if (!instrument || instrument.ownerOrganizationId !== owner) throw new DomainError('INSTRUMENT_NOT_FOUND', 404, 'Instrument not found');
          if (instrument.aggregateVersion !== cmd.expectedVersion) throw new DomainError('VERSION_CONFLICT', 409, 'The instrument moved on', 'Reload it and try again.');
          if (instrument.status === 'retired') throw new QualityRefused('INSTRUMENT_RETIRED', 'Already retired');
          const version = await this.repo.retireInstrument(instrumentId, tx);
          return {
            result: undefined,
            audit: [{ action: 'quality.instrument_retired', subjectType: 'instrument', subjectId: instrumentId, subjectVersion: version, reason: cmd.reason, data: { assetTag: instrument.assetTag } }],
            outbox: [
              {
                eventType: 'quality.instrument_retired.v1',
                aggregateType: 'instrument',
                aggregateId: instrumentId,
                aggregateVersion: version,
                data: { instrumentId },
              },
            ],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.get(actor, instrumentId);
  }

  // ----------------------------------------------------------------- reads

  /** JobWork sees every organization's equipment; a supplier only its own. */
  async list(actor: Actor): Promise<Instrument[]> {
    const rows = await this.repo.instruments(this.readScope(actor));
    const calibrations = await this.repo.calibrations(rows.map((r) => r.id));
    return rows.map((r) => this.view(r, calibrations.filter((c) => c.instrumentId === r.id)));
  }

  async get(actor: Actor, instrumentId: string): Promise<Instrument> {
    const scope = this.readScope(actor);
    const row = await this.repo.findInstrument(instrumentId);
    if (!row || (scope !== null && row.ownerOrganizationId !== scope)) throw new DomainError('INSTRUMENT_NOT_FOUND', 404, 'Instrument not found');
    return this.view(row, await this.repo.calibrations([row.id]));
  }

  private readScope(actor: Actor): string | null {
    if (actor.isInternal) {
      if (!actor.roles.some((r) => QUALITY_READERS.includes(r))) throw new DomainError('NOT_AUTHORIZED', 403, 'Not permitted');
      return null;
    }
    if (actor.organizationType !== 'supplier' || !actor.organizationId || !actor.roles.some((r) => SUPPLIER_READERS.includes(r))) throw new DomainError('NOT_AUTHORIZED', 403, 'Not permitted');
    return actor.organizationId;
  }

  private view(row: InstrumentRow, calibrations: CalibrationRow[]): Instrument {
    const now = new Date();
    const inForce = calibrations.find((c) => c.performedAt.getTime() <= now.getTime()) ?? null;
    const standing = calibrationStanding(inForce, now);
    return {
      instrumentId: row.id,
      ownerOrganizationId: row.ownerOrganizationId,
      ownerDisplayName: row.ownerDisplayName,
      assetTag: row.assetTag,
      kind: row.kind,
      description: row.description,
      unit: row.unit,
      resolution: row.resolution,
      status: row.status,
      calibrationStatus: standing.status,
      calibrationDueAt: inForce && inForce.outcome === 'pass' ? inForce.dueAt.toISOString() : null,
      calibrations: calibrations.map((c) => ({
        calibrationId: c.id,
        performedAt: c.performedAt.toISOString(),
        dueAt: c.dueAt.toISOString(),
        outcome: c.outcome,
        certificateDocumentVersionId: c.certificateDocumentVersionId,
        certificateSha256: c.certificateSha256,
        note: c.note,
      })),
      aggregateVersion: row.aggregateVersion,
    };
  }
}
