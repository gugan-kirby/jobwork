import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  characteristicInputSchema,
  type CharacteristicInput,
  type CreateQualityPlanRequest,
  type QualityPlan,
  type QualityPlanVersionRequest,
  type QualityTemplate,
  type SaveQualityPlanDraftRequest,
} from '@jobwork/contracts';
import { type Actor, requireTransactionalStrength } from '../../iam';
import { contextFromActor, type AuditSpec, type OutboxSpec } from '../../../platform/commands/command';
import { CommandExecutor } from '../../../platform/commands/execute';
import { DomainError } from '../../../platform/http/domain-error';
import { parallelReads } from '../../../platform/database/parallel-reads';
import { QualityRefused } from '../domain/inspection';
import { Rational } from '../domain/rational';
import { type CharacteristicRow, type PlanRow, QualityRepository, type WorkPackageContext } from '../infrastructure/quality.repository';

type Opts = { idempotencyKey?: string | undefined };

export const QUALITY = ['jobwork_quality'];
export const QUALITY_READERS = ['jobwork_quality', 'jobwork_engineering', 'jobwork_sourcing', 'jobwork_sales', 'platform_admin'];

export function requireInternal(actor: Actor, roles: readonly string[]): void {
  if (!actor.isInternal || !actor.roles.some((r) => roles.includes(r))) {
    throw new DomainError('NOT_AUTHORIZED', 403, 'Not permitted', `Requires one of: ${roles.join(', ')}.`);
  }
}

/** A characteristic row back into the shape a draft is saved in. */
export function toInput(c: CharacteristicRow): CharacteristicInput {
  const common = { drawingReference: c.drawingReference, name: c.name, criticality: c.criticality, mandatory: c.mandatory, stages: c.stages, method: c.method, instrumentKind: c.instrumentKind, reactionPlan: c.reactionPlan };
  return c.kind === 'attribute'
    ? { kind: 'attribute', ...common, acceptedValues: c.acceptedValues }
    : {
        kind: 'variable',
        ...common,
        unit: c.unit!,
        nominal: c.nominal,
        lower: c.lowerLimit !== null ? { value: c.lowerLimit, inclusive: c.lowerInclusive! } : null,
        upper: c.upperLimit !== null ? { value: c.upperLimit, inclusive: c.upperInclusive! } : null,
      };
}

/**
 * Quality plans (IN-14 F-14.3; doc 09 §§9, 16; FR-701). A plan starts from the active version
 * of a category template, is edited as a draft against the order's released baseline, and is
 * frozen on approval. A later baseline means a revised plan; the old one stays as it was.
 */
@Injectable()
export class QualityPlanCommand {
  constructor(
    private readonly repo: QualityRepository,
    private readonly executor: CommandExecutor,
  ) {}

  private audit(plan: { id: string }, version: number, action: string, data: Record<string, unknown> = {}): AuditSpec {
    return { action, subjectType: 'quality_plan', subjectId: plan.id, subjectVersion: version, data };
  }

  private event(plan: { id: string; workPackageId: string }, version: number, type: string, data: Record<string, unknown> = {}): OutboxSpec {
    return { eventType: type, aggregateType: 'quality_plan', aggregateId: plan.id, aggregateVersion: version, data: { planId: plan.id, workPackageId: plan.workPackageId, ...data } };
  }

  private async locked(planId: string, expectedVersion: number, tx: PoolClient): Promise<PlanRow> {
    const plan = await this.repo.findPlan(planId, tx, true);
    if (!plan) throw new DomainError('QUALITY_PLAN_NOT_FOUND', 404, 'Quality plan not found');
    if (plan.aggregateVersion !== expectedVersion) throw new DomainError('VERSION_CONFLICT', 409, 'The plan moved on', 'Reload it and try again.');
    return plan;
  }

  async templates(actor: Actor): Promise<QualityTemplate[]> {
    requireInternal(actor, QUALITY_READERS);
    return (await this.repo.templates()).map((t) => ({ code: t.code, label: t.label, versionNo: t.versionNo, capabilityCodes: t.capabilityCodes, stages: t.stages, characteristicCount: t.characteristics.length }));
  }

  async create(actor: Actor, input: CreateQualityPlanRequest, opts: Opts = {}): Promise<QualityPlan> {
    requireInternal(actor, QUALITY);
    requireTransactionalStrength(actor);
    const planId = await this.executor.execute(
      {
        operation: 'quality.create-plan',
        handler: async (tx, _ctx, cmd: CreateQualityPlanRequest) => {
          const wp = await this.repo.workPackage(cmd.workPackageId, tx);
          if (!wp) throw new DomainError('WORK_PACKAGE_NOT_FOUND', 404, 'Work package not found');
          if (wp.status === 'cancelled') throw new QualityRefused('WORK_PACKAGE_CANCELLED', 'This work package is cancelled');
          const baseline = await this.repo.releasedBaseline(wp.salesOrderId, tx);
          if (!baseline) throw new QualityRefused('NO_RELEASED_BASELINE', 'Release the technical baseline first', 'A plan is written against the drawings that govern.');
          const existing = (await this.repo.plansFor(wp.id, tx)).find((p) => p.status !== 'superseded');
          if (existing) throw new QualityRefused('QUALITY_PLAN_EXISTS', 'This work package already has a plan', existing.status === 'draft' ? 'Edit its draft.' : 'Revise the approved plan instead.');
          const template = (await this.repo.templates(tx)).find((t) => t.code === cmd.templateCode);
          if (!template) throw new DomainError('TEMPLATE_NOT_FOUND', 404, 'No active quality template with that code');
          const versionNo = await this.repo.nextPlanVersion(wp.id, tx);
          const id = await this.repo.insertPlan({ workPackageId: wp.id, versionNo, templateVersionId: template.versionId, baselineId: baseline.id, stages: template.stages, supersedesPlanId: null, createdBy: actor.userId }, tx);
          await this.repo.replaceCharacteristics(id, template.characteristics.map((c) => characteristicInputSchema.parse(c)), tx);
          const plan = { id, workPackageId: wp.id };
          return {
            result: id,
            audit: [this.audit(plan, 1, 'quality.plan_created', { workPackageId: wp.id, template: `${template.code} v${template.versionNo}`, baselineId: baseline.id, versionNo })],
            outbox: [this.event(plan, 1, 'quality.plan_created.v1', { versionNo })],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.get(actor, planId);
  }

  async saveDraft(actor: Actor, planId: string, input: SaveQualityPlanDraftRequest, opts: Opts = {}): Promise<QualityPlan> {
    requireInternal(actor, QUALITY);
    requireTransactionalStrength(actor);
    await this.executor.execute(
      {
        operation: 'quality.save-plan-draft',
        handler: async (tx, _ctx, cmd: SaveQualityPlanDraftRequest) => {
          const plan = await this.locked(planId, cmd.expectedVersion, tx);
          if (plan.status !== 'draft') throw new QualityRefused('QUALITY_PLAN_NOT_DRAFT', 'Only a draft plan can be edited', 'Revise the approved plan to change it.');
          const stages = new Set(cmd.stages.map((s) => s.stage));
          if (stages.size !== cmd.stages.length) throw new QualityRefused('PLAN_STAGE_REPEATED', 'Each stage appears once', undefined, 422);
          const units = await this.repo.unitCodes(tx);
          cmd.characteristics.forEach((c, i) => {
            const at = `Characteristic ${i + 1} (${c.name})`;
            const stray = c.stages.find((s) => !stages.has(s));
            if (stray) throw new QualityRefused('CHARACTERISTIC_STAGE_NOT_IN_PLAN', `${at} is checked at a stage the plan does not have`, stray, 422);
            if (c.kind === 'variable') {
              if (!units.has(c.unit)) throw new QualityRefused('UNKNOWN_UNIT', `${at} uses an unknown unit`, c.unit, 422);
              if (!c.lower && !c.upper) throw new QualityRefused('CHARACTERISTIC_LIMITS_MISSING', `${at} needs a lower or an upper limit`, undefined, 422);
              if (c.lower && c.upper) {
                const order = Rational.parse(c.lower.value).compare(Rational.parse(c.upper.value));
                if (order > 0 || (order === 0 && !(c.lower.inclusive && c.upper.inclusive))) throw new QualityRefused('CHARACTERISTIC_LIMITS_INVERTED', `${at} has its lower limit above its upper limit`, undefined, 422);
              }
            }
          });
          // A draft always follows the baseline in force.
          const baseline = await this.repo.releasedBaseline((await this.repo.workPackage(plan.workPackageId, tx))!.salesOrderId, tx);
          await this.repo.replaceCharacteristics(plan.id, cmd.characteristics, tx);
          const version = await this.repo.updatePlan(plan.id, { stages: cmd.stages, ...(baseline && baseline.id !== plan.baselineId ? { baselineId: baseline.id } : {}) }, tx);
          return {
            result: undefined,
            audit: [this.audit(plan, version, 'quality.plan_draft_saved', { characteristics: cmd.characteristics.length, stages: cmd.stages })],
            outbox: [this.event(plan, version, 'quality.plan_draft_saved.v1')],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.get(actor, planId);
  }

  async approve(actor: Actor, planId: string, input: QualityPlanVersionRequest, opts: Opts = {}): Promise<QualityPlan> {
    requireInternal(actor, QUALITY);
    requireTransactionalStrength(actor);
    await this.executor.execute(
      {
        operation: 'quality.approve-plan',
        handler: async (tx, _ctx, cmd: QualityPlanVersionRequest) => {
          const plan = await this.locked(planId, cmd.expectedVersion, tx);
          if (plan.status !== 'draft') throw new QualityRefused('QUALITY_PLAN_NOT_DRAFT', 'Only a draft plan can be approved');
          if (plan.baselineStatus !== 'released') throw new QualityRefused('PLAN_BASELINE_STALE', 'A newer baseline governs this order', 'Save the draft again to bind it to the baseline in force, review it, then approve.');
          const characteristics = await this.repo.characteristics(plan.id, tx);
          const empty = plan.stages.find((s) => !characteristics.some((c) => c.stages.includes(s.stage)));
          if (empty) throw new QualityRefused('PLAN_STAGE_EMPTY', 'Every stage needs at least one characteristic', empty.stage, 422);
          if (plan.requiresDrawingCharacteristic && !characteristics.some((c) => c.drawingReference.trim() !== '')) {
            throw new QualityRefused('PLAN_NEEDS_DRAWING_CHARACTERISTIC', 'Add at least one characteristic from the drawing', 'The template requires a characteristic with its balloon or drawing reference.', 422);
          }
          const previous = (await this.repo.plansFor(plan.workPackageId, tx)).find((p) => p.status === 'approved');
          if (previous) await this.repo.updatePlan(previous.id, { status: 'superseded' }, tx);
          const version = await this.repo.updatePlan(plan.id, { status: 'approved', approvedBy: actor.userId, approvedAt: new Date() }, tx);
          return {
            result: undefined,
            audit: [this.audit(plan, version, 'quality.plan_approved', { versionNo: plan.versionNo, characteristics: characteristics.length, baselineId: plan.baselineId, supersedes: previous?.id ?? null })],
            outbox: [this.event(plan, version, 'quality.plan_approved.v1', { versionNo: plan.versionNo, baselineId: plan.baselineId })],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.get(actor, planId);
  }

  /** A new draft from the approved plan, against the baseline in force. The approved plan governs until the draft is approved. */
  async revise(actor: Actor, planId: string, input: QualityPlanVersionRequest, opts: Opts = {}): Promise<QualityPlan> {
    requireInternal(actor, QUALITY);
    requireTransactionalStrength(actor);
    const draftId = await this.executor.execute(
      {
        operation: 'quality.revise-plan',
        handler: async (tx, _ctx, cmd: QualityPlanVersionRequest) => {
          const plan = await this.locked(planId, cmd.expectedVersion, tx);
          if (plan.status !== 'approved') throw new QualityRefused('QUALITY_PLAN_NOT_APPROVED', 'Only the approved plan can be revised');
          if ((await this.repo.plansFor(plan.workPackageId, tx)).some((p) => p.status === 'draft')) throw new QualityRefused('QUALITY_PLAN_DRAFT_EXISTS', 'A revision is already in draft');
          const wp = (await this.repo.workPackage(plan.workPackageId, tx))!;
          const baseline = await this.repo.releasedBaseline(wp.salesOrderId, tx);
          if (!baseline) throw new QualityRefused('NO_RELEASED_BASELINE', 'No baseline is released');
          const versionNo = await this.repo.nextPlanVersion(wp.id, tx);
          const id = await this.repo.insertPlan({ workPackageId: wp.id, versionNo, templateVersionId: plan.templateVersionId, baselineId: baseline.id, stages: plan.stages, supersedesPlanId: plan.id, createdBy: actor.userId }, tx);
          await this.repo.replaceCharacteristics(id, (await this.repo.characteristics(plan.id, tx)).map(toInput), tx);
          const draft = { id, workPackageId: wp.id };
          return {
            result: id,
            audit: [this.audit(draft, 1, 'quality.plan_revised', { from: plan.id, versionNo, baselineId: baseline.id })],
            outbox: [this.event(draft, 1, 'quality.plan_revised.v1', { from: plan.id, versionNo })],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.get(actor, draftId);
  }

  // ----------------------------------------------------------------- reads

  async get(actor: Actor, planId: string): Promise<QualityPlan> {
    requireInternal(actor, QUALITY_READERS);
    const plan = await this.repo.findPlan(planId);
    if (!plan) throw new DomainError('QUALITY_PLAN_NOT_FOUND', 404, 'Quality plan not found');
    return this.view(plan);
  }

  async forWorkPackage(actor: Actor, workPackageId: string): Promise<QualityPlan[]> {
    requireInternal(actor, QUALITY_READERS);
    return Promise.all((await this.repo.plansFor(workPackageId)).map((p) => this.view(p)));
  }

  private async view(plan: PlanRow): Promise<QualityPlan> {
    const [wp, characteristics] = await parallelReads<[WorkPackageContext | null, CharacteristicRow[]]>(null, [() => this.repo.workPackage(plan.workPackageId), () => this.repo.characteristics(plan.id)]);
    return {
      planId: plan.id,
      workPackageId: plan.workPackageId,
      workPackageNumber: wp?.number ?? '',
      purchaseOrderId: wp?.purchaseOrderId ?? plan.workPackageId,
      purchaseOrderNumber: wp?.purchaseOrderNumber ?? '',
      supplierDisplayName: wp?.supplierDisplayName ?? '',
      salesOrderId: wp?.salesOrderId ?? plan.workPackageId,
      salesOrderNumber: wp?.salesOrderNumber ?? '',
      versionNo: plan.versionNo,
      status: plan.status,
      templateCode: plan.templateCode,
      templateLabel: plan.templateLabel,
      templateVersionNo: plan.templateVersionNo,
      requiresDrawingCharacteristic: plan.requiresDrawingCharacteristic,
      baselineId: plan.baselineId,
      baselineNumber: plan.baselineNumber,
      baselineCurrent: plan.baselineStatus === 'released',
      stages: plan.stages,
      characteristics: characteristics.map((c) => characteristicView(c)),
      approvedAt: plan.approvedAt ? plan.approvedAt.toISOString() : null,
      aggregateVersion: plan.aggregateVersion,
    };
  }
}

export function characteristicView(c: CharacteristicRow): QualityPlan['characteristics'][number] {
  return {
    characteristicId: c.id,
    seq: c.seq,
    drawingReference: c.drawingReference,
    name: c.name,
    kind: c.kind,
    criticality: c.criticality,
    mandatory: c.mandatory,
    unit: c.unit,
    nominal: c.nominal,
    lower: c.lowerLimit !== null ? { value: c.lowerLimit, inclusive: c.lowerInclusive! } : null,
    upper: c.upperLimit !== null ? { value: c.upperLimit, inclusive: c.upperInclusive! } : null,
    acceptedValues: c.acceptedValues,
    stages: c.stages,
    method: c.method,
    instrumentKind: c.instrumentKind,
    reactionPlan: c.reactionPlan,
  };
}
