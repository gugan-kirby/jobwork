import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type {
  ApproveReworkRequest,
  InspectionStatus,
  CloseNcrRequest,
  ContainNcrRequest,
  Ncr,
  NcrVersionRequest,
  OpenNcrRequest,
  PlanReinspectionRequest,
  RecordReworkRequest,
  RejectLotRequest,
  RespondCorrectiveActionRequest,
  ReviewCorrectiveActionRequest,
  VerifyCorrectiveActionRequest,
} from '@jobwork/contracts';
import { type Actor, requireTransactionalStrength } from '../../iam';
import { contextFromActor, type AuditSpec, type OutboxSpec } from '../../../platform/commands/command';
import { CommandExecutor } from '../../../platform/commands/execute';
import { DomainError } from '../../../platform/http/domain-error';
import { currentResults, QualityRefused, STAGE_LABEL } from '../domain/inspection';
import { assertNcrTransition, closeBlockers, CORRECTIVE_ACTION_SEVERITIES, type NcrStatus, thinCause } from '../domain/ncr';
import { NcrRepository, type NcrRow } from '../infrastructure/ncr.repository';
import { QualityRepository } from '../infrastructure/quality.repository';
import { SUPPLIER_INSPECTORS } from './instrument.command';
import { QUALITY, QUALITY_READERS, requireInternal } from './quality-plan.command';

type Opts = { idempotencyKey?: string | undefined };

const SUPPLIER_READERS = ['supplier_quality', 'org_admin', 'supplier_production', 'supplier_estimator'];
/** Rework is production work; its record may come from the shop floor as well as quality. */
const SUPPLIER_REWORKERS = ['supplier_quality', 'org_admin', 'supplier_production'];
const NCR_DUE_DAYS = 7;
const CORRECTIVE_ACTION_DUE_DAYS = 14;
const DISPOSITION_LABEL: Record<string, string> = {
  rework: 'rework, then reinspection',
  remake: 'remake, then reinspection',
  sort: 'sort, then reinspection',
  return: 'return the affected parts',
  scrap: 'scrap the affected parts',
};

/**
 * Nonconformance (IN-15 F-15.2; doc 06 §10; doc 09 §§11, 13; FR-703, FR-705; BR-QLT-04, BR-QLT-06).
 * JobWork quality opens an NCR on failed results and decides its disposition; the supplier
 * contains, reworks and answers the corrective action; a rework is judged only by a new
 * inspection of the failed one; and someone other than the person who decided the
 * disposition closes it, once nothing stands in the way.
 */
@Injectable()
export class NcrCommand {
  constructor(
    private readonly repo: NcrRepository,
    private readonly quality: QualityRepository,
    private readonly executor: CommandExecutor,
  ) {}

  // ----------------------------------------------------------------- helpers

  private audit(n: { id: string; number: string }, version: number, action: string, data: Record<string, unknown> = {}, reason?: string): AuditSpec {
    return { action, subjectType: 'ncr', subjectId: n.id, subjectVersion: version, ...(reason ? { reason } : {}), data: { number: n.number, ...data } };
  }

  private event(n: NcrRow | { id: string; number: string; workPackageId: string }, version: number, type: string, data: Record<string, unknown> = {}): OutboxSpec {
    return {
      eventType: type,
      aggregateType: 'ncr',
      aggregateId: n.id,
      aggregateVersion: version,
      data: { ncrId: n.id, number: n.number, workPackageId: n.workPackageId, ...data },
    };
  }

  private supplierFacts(n: NcrRow): Record<string, unknown> {
    return { supplierOrganizationId: n.supplierOrganizationId, purchaseOrderId: n.purchaseOrderId, purchaseOrderNumber: n.purchaseOrderNumber };
  }

  private async locked(ncrId: string, expectedVersion: number | null, tx: PoolClient): Promise<NcrRow> {
    const n = await this.repo.find(ncrId, tx, true);
    if (!n) throw new DomainError('NCR_NOT_FOUND', 404, 'NCR not found');
    if (expectedVersion !== null && n.aggregateVersion !== expectedVersion) throw new DomainError('VERSION_CONFLICT', 409, 'The NCR moved on', 'Reload it and try again.');
    return n;
  }

  private requireQuality(actor: Actor): void {
    requireInternal(actor, QUALITY);
    requireTransactionalStrength(actor);
  }

  /** The supplier whose work package it is, with one of `roles`. */
  private requireSupplier(actor: Actor, n: NcrRow, roles: readonly string[]): void {
    if (actor.isInternal || actor.organizationId !== n.supplierOrganizationId) throw new DomainError('NCR_NOT_FOUND', 404, 'NCR not found');
    if (!actor.roles.some((r) => roles.includes(r))) throw new DomainError('NOT_AUTHORIZED', 403, 'Not permitted', `Requires one of: ${roles.join(', ')}.`);
  }

  private async move(
    actor: Actor,
    ncrId: string,
    operation: string,
    input: { expectedVersion: number },
    to: NcrStatus,
    build: (n: NcrRow, tx: PoolClient) => Promise<{ fields?: Parameters<NcrRepository['update']>[1]; action: string; data?: Record<string, unknown>; reason?: string; events?: Array<{ eventType: string; data?: Record<string, unknown> }> }>,
    opts: Opts,
  ): Promise<Ncr> {
    await this.executor.execute(
      {
        operation,
        handler: async (tx, _ctx, cmd: { expectedVersion: number }) => {
          const n = await this.locked(ncrId, cmd.expectedVersion, tx);
          assertNcrTransition(n.status, to);
          const plan = await build(n, tx);
          const version = await this.repo.update(n.id, { ...plan.fields, status: to }, tx);
          return {
            result: undefined,
            audit: [this.audit(n, version, plan.action, { from: n.status, to, ...plan.data }, plan.reason)],
            outbox: (plan.events ?? []).map((e) => this.event(n, version, e.eventType, { status: to, ...e.data })),
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.get(actor, ncrId);
  }

  // ----------------------------------------------------------------- open and contain

  async open(actor: Actor, input: OpenNcrRequest, opts: Opts = {}): Promise<Ncr> {
    this.requireQuality(actor);
    const id = await this.executor.execute(
      {
        operation: 'quality.open-ncr',
        handler: async (tx, _ctx, cmd: OpenNcrRequest) => {
          const inspection = await this.quality.findInspection(cmd.inspectionId, tx);
          if (!inspection) throw new DomainError('INSPECTION_NOT_FOUND', 404, 'Inspection not found');
          if (inspection.status !== 'failed') throw new QualityRefused('INSPECTION_NOT_FAILED', 'An NCR is opened on a failed inspection', `It is ${inspection.status.replace(/_/g, ' ')}.`);
          const results = currentResults(await this.quality.results(inspection.id, tx));
          const covered = cmd.resultIds.map((rid) => results.find((r) => r.id === rid));
          if (covered.some((r) => !r || r.outcome !== 'fail')) throw new QualityRefused('RESULT_NOT_FAILED', 'Name the failed results the NCR covers', 'Each must be a standing failed result of this inspection.', 422);
          if (cmd.parentNcrId) {
            const parent = await this.repo.find(cmd.parentNcrId, tx);
            if (!parent || parent.workPackageId !== inspection.workPackageId || parent.status === 'closed') {
              throw new QualityRefused('PARENT_NCR_INVALID', 'A branched NCR follows an open NCR on the same work package', undefined, 422);
            }
          }
          const number = await this.repo.allocateNumber('NCR', 'ncr', new Date(), tx);
          const correctiveActionRequired = CORRECTIVE_ACTION_SEVERITIES.includes(cmd.severity);
          const ncrId = await this.repo.insert(
            {
              number,
              workPackageId: inspection.workPackageId,
              inspectionId: inspection.id,
              baselineId: inspection.baselineId,
              parentNcrId: cmd.parentNcrId ?? null,
              title: cmd.title,
              description: cmd.description,
              severity: cmd.severity,
              detectionStage: inspection.stage,
              affectedQuantity: cmd.affectedQuantity,
              lots: cmd.lots,
              serials: cmd.serials,
              suspectedCause: cmd.suspectedCause,
              ownerId: actor.userId,
              dueAt: cmd.dueAt ? new Date(cmd.dueAt) : new Date(Date.now() + NCR_DUE_DAYS * 86_400_000),
              costResponsibility: cmd.costResponsibility,
              correctiveActionRequired,
              by: actor.userId,
            },
            tx,
          );
          for (const r of covered) await this.repo.insertDefect({ ncrId, resultId: r!.id, characteristicId: r!.characteristicId }, tx);
          if (correctiveActionRequired) await this.repo.insertCorrectiveAction({ ncrId, dueAt: new Date(Date.now() + CORRECTIVE_ACTION_DUE_DAYS * 86_400_000), by: actor.userId }, tx);
          const created = { id: ncrId, number, workPackageId: inspection.workPackageId };
          return {
            result: ncrId,
            audit: [this.audit(created, 1, 'quality.ncr_opened', { inspectionId: inspection.id, severity: cmd.severity, affectedQuantity: cmd.affectedQuantity, lots: cmd.lots, defects: cmd.resultIds.length, parentNcrId: cmd.parentNcrId ?? null })],
            outbox: [
              this.event(created, 1, 'quality.ncr_opened.v1', {
                severity: cmd.severity,
                inspectionId: inspection.id,
                parentNcrId: cmd.parentNcrId ?? null,
                supplierOrganizationId: inspection.supplierOrganizationId,
                purchaseOrderId: inspection.purchaseOrderId,
                purchaseOrderNumber: inspection.purchaseOrderNumber,
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

  /** Append-only: JobWork or the supplier records what was done to contain the parts. */
  async contain(actor: Actor, ncrId: string, input: ContainNcrRequest, opts: Opts = {}): Promise<Ncr> {
    await this.executor.execute(
      {
        operation: 'quality.contain-ncr',
        handler: async (tx, _ctx, cmd: ContainNcrRequest) => {
          const n = await this.locked(ncrId, null, tx);
          if (actor.isInternal) this.requireQuality(actor);
          else this.requireSupplier(actor, n, SUPPLIER_REWORKERS);
          if (n.status === 'closed') throw new QualityRefused('NCR_CLOSED', 'This NCR is closed');
          await this.repo.insertContainment({ ncrId: n.id, action: cmd.action, location: cmd.location, quantity: cmd.quantity, by: actor.userId, organizationId: actor.organizationId! }, tx);
          const version = await this.repo.update(n.id, n.status === 'open' ? { status: 'containment' } : {}, tx);
          return {
            result: undefined,
            audit: [this.audit(n, version, 'quality.ncr_contained', { action: cmd.action, location: cmd.location, quantity: cmd.quantity, by: actor.isInternal ? 'jobwork' : 'supplier' })],
            outbox: [this.event(n, version, 'quality.ncr_contained.v1')],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.get(actor, ncrId);
  }

  async toDisposition(actor: Actor, ncrId: string, input: NcrVersionRequest, opts: Opts = {}): Promise<Ncr> {
    this.requireQuality(actor);
    return this.move(
      actor,
      ncrId,
      'quality.ncr-to-disposition',
      input,
      'disposition_pending',
      async (n) => {
        if ((await this.repo.containment(n.id)).length === 0) throw new QualityRefused('CONTAINMENT_MISSING', 'Record the containment first');
        return { action: 'quality.ncr_disposition_pending', events: [{ eventType: 'quality.ncr_disposition_pending.v1' }] };
      },
      opts,
    );
  }

  // ----------------------------------------------------------------- dispositions

  async approveRework(actor: Actor, ncrId: string, input: ApproveReworkRequest, opts: Opts = {}): Promise<Ncr> {
    this.requireQuality(actor);
    return this.move(
      actor,
      ncrId,
      'quality.approve-rework',
      input,
      'rework',
      async (n, tx) => {
        const attemptNo = n.attemptNo + 1;
        await this.repo.insertDisposition({ ncrId: n.id, attemptNo, disposition: input.disposition, plan: input.plan, by: actor.userId }, tx);
        return {
          fields: { attemptNo, dispositionDecidedBy: actor.userId },
          action: 'quality.rework_approved',
          data: { attemptNo, disposition: input.disposition, plan: input.plan },
          events: [{ eventType: 'quality.rework_approved.v1', data: { attemptNo, disposition: input.disposition, dispositionLabel: DISPOSITION_LABEL[input.disposition], ...this.supplierFacts(n) } }],
        };
      },
      opts,
    );
  }

  async recordRework(actor: Actor, ncrId: string, input: RecordReworkRequest, opts: Opts = {}): Promise<Ncr> {
    await this.executor.execute(
      {
        operation: 'quality.record-rework',
        handler: async (tx, _ctx, cmd: RecordReworkRequest) => {
          const n = await this.locked(ncrId, cmd.expectedVersion, tx);
          this.requireSupplier(actor, n, SUPPLIER_REWORKERS);
          if (n.status !== 'rework') throw new QualityRefused('NCR_NOT_IN_REWORK', 'There is no approved rework to record');
          const latest = (await this.repo.dispositions(n.id, tx)).at(-1)!;
          if (latest.reworkRecordedAt) throw new QualityRefused('REWORK_RECORDED', 'This rework is already recorded');
          await this.repo.recordRework(latest.id, { note: cmd.note, by: actor.userId }, tx);
          const version = await this.repo.update(n.id, {}, tx);
          return {
            result: undefined,
            audit: [this.audit(n, version, 'quality.rework_recorded', { attemptNo: latest.attemptNo, note: cmd.note })],
            outbox: [this.event(n, version, 'quality.rework_recorded.v1', { attemptNo: latest.attemptNo })],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.get(actor, ncrId);
  }

  /** BR-QLT-04: the reinspection is a new inspection of the one that failed, never the same record. */
  async planReinspection(actor: Actor, ncrId: string, input: PlanReinspectionRequest, opts: Opts = {}): Promise<Ncr> {
    this.requireQuality(actor);
    await this.executor.execute(
      {
        operation: 'quality.plan-reinspection',
        handler: async (tx, _ctx, cmd: PlanReinspectionRequest) => {
          const n = await this.locked(ncrId, cmd.expectedVersion, tx);
          assertNcrTransition(n.status, 'reinspection');
          const dispositions = await this.repo.dispositions(n.id, tx);
          const latest = dispositions.at(-1)!;
          if (!latest.reworkRecordedAt) throw new QualityRefused('REWORK_NOT_RECORDED', 'The supplier has not recorded the rework yet');
          const plan = (await this.quality.plansFor(n.workPackageId, tx)).find((p) => p.status === 'approved');
          if (!plan || plan.baselineStatus !== 'released') throw new QualityRefused('PLAN_BASELINE_STALE', 'The quality plan must be approved against the baseline in force');
          const original = (await this.quality.findInspection(n.inspectionId, tx))!;
          // The newest inspection in this NCR's chain: the last reinspection, or the original.
          const previous = [...dispositions].reverse().find((d) => d.reinspectionId)?.reinspectionId ?? original.id;
          const number = await this.quality.allocateNumber(new Date(), tx);
          const sampleSize = cmd.sampleSize ?? original.sampleSize;
          const reinspectionId = await this.quality.insertInspection(
            {
              number,
              workPackageId: n.workPackageId,
              planId: plan.id,
              baselineId: plan.baselineId,
              stage: original.stage,
              sampleSize,
              lot: original.lot,
              note: `Reinspection after ${latest.disposition} under ${n.number}`,
              inspectingOrganizationId: original.inspectingOrganizationId,
              milestoneId: null,
              reinspectionOf: previous,
              by: actor.userId,
            },
            tx,
          );
          await this.repo.linkReinspection(latest.id, reinspectionId, tx);
          const version = await this.repo.update(n.id, { status: 'reinspection' }, tx);
          const reinspection = { id: reinspectionId, number, workPackageId: n.workPackageId };
          return {
            result: undefined,
            audit: [
              this.audit(n, version, 'quality.reinspection_planned', { from: n.status, to: 'reinspection', attemptNo: latest.attemptNo, inspectionId: reinspectionId }),
              { action: 'quality.inspection_planned', subjectType: 'inspection', subjectId: reinspectionId, subjectVersion: 1, data: { number, stage: original.stage, sampleSize, reinspectionOf: previous, ncrId: n.id } },
            ],
            outbox: [
              this.event(n, version, 'quality.reinspection_planned.v1', { inspectionId: reinspectionId }),
              {
                eventType: 'quality.inspection_planned.v1',
                aggregateType: 'inspection',
                aggregateId: reinspectionId,
                aggregateVersion: 1,
                data: {
                  inspectionId: reinspectionId,
                  number,
                  workPackageId: reinspection.workPackageId,
                  stage: original.stage,
                  stageLabel: STAGE_LABEL[original.stage],
                  sampleSize,
                  inspectedBySupplier: original.inspectingOrganizationId === n.supplierOrganizationId,
                  ...this.supplierFacts(n),
                },
              },
            ],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.get(actor, ncrId);
  }

  /**
   * Called inside the inspection decision's transaction: a reinspection under an NCR carries
   * the NCR with it. Passed verifies the rework; failed or invalidated returns the NCR to a new
   * disposition, keeping the attempt.
   */
  async onReinspectionConcluded(inspectionId: string, outcome: 'passed' | 'failed' | 'invalidated', tx: PoolClient): Promise<{ audit: AuditSpec[]; outbox: OutboxSpec[] }> {
    const link = await this.repo.dispositionForReinspection(inspectionId, tx);
    if (!link) return { audit: [], outbox: [] };
    const n = (await this.repo.find(link.ncrId, tx, true))!;
    const verified = outcome === 'passed';
    await this.repo.setOutcome(link.dispositionId, verified ? 'verified' : 'still_nonconforming', tx);
    const to: NcrStatus = verified ? 'verified' : 'disposition_pending';
    const version = await this.repo.update(n.id, { status: to }, tx);
    return {
      audit: [this.audit(n, version, verified ? 'quality.ncr_verified' : 'quality.ncr_still_nonconforming', { from: n.status, to, inspectionId, attemptNo: n.attemptNo })],
      outbox: [
        {
          eventType: verified ? 'quality.ncr_verified.v1' : 'quality.ncr_still_nonconforming.v1',
          aggregateType: 'ncr',
          aggregateId: n.id,
          aggregateVersion: version,
          data: { ncrId: n.id, number: n.number, workPackageId: n.workPackageId, inspectionId, attemptNo: n.attemptNo },
        },
      ],
    };
  }

  async rejectLot(actor: Actor, ncrId: string, input: RejectLotRequest, opts: Opts = {}): Promise<Ncr> {
    this.requireQuality(actor);
    return this.move(
      actor,
      ncrId,
      'quality.reject-lot',
      input,
      'rejected',
      async (n, tx) => {
        const attemptNo = n.attemptNo + 1;
        await this.repo.insertDisposition({ ncrId: n.id, attemptNo, disposition: input.disposition, plan: input.reason, by: actor.userId, outcome: 'rejected' }, tx);
        return {
          fields: { attemptNo, dispositionDecidedBy: actor.userId, costResponsibility: input.costResponsibility },
          action: 'quality.ncr_rejected',
          reason: input.reason,
          data: { attemptNo, disposition: input.disposition, costResponsibility: input.costResponsibility },
          events: [{ eventType: 'quality.ncr_rejected.v1', data: { disposition: input.disposition, dispositionLabel: DISPOSITION_LABEL[input.disposition], ...this.supplierFacts(n) } }],
        };
      },
      opts,
    );
  }

  async close(actor: Actor, ncrId: string, input: CloseNcrRequest, opts: Opts = {}): Promise<Ncr> {
    this.requireQuality(actor);
    return this.move(
      actor,
      ncrId,
      'quality.close-ncr',
      input,
      'closed',
      async (n, tx) => {
        const blockers = closeBlockers(await this.closureFacts(n, tx), actor.userId);
        if (blockers.length > 0) throw new QualityRefused('NCR_CANNOT_CLOSE', 'This NCR cannot close yet', blockers.join(' '));
        return { fields: { closedBy: actor.userId, closedAt: new Date(), closureNote: input.note }, action: 'quality.ncr_closed', reason: input.note, events: [{ eventType: 'quality.ncr_closed.v1' }] };
      },
      opts,
    );
  }

  private async closureFacts(n: NcrRow, tx?: PoolClient) {
    const dispositions = await this.repo.dispositions(n.id, tx);
    const latest = dispositions.at(-1) ?? null;
    const ca = await this.repo.correctiveAction(n.id, tx);
    const children = await this.repo.children(n.id, tx);
    const verifying = latest?.reinspectionId && latest.outcome === 'verified' ? latest : null;
    return {
      status: n.status,
      dispositionDecidedBy: n.dispositionDecidedBy,
      correctiveActionRequired: n.correctiveActionRequired,
      correctiveActionStatus: ca?.status ?? null,
      originalInspectionId: n.inspectionId,
      verifyingReinspection: verifying
        ? { id: verifying.reinspectionId!, status: verifying.reinspectionStatus ?? '', plannedAt: verifying.reinspectionPlannedAt!, reinspectionChain: await this.repo.reinspectionChain(verifying.reinspectionId!, tx) }
        : null,
      latestDispositionAt: latest?.decidedAt ?? null,
      openChildren: children.filter((c) => c.status !== 'closed').map((c) => c.number),
    };
  }

  // ----------------------------------------------------------------- corrective action (doc 09 §13)

  private async correctiveCommand(
    actor: Actor,
    ncrId: string,
    operation: string,
    input: { expectedVersion: number },
    run: (n: NcrRow, ca: NonNullable<Awaited<ReturnType<NcrRepository['correctiveAction']>>>, tx: PoolClient) => Promise<{ action: string; data?: Record<string, unknown>; reason?: string; eventType: string }>,
    opts: Opts,
  ): Promise<Ncr> {
    await this.executor.execute(
      {
        operation,
        handler: async (tx, _ctx, cmd: { expectedVersion: number }) => {
          const n = await this.locked(ncrId, null, tx);
          const ca = await this.repo.correctiveAction(n.id, tx, true);
          if (!ca) throw new QualityRefused('NO_CORRECTIVE_ACTION', 'This NCR asks for no corrective action');
          if (ca.aggregateVersion !== cmd.expectedVersion) throw new DomainError('VERSION_CONFLICT', 409, 'The corrective action moved on', 'Reload it and try again.');
          const plan = await run(n, ca, tx);
          const version = await this.repo.update(n.id, {}, tx);
          return {
            result: undefined,
            audit: [this.audit(n, version, plan.action, plan.data, plan.reason)],
            outbox: [this.event(n, version, plan.eventType)],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.get(actor, ncrId);
  }

  async respondCorrectiveAction(actor: Actor, ncrId: string, input: RespondCorrectiveActionRequest, opts: Opts = {}): Promise<Ncr> {
    return this.correctiveCommand(
      actor,
      ncrId,
      'quality.respond-corrective-action',
      input,
      async (n, ca, tx) => {
        this.requireSupplier(actor, n, SUPPLIER_INSPECTORS);
        if (ca.status !== 'requested') throw new QualityRefused('CA_STATUS', 'This corrective action is not waiting for a response');
        if (thinCause(input.occurrenceCause) || thinCause(input.escapeCause)) {
          throw new QualityRefused('CA_CAUSE_TOO_THIN', 'Name the causes, not only who', '"Operator mistake" is not a cause: say what let it happen and what let it escape (doc 09 §13).', 422);
        }
        await this.repo.updateCorrectiveAction(ca.id, { status: 'responded', problemDefinition: input.problemDefinition, occurrenceCause: input.occurrenceCause, escapeCause: input.escapeCause, actions: input.actions, respondedBy: actor.userId }, tx);
        return { action: 'quality.corrective_action_responded', data: { actions: input.actions.length }, eventType: 'quality.corrective_action_responded.v1' };
      },
      opts,
    );
  }

  async reviewCorrectiveAction(actor: Actor, ncrId: string, input: ReviewCorrectiveActionRequest, opts: Opts = {}): Promise<Ncr> {
    this.requireQuality(actor);
    return this.correctiveCommand(
      actor,
      ncrId,
      'quality.review-corrective-action',
      input,
      async (_n, ca, tx) => {
        if (ca.status !== 'responded') throw new QualityRefused('CA_STATUS', 'There is no response to review');
        if (input.decision === 'return' && input.note.length < 3) throw new QualityRefused('REASON_REQUIRED', 'Say what is missing', undefined, 422);
        await this.repo.updateCorrectiveAction(ca.id, input.decision === 'accept' ? { status: 'accepted', acceptedBy: actor.userId, reviewNote: input.note } : { status: 'requested', reviewNote: input.note }, tx);
        return { action: input.decision === 'accept' ? 'quality.corrective_action_accepted' : 'quality.corrective_action_returned', ...(input.note ? { reason: input.note } : {}), eventType: 'quality.corrective_action_reviewed.v1' };
      },
      opts,
    );
  }

  async verifyCorrectiveAction(actor: Actor, ncrId: string, input: VerifyCorrectiveActionRequest, opts: Opts = {}): Promise<Ncr> {
    this.requireQuality(actor);
    return this.correctiveCommand(
      actor,
      ncrId,
      'quality.verify-corrective-action',
      input,
      async (_n, ca, tx) => {
        if (ca.status !== 'accepted') throw new QualityRefused('CA_STATUS', 'Accept the corrective action before verifying it');
        await this.repo.updateCorrectiveAction(ca.id, { status: 'verified', effectivenessEvidence: input.evidence, verifiedBy: actor.userId }, tx);
        return { action: 'quality.corrective_action_verified', reason: input.evidence, eventType: 'quality.corrective_action_verified.v1' };
      },
      opts,
    );
  }

  // ----------------------------------------------------------------- reads

  /** JobWork quality and its readers see every NCR; a supplier its own; a customer none. */
  private scope(actor: Actor): string | null {
    if (actor.isInternal) {
      requireInternal(actor, QUALITY_READERS);
      return null;
    }
    if (actor.organizationType !== 'supplier' || !actor.organizationId || !actor.roles.some((r) => SUPPLIER_READERS.includes(r))) throw new DomainError('NOT_AUTHORIZED', 403, 'Not permitted');
    return actor.organizationId;
  }

  async list(actor: Actor, filter: { workPackageId?: string; open?: boolean }): Promise<Ncr[]> {
    const scope = this.scope(actor);
    const rows = await this.repo.list({ ...filter, ...(scope ? { supplierOrganizationId: scope } : {}) });
    return Promise.all(rows.map((n) => this.view(actor, n)));
  }

  async get(actor: Actor, ncrId: string): Promise<Ncr> {
    const scope = this.scope(actor);
    const n = await this.repo.find(ncrId);
    if (!n || (scope !== null && n.supplierOrganizationId !== scope)) throw new DomainError('NCR_NOT_FOUND', 404, 'NCR not found');
    return this.view(actor, n);
  }

  private async view(actor: Actor, n: NcrRow): Promise<Ncr> {
    const [defects, containment, dispositions, ca, children, parent] = [
      await this.repo.defects(n.id),
      await this.repo.containment(n.id),
      await this.repo.dispositions(n.id),
      await this.repo.correctiveAction(n.id),
      await this.repo.children(n.id),
      n.parentNcrId ? await this.repo.find(n.parentNcrId) : null,
    ];
    return {
      ncrId: n.id,
      number: n.number,
      workPackageId: n.workPackageId,
      purchaseOrderId: n.purchaseOrderId,
      purchaseOrderNumber: n.purchaseOrderNumber,
      supplierDisplayName: actor.isInternal ? n.supplierDisplayName : '',
      inspectionId: n.inspectionId,
      inspectionNumber: n.inspectionNumber,
      stage: n.stage,
      title: n.title,
      description: n.description,
      severity: n.severity,
      affectedQuantity: n.affectedQuantity,
      lots: n.lots,
      serials: n.serials,
      suspectedCause: n.suspectedCause,
      status: n.status,
      attemptNo: n.attemptNo,
      dueAt: n.dueAt.toISOString(),
      costResponsibility: n.costResponsibility,
      parent: parent ? { ncrId: parent.id, number: parent.number } : null,
      children: children.map((c) => ({ ncrId: c.id, number: c.number, status: c.status })),
      defects: defects.map((d) => ({
        resultId: d.resultId,
        characteristicId: d.characteristicId,
        characteristicName: d.characteristicName,
        sampleNo: d.sampleNo,
        original: { value: d.originalValue, unit: d.originalUnit },
        normalized: d.normalizedValue !== null && d.normalizedUnit !== null ? { value: d.normalizedValue, unit: d.normalizedUnit } : null,
        outcome: d.outcome as Ncr['defects'][number]['outcome'],
        outcomeReason: d.outcomeReason,
      })),
      containment: containment.map((c) => ({ action: c.action, location: c.location, quantity: c.quantity, recordedAt: c.recordedAt.toISOString(), by: c.organizationType === 'internal' ? 'jobwork' : 'supplier' })),
      dispositions: dispositions.map((d) => ({
        attemptNo: d.attemptNo,
        disposition: d.disposition,
        plan: d.plan,
        decidedAt: d.decidedAt.toISOString(),
        reworkNote: d.reworkNote,
        reworkRecordedAt: d.reworkRecordedAt ? d.reworkRecordedAt.toISOString() : null,
        reinspection: d.reinspectionId ? { inspectionId: d.reinspectionId, number: d.reinspectionNumber ?? '', status: (d.reinspectionStatus ?? 'planned') as InspectionStatus } : null,
        outcome: d.outcome,
      })),
      correctiveAction: ca
        ? {
            status: ca.status,
            dueAt: ca.dueAt.toISOString(),
            problemDefinition: ca.problemDefinition,
            occurrenceCause: ca.occurrenceCause,
            escapeCause: ca.escapeCause,
            actions: ca.actions,
            reviewNote: ca.reviewNote,
            effectivenessEvidence: ca.effectivenessEvidence,
            aggregateVersion: ca.aggregateVersion,
          }
        : null,
      deviations: (await this.repo.deviations({ ncrId: n.id })).map((d) => ({
        deviationId: d.id,
        number: d.number,
        status: d.status,
        active: d.status === 'approved' && d.expiresAt.getTime() > Date.now(),
        quantity: d.quantity,
        lots: d.lots,
        expiresAt: d.expiresAt.toISOString(),
      })),
      closeBlockers: actor.isInternal && n.status !== 'closed' ? closeBlockers(await this.closureFacts(n), actor.userId) : [],
      closedAt: n.closedAt ? n.closedAt.toISOString() : null,
      closureNote: n.closureNote,
      aggregateVersion: n.aggregateVersion,
    };
  }
}
