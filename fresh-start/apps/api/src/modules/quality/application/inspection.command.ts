import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type {
  CalibrationDispositionRequest,
  CorrectResultRequest,
  DecideInspectionRequest,
  Inspection,
  InspectionStatus,
  InspectionVersionRequest,
  InvalidateInspectionRequest,
  MeasuredValue,
  PlanInspectionRequest,
  SubmitResultsRequest,
} from '@jobwork/contracts';
import { type Actor, requireTransactionalStrength } from '../../iam';
import { contextFromActor, type AuditSpec, type OutboxSpec } from '../../../platform/commands/command';
import { CommandExecutor } from '../../../platform/commands/execute';
import { DomainError } from '../../../platform/http/domain-error';
import { currentResults, InspectionNotFound, nonMandatoryFailures, passBlockers, QualityRefused, STAGE_LABEL } from '../domain/inspection';
import { type CharacteristicRule, type ConversionTable, evaluate, MeasurementRefused } from '../domain/measurement';
import { NcrRepository } from '../infrastructure/ncr.repository';
import { type CharacteristicRow, type InspectionRow, QualityRepository } from '../infrastructure/quality.repository';
import { calibrationStanding, SUPPLIER_INSPECTORS } from './instrument.command';
import { NcrCommand } from './ncr.command';
import { characteristicView, QUALITY, QUALITY_READERS, requireInternal } from './quality-plan.command';

type Opts = { idempotencyKey?: string | undefined };

const SUPPLIER_READERS = ['supplier_quality', 'org_admin', 'supplier_production', 'supplier_estimator'];
const BACKDATE_DAYS = 7;
const WORKING_STATUSES = ['released', 'in_production', 'completed'];

function rule(c: CharacteristicRow): CharacteristicRule {
  return c.kind === 'attribute'
    ? { kind: 'attribute', acceptedValues: c.acceptedValues }
    : {
        kind: 'variable',
        unit: c.unit!,
        lower: c.lowerLimit !== null ? { value: c.lowerLimit, inclusive: c.lowerInclusive! } : null,
        upper: c.upperLimit !== null ? { value: c.upperLimit, inclusive: c.upperInclusive! } : null,
      };
}

/**
 * Inspections (IN-14 F-14.3; doc 06 §10; doc 09 §10; FR-702). JobWork quality plans an
 * inspection of one stage; the organization that measures records every sample against
 * every characteristic of that stage in one submission; an independent JobWork reviewer
 * decides. Each result is judged by the measurement engine when it is recorded, keeps the
 * instrument's calibration standing at the moment of measurement, and is only ever
 * superseded by a correction with a reason.
 */
@Injectable()
export class InspectionCommand {
  constructor(
    private readonly repo: QualityRepository,
    private readonly executor: CommandExecutor,
    private readonly ncrs: NcrCommand,
    private readonly ncrRepo: NcrRepository,
  ) {}

  // ----------------------------------------------------------------- helpers

  private audit(i: { id: string; number: string }, version: number, action: string, data: Record<string, unknown> = {}, reason?: string): AuditSpec {
    return { action, subjectType: 'inspection', subjectId: i.id, subjectVersion: version, ...(reason ? { reason } : {}), data: { number: i.number, ...data } };
  }

  private event(i: InspectionRow | { id: string; number: string; workPackageId: string }, version: number, type: string, data: Record<string, unknown> = {}): OutboxSpec {
    return {
      eventType: type,
      aggregateType: 'inspection',
      aggregateId: i.id,
      aggregateVersion: version,
      data: { inspectionId: i.id, number: i.number, workPackageId: i.workPackageId, ...data },
    };
  }

  private async locked(inspectionId: string, expectedVersion: number, tx: PoolClient): Promise<InspectionRow> {
    const row = await this.repo.findInspection(inspectionId, tx, true);
    if (!row) throw new InspectionNotFound();
    if (row.aggregateVersion !== expectedVersion) throw new DomainError('VERSION_CONFLICT', 409, 'The inspection moved on', 'Reload it and try again.');
    return row;
  }

  private requireStatus(row: InspectionRow, allowed: readonly InspectionStatus[], what: string): void {
    if (!allowed.includes(row.status)) throw new QualityRefused('INSPECTION_STATUS', `This inspection cannot ${what} now`, `It is ${row.status.replace(/_/g, ' ')}.`);
  }

  /** Measures for the inspecting organization: its quality people (JobWork's for its own stage). */
  private requireInspector(actor: Actor, row: InspectionRow): void {
    const roles = actor.isInternal ? QUALITY : SUPPLIER_INSPECTORS;
    if (actor.organizationId !== row.inspectingOrganizationId) throw new InspectionNotFound();
    if (!actor.roles.some((r) => roles.includes(r))) throw new DomainError('NOT_AUTHORIZED', 403, 'Not permitted', `Requires one of: ${roles.join(', ')}.`);
    if (actor.isInternal) requireTransactionalStrength(actor);
  }

  /** JobWork quality, and never the person who submitted the results (BR-QLT-03; doc 09 §9). */
  private requireReviewer(actor: Actor, row: InspectionRow): void {
    requireInternal(actor, QUALITY);
    requireTransactionalStrength(actor);
    if (row.submittedBy === actor.userId) throw new QualityRefused('REVIEWER_NOT_INDEPENDENT', 'You submitted these results', 'Another member of JobWork quality reviews them.');
  }

  private async stageCharacteristics(row: { planId: string; stage: string }, tx?: PoolClient): Promise<CharacteristicRow[]> {
    return (await this.repo.characteristics(row.planId, tx)).filter((c) => c.stages.includes(row.stage as CharacteristicRow['stages'][number]));
  }

  /** One judged result, with the instrument's standing when it was measured. */
  private async judge(
    input: { characteristic: CharacteristicRow; measurement: MeasuredValue; instrumentId: string | null; inspectingOrganizationId: string; inspectedAt: Date; where: string },
    table: ConversionTable,
    tx: PoolClient,
  ) {
    const c = input.characteristic;
    if (c.kind === 'variable' && !input.instrumentId) throw new QualityRefused('INSTRUMENT_REQUIRED', `${input.where}: name the instrument used`, 'A measured value records its instrument (FR-702).', 422);
    let calibration: { status: 'valid' | 'expired' | 'uncalibrated' | 'not_required'; calibrationId: string | null } = { status: 'not_required', calibrationId: null };
    if (input.instrumentId) {
      const instrument = await this.repo.findInstrument(input.instrumentId, tx);
      if (!instrument || instrument.ownerOrganizationId !== input.inspectingOrganizationId) throw new QualityRefused('INSTRUMENT_UNAVAILABLE', `${input.where}: that instrument is not yours`, undefined, 422);
      if (instrument.status !== 'in_service') throw new QualityRefused('INSTRUMENT_UNAVAILABLE', `${input.where}: ${instrument.assetTag} is retired`, undefined, 422);
      calibration = calibrationStanding(await this.repo.calibrationAt(instrument.id, input.inspectedAt, tx), input.inspectedAt);
    }
    try {
      const e = evaluate(input.measurement, rule(c), table);
      return { evaluation: e, calibration };
    } catch (err) {
      if (err instanceof MeasurementRefused) throw new QualityRefused(err.code, `${input.where}: ${err.message}`, undefined, 422);
      throw err;
    }
  }

  // ----------------------------------------------------------------- commands

  async plan(actor: Actor, input: PlanInspectionRequest, opts: Opts = {}): Promise<Inspection> {
    requireInternal(actor, QUALITY);
    requireTransactionalStrength(actor);
    const id = await this.executor.execute(
      {
        operation: 'quality.plan-inspection',
        handler: async (tx, _ctx, cmd: PlanInspectionRequest) => {
          const wp = await this.repo.workPackage(cmd.workPackageId, tx);
          if (!wp) throw new DomainError('WORK_PACKAGE_NOT_FOUND', 404, 'Work package not found');
          if (!WORKING_STATUSES.includes(wp.status)) throw new QualityRefused('WORK_PACKAGE_NOT_RELEASED', 'Inspections follow the work package’s release', `It is ${wp.status}.`);
          if (cmd.stage === 'customer_receiving') throw new QualityRefused('STAGE_NOT_SUPPORTED', 'Customer receiving inspections come with delivery', undefined, 422);
          const plan = (await this.repo.plansFor(wp.id, tx)).find((p) => p.status === 'approved');
          if (!plan) throw new QualityRefused('NO_APPROVED_PLAN', 'Approve the quality plan first');
          if (plan.baselineStatus !== 'released') throw new QualityRefused('PLAN_BASELINE_STALE', 'The quality plan was written against a superseded baseline', 'Revise and approve it against the baseline in force.');
          const stage = plan.stages.find((s) => s.stage === cmd.stage);
          if (!stage) throw new QualityRefused('STAGE_NOT_IN_PLAN', 'The plan has no such stage', cmd.stage, 422);
          if (cmd.sampleSize !== undefined && cmd.sampleSize < stage.sampleSize) throw new QualityRefused('SAMPLE_BELOW_PLAN', `The plan samples ${stage.sampleSize} at this stage`, undefined, 422);
          if (cmd.milestoneId && !(await this.repo.milestoneBelongs(cmd.milestoneId, wp.id, tx))) throw new QualityRefused('MILESTONE_NOT_IN_WORK_PACKAGE', 'That milestone is not this work package’s', undefined, 422);
          if (cmd.reinspectionOf) {
            const earlier = await this.repo.findInspection(cmd.reinspectionOf, tx);
            if (!earlier || earlier.workPackageId !== wp.id || earlier.stage !== cmd.stage || !['failed', 'invalidated'].includes(earlier.status)) {
              throw new QualityRefused('REINSPECTION_INVALID', 'A reinspection follows a failed or invalidated inspection of the same stage', undefined, 422);
            }
          }
          const inspectedBySupplier = cmd.stage !== 'jobwork_incoming';
          const number = await this.repo.allocateNumber(new Date(), tx);
          const inspectionId = await this.repo.insertInspection(
            {
              number,
              workPackageId: wp.id,
              planId: plan.id,
              baselineId: plan.baselineId,
              stage: cmd.stage,
              sampleSize: cmd.sampleSize ?? stage.sampleSize,
              lot: cmd.lot,
              note: cmd.note,
              inspectingOrganizationId: inspectedBySupplier ? wp.supplierOrganizationId : actor.organizationId!,
              milestoneId: cmd.milestoneId ?? null,
              reinspectionOf: cmd.reinspectionOf ?? null,
              by: actor.userId,
            },
            tx,
          );
          const created = { id: inspectionId, number, workPackageId: wp.id };
          return {
            result: inspectionId,
            audit: [this.audit(created, 1, 'quality.inspection_planned', { stage: cmd.stage, sampleSize: cmd.sampleSize ?? stage.sampleSize, planId: plan.id, reinspectionOf: cmd.reinspectionOf ?? null })],
            outbox: [
              this.event(created, 1, 'quality.inspection_planned.v1', {
                stage: cmd.stage,
                stageLabel: STAGE_LABEL[cmd.stage],
                sampleSize: cmd.sampleSize ?? stage.sampleSize,
                inspectedBySupplier,
                supplierOrganizationId: wp.supplierOrganizationId,
                purchaseOrderId: wp.purchaseOrderId,
                purchaseOrderNumber: wp.purchaseOrderNumber,
              }),
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

  async start(actor: Actor, inspectionId: string, input: InspectionVersionRequest, opts: Opts = {}): Promise<Inspection> {
    await this.executor.execute(
      {
        operation: 'quality.start-inspection',
        handler: async (tx, _ctx, cmd: InspectionVersionRequest) => {
          const row = await this.locked(inspectionId, cmd.expectedVersion, tx);
          this.requireInspector(actor, row);
          this.requireStatus(row, ['planned'], 'start');
          const version = await this.repo.updateInspection(row.id, { status: 'in_progress', startedBy: actor.userId, startedAt: new Date() }, tx);
          return { result: undefined, audit: [this.audit(row, version, 'quality.inspection_started')], outbox: [this.event(row, version, 'quality.inspection_started.v1')] };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.get(actor, inspectionId);
  }

  async submitResults(actor: Actor, inspectionId: string, input: SubmitResultsRequest, opts: Opts = {}): Promise<Inspection> {
    await this.executor.execute(
      {
        operation: 'quality.submit-results',
        handler: async (tx, _ctx, cmd: SubmitResultsRequest) => {
          const row = await this.locked(inspectionId, cmd.expectedVersion, tx);
          this.requireInspector(actor, row);
          this.requireStatus(row, ['in_progress'], 'take results');
          const inspectedAt = new Date(cmd.inspectedAt);
          const now = Date.now();
          if (inspectedAt.getTime() > now + 5 * 60_000 || inspectedAt.getTime() < now - BACKDATE_DAYS * 86_400_000) {
            throw new QualityRefused('INSPECTED_AT_OUT_OF_RANGE', `Record when it was measured: not in the future, and within ${BACKDATE_DAYS} days`, undefined, 422);
          }
          const sampleNos = cmd.samples.map((s) => s.sampleNo).sort((a, b) => a - b);
          if (sampleNos.length !== row.sampleSize || sampleNos.some((n, i) => n !== i + 1)) {
            throw new QualityRefused('SAMPLES_INCOMPLETE', `Record samples 1 to ${row.sampleSize}, each once`, undefined, 422);
          }
          const characteristics = await this.stageCharacteristics(row, tx);
          const seen = new Set<string>();
          for (const r of cmd.results) {
            if (!characteristics.some((c) => c.id === r.characteristicId)) throw new QualityRefused('UNKNOWN_CHARACTERISTIC', 'A result names a characteristic this stage does not check', r.characteristicId, 422);
            if (!sampleNos.includes(r.sampleNo)) throw new QualityRefused('UNKNOWN_SAMPLE', `Sample ${r.sampleNo} is not in this inspection`, undefined, 422);
            const key = `${r.sampleNo}:${r.characteristicId}`;
            if (seen.has(key)) throw new QualityRefused('RESULT_REPEATED', `Sample ${r.sampleNo} has two results for one characteristic`, undefined, 422);
            seen.add(key);
          }
          const expected = characteristics.length * row.sampleSize;
          if (seen.size !== expected) throw new QualityRefused('RESULTS_INCOMPLETE', `Every sample needs every characteristic: ${expected - seen.size} result(s) missing`, undefined, 422);
          const attachments: Array<{ documentVersionId: string; sha256: string; note: string }> = [];
          for (const a of cmd.attachments) {
            const file = await this.repo.ownCleanVersion(a.documentVersionId, row.inspectingOrganizationId, tx);
            if (!file) throw new QualityRefused('ATTACHMENT_UNAVAILABLE', 'An attachment is not your own clean file', a.documentVersionId, 422);
            attachments.push({ documentVersionId: a.documentVersionId, sha256: file.sha256, note: a.note });
          }

          const table = await this.repo.conversionTable(tx);
          const sampleIds = new Map<number, string>();
          for (const s of cmd.samples) sampleIds.set(s.sampleNo, await this.repo.insertSample({ inspectionId: row.id, ...s }, tx));
          const counts = { pass: 0, fail: 0, cannot_evaluate: 0, calibrationFlags: 0 };
          for (const r of cmd.results) {
            const characteristic = characteristics.find((c) => c.id === r.characteristicId)!;
            const { evaluation, calibration } = await this.judge(
              { characteristic, measurement: r.measurement, instrumentId: r.instrumentId, inspectingOrganizationId: row.inspectingOrganizationId, inspectedAt, where: `Sample ${r.sampleNo}, ${characteristic.seq}. ${characteristic.name}` },
              table,
              tx,
            );
            counts[evaluation.outcome] += 1;
            if (calibration.status === 'expired' || calibration.status === 'uncalibrated') counts.calibrationFlags += 1;
            await this.repo.insertResult(
              {
                inspectionId: row.id,
                sampleId: sampleIds.get(r.sampleNo)!,
                characteristicId: characteristic.id,
                originalValue: r.measurement.value,
                originalUnit: r.measurement.unit,
                declaredPrecision: r.measurement.declaredPrecision,
                normalizedValue: evaluation.normalized?.value ?? null,
                normalizedUnit: evaluation.normalized?.unit ?? null,
                outcome: evaluation.outcome,
                outcomeReason: evaluation.reason,
                ruleVersion: evaluation.ruleVersion,
                conversionVersionId: evaluation.conversionVersionId,
                method: r.method || characteristic.method,
                instrumentId: r.instrumentId,
                calibrationId: calibration.calibrationId,
                calibrationStatus: calibration.status,
                supersedesResultId: null,
                correctionReason: null,
                by: actor.userId,
              },
              tx,
            );
          }
          for (const a of attachments) await this.repo.insertAttachment({ inspectionId: row.id, ...a, by: actor.userId }, tx);
          const version = await this.repo.updateInspection(row.id, { status: 'results_submitted', inspectedAt, submittedBy: actor.userId, submittedAt: new Date() }, tx);
          return {
            result: undefined,
            audit: [this.audit(row, version, 'quality.results_submitted', { results: cmd.results.length, ...counts, attachments: attachments.map((a) => a.sha256) })],
            outbox: [this.event(row, version, 'quality.results_submitted.v1', { results: cmd.results.length, failed: counts.fail, cannotEvaluate: counts.cannot_evaluate })],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.get(actor, inspectionId);
  }

  /** A new result row that supersedes one with a reason; the original stays (doc 19 §6). */
  async correctResult(actor: Actor, inspectionId: string, input: CorrectResultRequest, opts: Opts = {}): Promise<Inspection> {
    await this.executor.execute(
      {
        operation: 'quality.correct-result',
        handler: async (tx, _ctx, cmd: CorrectResultRequest) => {
          const row = await this.locked(inspectionId, cmd.expectedVersion, tx);
          if (row.status === 'results_submitted') this.requireInspector(actor, row);
          else if (row.status === 'under_review') this.requireReviewer(actor, row);
          else throw new QualityRefused('INSPECTION_STATUS', 'Results can be corrected only before the decision', `It is ${row.status.replace(/_/g, ' ')}.`);
          const original = currentResults(await this.repo.results(row.id, tx)).find((r) => r.id === cmd.resultId);
          if (!original) throw new QualityRefused('RESULT_NOT_CURRENT', 'Correct the result as it stands now', 'That result was already corrected, or is not in this inspection.', 422);
          const characteristic = (await this.stageCharacteristics(row, tx)).find((c) => c.id === original.characteristicId)!;
          const { evaluation, calibration } = await this.judge(
            { characteristic, measurement: cmd.measurement, instrumentId: cmd.instrumentId, inspectingOrganizationId: row.inspectingOrganizationId, inspectedAt: row.inspectedAt!, where: `Sample ${original.sampleNo}, ${characteristic.seq}. ${characteristic.name}` },
            await this.repo.conversionTable(tx),
            tx,
          );
          const newId = await this.repo.insertResult(
            {
              inspectionId: row.id,
              sampleId: original.sampleId,
              characteristicId: characteristic.id,
              originalValue: cmd.measurement.value,
              originalUnit: cmd.measurement.unit,
              declaredPrecision: cmd.measurement.declaredPrecision,
              normalizedValue: evaluation.normalized?.value ?? null,
              normalizedUnit: evaluation.normalized?.unit ?? null,
              outcome: evaluation.outcome,
              outcomeReason: evaluation.reason,
              ruleVersion: evaluation.ruleVersion,
              conversionVersionId: evaluation.conversionVersionId,
              method: original.method,
              instrumentId: cmd.instrumentId,
              calibrationId: calibration.calibrationId,
              calibrationStatus: calibration.status,
              supersedesResultId: original.id,
              correctionReason: cmd.reason,
              by: actor.userId,
            },
            tx,
          );
          const version = await this.repo.bumpInspection(row.id, tx);
          return {
            result: undefined,
            audit: [
              this.audit(
                row,
                version,
                'quality.result_corrected',
                { resultId: original.id, correctedBy: newId, from: { value: original.originalValue, unit: original.originalUnit, outcome: original.outcome }, to: { value: cmd.measurement.value, unit: cmd.measurement.unit, outcome: evaluation.outcome } },
                cmd.reason,
              ),
            ],
            outbox: [this.event(row, version, 'quality.result_corrected.v1', { resultId: original.id, correctedBy: newId })],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.get(actor, inspectionId);
  }

  async startReview(actor: Actor, inspectionId: string, input: InspectionVersionRequest, opts: Opts = {}): Promise<Inspection> {
    await this.executor.execute(
      {
        operation: 'quality.start-review',
        handler: async (tx, _ctx, cmd: InspectionVersionRequest) => {
          const row = await this.locked(inspectionId, cmd.expectedVersion, tx);
          this.requireReviewer(actor, row);
          this.requireStatus(row, ['results_submitted'], 'be reviewed');
          const version = await this.repo.updateInspection(row.id, { status: 'under_review', reviewerId: actor.userId, reviewStartedAt: new Date() }, tx);
          return { result: undefined, audit: [this.audit(row, version, 'quality.review_started')], outbox: [this.event(row, version, 'quality.review_started.v1')] };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.get(actor, inspectionId);
  }

  /** BR-QLT-05: a result taken with an expired or uncalibrated instrument is accepted with a reason, or sent back. */
  async dispositionCalibration(actor: Actor, inspectionId: string, input: CalibrationDispositionRequest, opts: Opts = {}): Promise<Inspection> {
    await this.executor.execute(
      {
        operation: 'quality.disposition-calibration',
        handler: async (tx, _ctx, cmd: CalibrationDispositionRequest) => {
          const row = await this.locked(inspectionId, cmd.expectedVersion, tx);
          this.requireReviewer(actor, row);
          this.requireStatus(row, ['under_review'], 'take a disposition');
          const result = currentResults(await this.repo.results(row.id, tx)).find((r) => r.id === cmd.resultId);
          if (!result || (result.calibrationStatus !== 'expired' && result.calibrationStatus !== 'uncalibrated')) {
            throw new QualityRefused('DISPOSITION_NOT_NEEDED', 'Only a current result measured without a valid calibration takes a disposition', undefined, 422);
          }
          if (result.disposition) throw new QualityRefused('DISPOSITION_EXISTS', 'That result already has a disposition');
          await this.repo.insertDisposition({ resultId: result.id, decision: cmd.decision, reason: cmd.reason, by: actor.userId }, tx);
          const version = await this.repo.bumpInspection(row.id, tx);
          return {
            result: undefined,
            audit: [this.audit(row, version, 'quality.calibration_dispositioned', { resultId: result.id, decision: cmd.decision, instrument: result.instrumentAssetTag, calibrationStatus: result.calibrationStatus }, cmd.reason)],
            outbox: [this.event(row, version, 'quality.calibration_dispositioned.v1', { resultId: result.id, decision: cmd.decision })],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.get(actor, inspectionId);
  }

  async decide(actor: Actor, inspectionId: string, input: DecideInspectionRequest, opts: Opts = {}): Promise<Inspection> {
    await this.executor.execute(
      {
        operation: 'quality.decide-inspection',
        handler: async (tx, _ctx, cmd: DecideInspectionRequest) => {
          const row = await this.locked(inspectionId, cmd.expectedVersion, tx);
          this.requireReviewer(actor, row);
          this.requireStatus(row, ['under_review'], 'be decided');
          const [characteristics, results, samples] = [await this.stageCharacteristics(row, tx), await this.repo.results(row.id, tx), await this.repo.samples(row.id, tx)];
          const rollup = characteristics.map((c) => ({ id: c.id, seq: c.seq, name: c.name, mandatory: c.mandatory }));
          if (cmd.decision === 'passed') {
            const blockers = passBlockers(rollup, samples.map((s) => s.sampleNo), results);
            if (blockers.length > 0) throw new QualityRefused('INSPECTION_CANNOT_PASS', 'This inspection cannot pass', blockers.join(' '));
            if (nonMandatoryFailures(rollup, results).length > 0 && cmd.reason.length < 3) {
              throw new QualityRefused('REASON_REQUIRED', 'Say why it passes with a non-mandatory characteristic failed', undefined, 422);
            }
          } else if (cmd.reason.length < 3) {
            throw new QualityRefused('REASON_REQUIRED', 'Say why it failed', undefined, 422);
          }
          const status = cmd.decision;
          const version = await this.repo.updateInspection(row.id, { status, reviewerId: actor.userId, decidedAt: new Date(), ...(cmd.reason ? { decisionReason: cmd.reason } : {}) }, tx);
          const wp = (await this.repo.workPackage(row.workPackageId, tx))!;
          // What IN-15 needs to open an NCR (doc 08 §7 inspection.failed; BR-QLT-01): which characteristics, how critical, which samples.
          const failures = characteristics
            .map((c) => ({ c, samples: currentResults(results).filter((r) => r.characteristicId === c.id && r.outcome === 'fail').map((r) => r.sampleNo) }))
            .filter((f) => f.samples.length > 0)
            .map((f) => ({ characteristicId: f.c.id, name: f.c.name, drawingReference: f.c.drawingReference, criticality: f.c.criticality, mandatory: f.c.mandatory, sampleNos: f.samples }));
          const data = {
            stage: row.stage,
            sampleSize: row.sampleSize,
            lot: row.lot,
            failures,
            inspectedBySupplier: row.inspectingOrganizationId === wp.supplierOrganizationId,
            supplierOrganizationId: wp.supplierOrganizationId,
            purchaseOrderId: wp.purchaseOrderId,
            purchaseOrderNumber: wp.purchaseOrderNumber,
            salesOrderId: wp.salesOrderId,
          };
          const passed = status === 'passed';
          // A reinspection under an NCR carries the NCR with it (IN-15).
          const ncr = await this.ncrs.onReinspectionConcluded(row.id, status, tx);
          return {
            result: undefined,
            audit: [this.audit(row, version, passed ? 'quality.inspection_passed' : 'quality.inspection_failed', { failures: failures.length }, cmd.reason || undefined), ...ncr.audit],
            outbox: [
              ...ncr.outbox,
              {
                eventType: passed ? 'quality.inspection_passed.v1' : 'quality.inspection_failed.v1',
                aggregateType: 'inspection',
                aggregateId: row.id,
                aggregateVersion: version,
                data: { inspectionId: row.id, number: row.number, workPackageId: row.workPackageId, ...data },
              },
            ],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.get(actor, inspectionId);
  }

  async invalidate(actor: Actor, inspectionId: string, input: InvalidateInspectionRequest, opts: Opts = {}): Promise<Inspection> {
    requireInternal(actor, QUALITY);
    requireTransactionalStrength(actor);
    await this.executor.execute(
      {
        operation: 'quality.invalidate-inspection',
        handler: async (tx, _ctx, cmd: InvalidateInspectionRequest) => {
          const row = await this.locked(inspectionId, cmd.expectedVersion, tx);
          this.requireStatus(row, ['planned', 'in_progress', 'results_submitted', 'under_review', 'passed', 'failed'], 'be invalidated');
          const version = await this.repo.updateInspection(row.id, { status: 'invalidated', invalidatedAt: new Date(), invalidationReason: cmd.reason }, tx);
          const ncr = await this.ncrs.onReinspectionConcluded(row.id, 'invalidated', tx);
          return {
            result: undefined,
            audit: [this.audit(row, version, 'quality.inspection_invalidated', { from: row.status }, cmd.reason), ...ncr.audit],
            outbox: [this.event(row, version, 'quality.inspection_invalidated.v1', { from: row.status }), ...ncr.outbox],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.get(actor, inspectionId);
  }

  // ----------------------------------------------------------------- reads

  /** JobWork reads every inspection; a supplier only those it carries out. */
  private scope(actor: Actor): string | null {
    if (actor.isInternal) {
      requireInternal(actor, QUALITY_READERS);
      return null;
    }
    if (actor.organizationType !== 'supplier' || !actor.organizationId || !actor.roles.some((r) => SUPPLIER_READERS.includes(r))) throw new DomainError('NOT_AUTHORIZED', 403, 'Not permitted');
    return actor.organizationId;
  }

  async list(actor: Actor, filter: { workPackageId?: string; awaitingReview?: boolean }): Promise<Inspection[]> {
    const scope = this.scope(actor);
    const rows = await this.repo.inspections({
      ...(filter.workPackageId ? { workPackageId: filter.workPackageId } : {}),
      ...(scope ? { inspectingOrganizationId: scope } : {}),
      ...(filter.awaitingReview ? { statuses: ['results_submitted', 'under_review'] as const } : {}),
    });
    return Promise.all(rows.map((r) => this.view(actor, r)));
  }

  async get(actor: Actor, inspectionId: string): Promise<Inspection> {
    const scope = this.scope(actor);
    const row = await this.repo.findInspection(inspectionId);
    if (!row || (scope !== null && row.inspectingOrganizationId !== scope)) throw new InspectionNotFound();
    return this.view(actor, row);
  }

  private async view(actor: Actor, row: InspectionRow): Promise<Inspection> {
    const characteristics = await this.stageCharacteristics(row);
    const results = await this.repo.results(row.id);
    const samples = await this.repo.samples(row.id);
    const attachments = await this.repo.attachments(row.id);
    const coverage = await this.ncrRepo.deviationCoverage(row.id);
    const rollup = characteristics.map((c) => ({ id: c.id, seq: c.seq, name: c.name, mandatory: c.mandatory }));
    const inspector = actor.organizationId === row.inspectingOrganizationId && actor.roles.some((r) => (actor.isInternal ? QUALITY : SUPPLIER_INSPECTORS).includes(r));
    return {
      inspectionId: row.id,
      number: row.number,
      workPackageId: row.workPackageId,
      purchaseOrderId: row.purchaseOrderId,
      purchaseOrderNumber: row.purchaseOrderNumber,
      supplierDisplayName: actor.isInternal ? row.supplierDisplayName : '',
      stage: row.stage,
      status: row.status,
      sampleSize: row.sampleSize,
      lot: row.lot,
      note: row.note,
      planId: row.planId,
      planVersionNo: row.planVersionNo,
      baselineNumber: row.baselineNumber,
      characteristics: characteristics.map(characteristicView),
      samples: samples.map((s) => ({ sampleNo: s.sampleNo, serial: s.serial, lot: s.lot, cavity: s.cavity })),
      results: results.map((r) => ({
        resultId: r.id,
        sampleNo: r.sampleNo,
        characteristicId: r.characteristicId,
        original: { value: r.originalValue, unit: r.originalUnit, declaredPrecision: r.declaredPrecision },
        normalized: r.normalizedValue !== null && r.normalizedUnit !== null ? { value: r.normalizedValue, unit: r.normalizedUnit } : null,
        outcome: r.outcome,
        outcomeReason: r.outcomeReason,
        ruleVersion: r.ruleVersion,
        method: r.method,
        instrument: r.instrumentId ? { instrumentId: r.instrumentId, assetTag: r.instrumentAssetTag ?? '', kind: r.instrumentKind ?? '' } : null,
        calibrationStatus: r.calibrationStatus,
        disposition: r.disposition,
        supersededByResultId: r.supersededByResultId,
        supersedesResultId: r.supersedesResultId,
        correctionReason: r.correctionReason,
        recordedAt: r.recordedAt.toISOString(),
        coveredByDeviation: ((c) => (c ? { number: c.number, expiresAt: c.expiresAt.toISOString(), active: c.expiresAt.getTime() > Date.now() } : null))(coverage.find((c) => c.resultId === r.id)),
      })),
      attachments,
      passBlockers: ['results_submitted', 'under_review'].includes(row.status) ? passBlockers(rollup, samples.map((s) => s.sampleNo), results) : [],
      plannedAt: row.plannedAt.toISOString(),
      inspectedAt: row.inspectedAt ? row.inspectedAt.toISOString() : null,
      submittedAt: row.submittedAt ? row.submittedAt.toISOString() : null,
      decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
      decisionReason: row.decisionReason,
      invalidationReason: row.invalidationReason,
      reinspectionOf: row.reinspectionOf,
      canSubmit: inspector && row.status === 'in_progress',
      canReview: actor.isInternal && actor.roles.includes('jobwork_quality') && row.submittedBy !== actor.userId && ['results_submitted', 'under_review'].includes(row.status),
      aggregateVersion: row.aggregateVersion,
    };
  }
}
