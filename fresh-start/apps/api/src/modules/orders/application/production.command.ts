import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type {
  AcknowledgeTransmittalRequest,
  AssembleBaselineRequest,
  Baseline,
  BaselineCandidate,
  BaselineVersionRequest,
  IssueTransmittalsRequest,
  Milestone,
  MilestoneVersionRequest,
  PlanWorkPackageRequest,
  ProductionView,
  RecordContainmentRequest,
  ReportDelayRequest,
  SubmitEvidenceRequest,
  SupplierProduction,
  Transmittal,
  VerificationQueueItem,
  VerifyMilestoneRequest,
  WaiveMilestoneRequest,
  WorkPackage,
  WorkPackageVersionRequest,
} from '@jobwork/contracts';
import { type Actor, requireOrganization, requireRole, requireTransactionalStrength } from '../../iam';
import { NotAuthorized } from '../../iam/domain/errors';
import { neutralFilename, neutralTitle } from '../../dms';
import { OrderNotFound, OrderVersionConflict, PurchaseOrderNotFound } from '../domain/errors';
import { baselineHash, computeReleaseGates, defaultMilestones, governingConflicts, todayInIndia } from '../domain/production';
import { FinanceRepository } from '../infrastructure/finance.repository';
import { OrdersRepository } from '../infrastructure/orders.repository';
import {
  ProductionRepository,
  type BaselineRecord,
  type MilestoneRecord,
  type TransmittalRecord,
  type WorkPackageRecord,
} from '../infrastructure/production.repository';
import { ORDER_READ_ROLES } from './order.command';
import { contextFromActor, type AuditSpec, type OutboxSpec } from '../../../platform/commands/command';
import { AuditWriter } from '../../../platform/commands/audit.writer';
import { CommandExecutor } from '../../../platform/commands/execute';
import { DatabaseService } from '../../../platform/database/database.service';
import { DomainError } from '../../../platform/http/domain-error';
import { parallelReads } from '../../../platform/database/parallel-reads';

const ENGINEERING_ROLES = ['jobwork_engineering', 'jobwork_sourcing'];
const RELEASE_ROLES = ['jobwork_sourcing', 'jobwork_engineering'];
const READ_ROLES = [...ORDER_READ_ROLES, 'jobwork_quality'];
const SUPPLIER_ROLES = ['org_admin', 'supplier_production', 'supplier_estimator', 'supplier_quality'];
const OPEN_MILESTONE = new Set(['not_ready', 'ready', 'in_progress', 'evidence_submitted', 'rejected_evidence', 'blocked']);
/** A supplier's observation older than this is a backdate, which needs JobWork's enhanced permission. */
const SUPPLIER_BACKDATE_WINDOW_MS = 48 * 3_600_000;

type Opts = { idempotencyKey?: string | undefined };

class ProductionRefusal extends DomainError {
  constructor(code: string, title: string, detail?: string, status = 409) {
    super(code, status, title, detail);
  }
}

class NotFound extends DomainError {
  constructor(what: string) {
    super(`${what.toUpperCase().replace(/ /g, '_')}_NOT_FOUND`, 404, `${what[0]!.toUpperCase()}${what.slice(1)} not found`);
  }
}

/**
 * Technical baseline, transmittals, production release and milestones (IN-09).
 *
 * The rules this class exists to keep: a released baseline never changes (`BR-ENG-03`);
 * a supplier gets exact versions, never a mutable pointer (`BR-ENG-02`); no work starts
 * without every gate green and the transmittal acknowledged (`BR-OPS-01`, `BR-ENG-07`);
 * evidence is not verification (`BR-OPS-03`); and the person who submits evidence never
 * verifies it.
 */
@Injectable()
export class ProductionCommand {
  constructor(
    private readonly production: ProductionRepository,
    private readonly orders: OrdersRepository,
    private readonly finance: FinanceRepository,
    private readonly executor: CommandExecutor,
    private readonly db: DatabaseService,
    private readonly audit: AuditWriter,
  ) {}

  // ----------------------------------------------------------------- guards

  private requireInternal(actor: Actor, roles: readonly string[]): void {
    if (!actor.isInternal) throw new NotAuthorized('JobWork only');
    requireRole(actor, ...roles);
  }

  private requireSupplier(actor: Actor): string {
    if (actor.organizationType !== 'supplier') throw new NotAuthorized('Supplier organizations only');
    requireRole(actor, ...SUPPLIER_ROLES);
    return requireOrganization(actor);
  }

  private checkVersion(expected: number, actual: number): void {
    if (expected !== actual) throw new OrderVersionConflict(expected, actual);
  }

  // ----------------------------------------------------------------- views

  transmittal(row: TransmittalRecord): Transmittal {
    return {
      transmittalId: row.id,
      number: row.number,
      baselineId: row.baselineId,
      baselineNumber: row.baselineNumber,
      purchaseOrderId: row.purchaseOrderId,
      purchaseOrderNumber: row.purchaseOrderNumber,
      recipientOrganizationId: row.recipientOrganizationId,
      recipientDisplayName: row.recipientDisplayName,
      manifestHash: row.manifestHash,
      status: row.status,
      acknowledgmentDueAt: row.acknowledgmentDueAt.toISOString(),
      issuedAt: row.issuedAt.toISOString(),
      acknowledgedAt: row.acknowledgedAt ? row.acknowledgedAt.toISOString() : null,
      acknowledgmentNote: row.acknowledgmentNote,
      overdue: row.status === 'issued' && row.acknowledgmentDueAt.getTime() < Date.now(),
      aggregateVersion: row.aggregateVersion,
    };
  }

  private async baseline(row: BaselineRecord): Promise<Baseline> {
    return {
      baselineId: row.id,
      number: row.number,
      salesOrderId: row.salesOrderId,
      kind: row.kind,
      status: row.status,
      note: row.note,
      manifestHash: row.manifestHash,
      items: row.items,
      conflicts: row.status === 'draft' ? governingConflicts(row.items) : [],
      releasedAt: row.releasedAt ? row.releasedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      transmittals: (await this.production.listTransmittalsForBaseline(row.id)).map((t) => this.transmittal(t)),
      aggregateVersion: row.aggregateVersion,
    };
  }

  milestone(row: MilestoneRecord): Milestone {
    return {
      milestoneId: row.id,
      seq: row.seq,
      title: row.title,
      customerLabel: row.customerLabel,
      evidencePolicy: row.evidencePolicy,
      minEvidence: row.minEvidence,
      verifierRole: row.verifierRole,
      status: row.status,
      plannedDate: row.plannedDate,
      forecastDate: row.forecastDate,
      actualDate: row.actualDate,
      startedAt: row.startedAt ? row.startedAt.toISOString() : null,
      submittedAt: row.submittedAt ? row.submittedAt.toISOString() : null,
      decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
      decisionReason: row.decisionReason,
      backdateReason: row.backdateReason,
      forecasts: row.forecasts.map((f) => ({ ...f, recordedAt: f.recordedAt.toISOString() })),
      evidence: row.evidence.map((e) => ({
        evidenceId: e.id,
        documentId: e.documentId,
        documentVersionId: e.documentVersionId,
        filename: e.filename,
        fileSha256: e.fileSha256,
        scanState: e.scanState,
        observedAt: e.observedAt.toISOString(),
        submittedAt: e.submittedAt.toISOString(),
        flagged: e.flagged,
        flagReason: e.flagReason,
        note: e.note,
      })),
      aggregateVersion: row.aggregateVersion,
    };
  }

  /** The live gate matrix for a work package, from authoritative records only. */
  private async gatesFor(wp: WorkPackageRecord, tx?: PoolClient) {
    const [order, po, baseline, transmittal, supplier, stop] = await parallelReads(tx, [
      () => this.orders.findSalesOrder(wp.salesOrderId, tx),
      () => this.orders.findPurchaseOrder(wp.purchaseOrderId, tx),
      () => this.production.releasedBaseline(wp.salesOrderId, tx),
      () => this.production.liveTransmittal(wp.purchaseOrderId, tx),
      () => this.production.supplierStanding(wp.supplierOrganizationId, tx),
      () => this.production.activeStop(wp.purchaseOrderId, tx),
    ]);
    const holds = order ? await this.finance.listActiveHolds(order.customerOrganizationId, tx) : [];
    const gates = computeReleaseGates({
      order: { status: order?.status ?? 'cancelled', commercialReleasedAt: order?.commercialReleasedAt ? order.commercialReleasedAt.toISOString() : null },
      activeHolds: holds.map((h) => ({ reason: h.reason })),
      baseline: baseline && baseline.manifestHash ? { baselineId: baseline.id, number: baseline.number, manifestHash: baseline.manifestHash } : null,
      transmittal: transmittal
        ? { transmittalId: transmittal.id, number: transmittal.number, status: transmittal.status, manifestHash: transmittal.manifestHash, acknowledgedAt: transmittal.acknowledgedAt ? transmittal.acknowledgedAt.toISOString() : null }
        : null,
      purchaseOrder: { number: po?.number ?? '', status: po?.status ?? 'cancelled', contentHash: po?.contentHash ?? '' },
      plan: { plannedStart: wp.plannedStart, plannedFinish: wp.plannedFinish, milestoneCount: wp.milestones.length },
      supplier,
      qualityPlanPresent: wp.qualityPlanPresent,
      interimStop: stop ? { changeNumber: stop.changeNumber, reason: stop.reason, expiresAt: stop.expiresAt.toISOString() } : null,
    });
    return { gates, baseline, transmittal, po };
  }

  private async workPackage(row: WorkPackageRecord): Promise<WorkPackage> {
    const [{ gates }, containment, baselinesUsed] = await Promise.all([this.gatesFor(row), this.production.listContainment(row.purchaseOrderId), this.production.baselinesUsed(row.id)]);
    return {
      workPackageId: row.id,
      number: row.number,
      salesOrderId: row.salesOrderId,
      salesOrderNumber: row.salesOrderNumber,
      purchaseOrderId: row.purchaseOrderId,
      purchaseOrderNumber: row.purchaseOrderNumber,
      supplierOrganizationId: row.supplierOrganizationId,
      supplierDisplayName: row.supplierDisplayName,
      status: row.status,
      plannedStart: row.plannedStart,
      plannedFinish: row.plannedFinish,
      qualityPlanPresent: row.qualityPlanPresent,
      planningNote: row.planningNote,
      gates,
      allGreen: gates.every((g) => g.pass),
      releaseSnapshot: row.releaseSnapshot,
      releasedAt: row.releasedAt ? row.releasedAt.toISOString() : null,
      completedAt: row.completedAt ? row.completedAt.toISOString() : null,
      milestones: row.milestones.map((m) => this.milestone(m)),
      containment: containment.map((c) => ({
        containmentId: c.id,
        kind: c.kind,
        description: c.description,
        reportedAt: c.reportedAt.toISOString(),
        disposition: c.disposition,
        disposedAt: c.disposedAt ? c.disposedAt.toISOString() : null,
      })),
      baselinesUsed: baselinesUsed.map((b) => ({ baselineId: b.baselineId, number: b.number, transmittalNumber: b.transmittalNumber, effectiveFrom: b.effectiveFrom.toISOString() })),
      aggregateVersion: row.aggregateVersion,
    };
  }

  async view(actor: Actor, salesOrderId: string): Promise<ProductionView> {
    this.requireInternal(actor, READ_ROLES);
    const order = await this.orders.findSalesOrder(salesOrderId);
    if (!order) throw new OrderNotFound();
    const [baselines, workPackages, pos] = await Promise.all([
      this.production.listBaselines(salesOrderId),
      this.production.listWorkPackagesForOrder(salesOrderId),
      this.orders.listPurchaseOrdersForSalesOrder(salesOrderId),
    ]);
    return {
      order: { salesOrderId: order.id, number: order.number, title: order.title, customerDisplayName: order.customerDisplayName, status: order.status, deliveryLeadDays: order.deliveryLeadDays },
      purchaseOrders: pos.map((p) => ({ purchaseOrderId: p.id, number: p.number, supplierDisplayName: p.supplierDisplayName, status: p.status, leadTimeDays: p.leadTimeDays })),
      baselines: await Promise.all(baselines.map((b) => this.baseline(b))),
      workPackages: await Promise.all(workPackages.map((w) => this.workPackage(w))),
    };
  }

  async verificationQueue(actor: Actor): Promise<VerificationQueueItem[]> {
    this.requireInternal(actor, READ_ROLES);
    return (await this.production.verificationQueue()).map((row) => ({ ...(row as unknown as VerificationQueueItem), submittedAt: (row['submittedAt'] as Date).toISOString() }));
  }

  async candidates(actor: Actor, salesOrderId: string): Promise<BaselineCandidate[]> {
    this.requireInternal(actor, ENGINEERING_ROLES);
    if (!(await this.orders.findSalesOrder(salesOrderId))) throw new OrderNotFound();
    return this.production.baselineCandidates(salesOrderId);
  }

  // ----------------------------------------------------------------- baseline (F-09.2)

  /** Create or replace the order's draft production baseline from chosen, clean versions. */
  async assembleBaseline(actor: Actor, salesOrderId: string, input: AssembleBaselineRequest, opts: Opts = {}): Promise<ProductionView> {
    this.requireInternal(actor, ENGINEERING_ROLES);
    requireTransactionalStrength(actor);
    await this.executor.execute(
      {
        operation: 'dms.assemble-baseline',
        handler: async (tx, _ctx, cmd: AssembleBaselineRequest) => {
          const order = await this.orders.findSalesOrder(salesOrderId, tx, true);
          if (!order) throw new OrderNotFound();
          if (order.status === 'cancelled' || order.status === 'closed') throw new ProductionRefusal('ORDER_NOT_OPEN', 'The order is closed');
          const candidates = new Map((await this.production.baselineCandidates(salesOrderId, tx)).map((c) => [c.documentVersionId, c]));
          const items = cmd.items.map((item) => {
            const candidate = candidates.get(item.documentVersionId);
            if (!candidate) throw new ProductionRefusal('BASELINE_ITEM_NOT_ELIGIBLE', 'That document is not part of this order', `Version ${item.documentVersionId.slice(0, 8)} is neither an enquiry document of this order nor a JobWork document.`, 422);
            if (!candidate.selectable) throw new ProductionRefusal('BASELINE_ITEM_NOT_ELIGIBLE', `${candidate.title} cannot go into a baseline`, candidate.reason ?? undefined, 422);
            return { documentId: candidate.documentId, documentVersionId: candidate.documentVersionId, fileSha256: candidate.fileSha256, purpose: item.purpose, governingPriority: item.governingPriority };
          });
          const draft = await this.production.findDraftBaseline(salesOrderId, tx);
          const baselineId = draft?.id ?? (await this.production.createBaseline({ number: await this.production.allocateNumber('BL', new Date(), tx), salesOrderId, note: cmd.note, createdBy: actor.userId }, tx));
          await this.production.replaceBaselineItems(baselineId, cmd.note, items, tx);
          return {
            result: undefined,
            audit: [{ action: 'dms.baseline_assembled', subjectType: 'baseline', subjectId: baselineId, data: { salesOrderId, items: items.map((i) => ({ documentVersionId: i.documentVersionId, purpose: i.purpose, governingPriority: i.governingPriority })) } }],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.view(actor, salesOrderId);
  }

  /** Freeze the manifest, hash it (doc 07 §13) and supersede the previous released baseline. */
  async releaseBaseline(actor: Actor, baselineId: string, input: BaselineVersionRequest, opts: Opts = {}): Promise<ProductionView> {
    this.requireInternal(actor, ENGINEERING_ROLES);
    requireTransactionalStrength(actor);
    const salesOrderId = await this.executor.execute(
      {
        operation: 'dms.release-baseline',
        handler: async (tx, _ctx, cmd: BaselineVersionRequest) => {
          const baseline = await this.production.findBaseline(baselineId, tx, true);
          if (!baseline) throw new NotFound('baseline');
          this.checkVersion(cmd.expectedVersion, baseline.aggregateVersion);
          if (baseline.status !== 'draft') throw new ProductionRefusal('BASELINE_NOT_DRAFT', 'Only a draft baseline can be released', `${baseline.number} is ${baseline.status}.`);
          if (baseline.items.length === 0) throw new ProductionRefusal('BASELINE_EMPTY', 'The baseline has no documents');
          const conflicts = governingConflicts(baseline.items);
          if (conflicts.length > 0) throw new ProductionRefusal('BASELINE_CONFLICT', 'Conflicting governing documents block release (BR-ENG-06)', conflicts.join(' '));
          // Files can be revoked or re-quarantined after assembly; re-check at the moment of release.
          const candidates = new Map((await this.production.baselineCandidates(baseline.salesOrderId, tx)).map((c) => [c.documentVersionId, c]));
          for (const item of baseline.items) {
            const c = candidates.get(item.documentVersionId);
            if (!c?.selectable) throw new ProductionRefusal('BASELINE_ITEM_NOT_ELIGIBLE', `${item.title} is no longer releasable`, c?.reason ?? 'It is no longer linked to this order.', 422);
          }
          // A baseline in force is only ever replaced through an approved change (FR-604,
          // BR-ENG-05): this command releases the first one, never a successor.
          const inForce = await this.production.releasedBaseline(baseline.salesOrderId, tx);
          if (inForce) {
            throw new ProductionRefusal('BASELINE_CHANGE_REQUIRED', 'A released baseline is already in force', `${inForce.number} governs this order. A new baseline is released only by an approved engineering change.`, 409);
          }
          const manifestHash = baselineHash(baseline.items);
          await this.production.releaseBaseline({ baselineId, manifestHash, releasedBy: actor.userId, supersedes: null }, tx);
          return {
            result: baseline.salesOrderId,
            audit: [{ action: 'dms.baseline_released', subjectType: 'baseline', subjectId: baselineId, subjectVersion: baseline.aggregateVersion + 1, data: { number: baseline.number, manifestHash, items: baseline.items.length } }],
            outbox: [{ eventType: 'dms.baseline_released.v1', aggregateType: 'baseline', aggregateId: baselineId, data: { baselineId, salesOrderId: baseline.salesOrderId, manifestHash } }],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.view(actor, salesOrderId);
  }

  /**
   * One transmittal per purchase order: the exact versions, their hash, an acknowledgment
   * deadline, and an audience grant on each exact version for that supplier only.
   */
  async issueTransmittals(actor: Actor, salesOrderId: string, input: IssueTransmittalsRequest, opts: Opts = {}): Promise<ProductionView> {
    this.requireInternal(actor, ENGINEERING_ROLES);
    requireTransactionalStrength(actor);
    await this.executor.execute(
      {
        operation: 'dms.issue-transmittals',
        handler: async (tx, _ctx, cmd: IssueTransmittalsRequest) => {
          const baseline = await this.production.findBaseline(cmd.baselineId, tx, true);
          if (!baseline || baseline.salesOrderId !== salesOrderId) throw new NotFound('baseline');
          if (baseline.status !== 'released' || !baseline.manifestHash) throw new ProductionRefusal('BASELINE_NOT_RELEASED', 'Only a released baseline can be transmitted');
          const pos = (await this.orders.listPurchaseOrdersForSalesOrder(salesOrderId, tx)).filter((p) => p.status !== 'cancelled');
          if (pos.length === 0) throw new ProductionRefusal('NO_PURCHASE_ORDERS', 'There are no purchase orders to transmit to', 'Issue the purchase orders first.');
          const now = new Date();
          const audit: AuditSpec[] = [];
          const outbox: OutboxSpec[] = [];
          let issued = 0;
          for (const po of pos) {
            const sent = await this.production.transmitBaseline(
              { baseline, purchaseOrderId: po.id, supplierOrganizationId: po.supplierOrganizationId, dueAt: new Date(now.getTime() + cmd.acknowledgmentDays * 86_400_000), issuedBy: actor.userId, now },
              tx,
            );
            if (!sent) continue;
            issued += 1;
            audit.push({ action: 'dms.transmittal_issued', subjectType: 'transmittal', subjectId: sent.transmittalId, data: { number: sent.number, baselineId: baseline.id, purchaseOrderId: po.id, recipientOrganizationId: po.supplierOrganizationId, manifestHash: baseline.manifestHash, grants: sent.grants, supersedes: sent.supersedes } });
            outbox.push({ eventType: 'dms.transmittal_issued.v1', aggregateType: 'transmittal', aggregateId: sent.transmittalId, data: { transmittalId: sent.transmittalId, number: sent.number, recipientOrganizationId: po.supplierOrganizationId } });
          }
          if (issued === 0) throw new ProductionRefusal('TRANSMITTALS_CURRENT', 'Every supplier already has this baseline');
          return { result: undefined, audit, outbox };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.view(actor, salesOrderId);
  }

  // ----------------------------------------------------------------- planning and release (F-09.3)

  async planWorkPackage(actor: Actor, purchaseOrderId: string, input: PlanWorkPackageRequest, opts: Opts = {}): Promise<ProductionView> {
    this.requireInternal(actor, RELEASE_ROLES);
    requireTransactionalStrength(actor);
    if (input.plannedFinish < input.plannedStart) {
      throw new DomainError('VALIDATION_FAILED', 400, 'Request validation failed', undefined, [{ path: 'plannedFinish', message: 'Finish cannot be before start' }]);
    }
    const salesOrderId = await this.executor.execute(
      {
        operation: 'orders.plan-work-package',
        handler: async (tx, _ctx, cmd: PlanWorkPackageRequest) => {
          const po = await this.orders.findPurchaseOrder(purchaseOrderId, tx, true);
          if (!po) throw new PurchaseOrderNotFound();
          if (po.status === 'cancelled') throw new ProductionRefusal('PURCHASE_ORDER_CANCELLED', 'The purchase order is cancelled');
          let wpId = await this.production.workPackageIdForPurchaseOrder(purchaseOrderId, tx);
          if (!wpId) {
            wpId = await this.production.createWorkPackage(
              { number: await this.production.allocateNumber('WP', new Date(), tx), salesOrderId: po.salesOrderId, purchaseOrderId, supplierOrganizationId: po.supplierOrganizationId, createdBy: actor.userId },
              tx,
            );
          }
          const wp = (await this.production.findWorkPackage(wpId, tx, true))!;
          if (wp.status !== 'planned') throw new ProductionRefusal('WORK_PACKAGE_RELEASED', 'A released work package cannot be replanned', 'Report a delay on the milestone instead; the original plan is kept.');
          const milestones = (cmd.milestones ?? defaultMilestones(cmd.plannedStart, cmd.plannedFinish)).map((m) => ({
            title: m.title,
            customerLabel: m.customerLabel ?? null,
            plannedDate: m.plannedDate,
            evidencePolicy: m.evidencePolicy,
            minEvidence: m.minEvidence,
          }));
          await this.production.updatePlan({ workPackageId: wpId, plannedStart: cmd.plannedStart, plannedFinish: cmd.plannedFinish, planningNote: cmd.planningNote }, tx);
          await this.production.replaceMilestones(wpId, milestones, tx);
          return {
            result: po.salesOrderId,
            audit: [{ action: 'orders.work_package_planned', subjectType: 'work_package', subjectId: wpId, data: { purchaseOrderId, plannedStart: cmd.plannedStart, plannedFinish: cmd.plannedFinish, milestones: milestones.length } }],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.view(actor, salesOrderId);
  }

  /** `releaseWorkPackageToProduction` (doc 06 §7): every gate green, inside the transaction, with a snapshot. */
  async releaseWorkPackage(actor: Actor, workPackageId: string, input: WorkPackageVersionRequest, opts: Opts = {}): Promise<ProductionView> {
    this.requireInternal(actor, RELEASE_ROLES);
    requireTransactionalStrength(actor);
    const salesOrderId = await this.executor.execute(
      {
        operation: 'orders.release-work-package',
        handler: async (tx, _ctx, cmd: WorkPackageVersionRequest) => {
          const wp = await this.production.findWorkPackage(workPackageId, tx, true);
          if (!wp) throw new NotFound('work package');
          this.checkVersion(cmd.expectedVersion, wp.aggregateVersion);
          if (wp.status !== 'planned') throw new ProductionRefusal('WORK_PACKAGE_RELEASED', 'Already released');
          const { gates, baseline, transmittal, po } = await this.gatesFor(wp, tx);
          const red = gates.filter((g) => !g.pass);
          if (red.length > 0) {
            throw new ProductionRefusal('RELEASE_GATE_RED', `Release blocked by ${red.map((g) => g.label.toLowerCase()).join(', ')}`, red.flatMap((g) => g.reasons).join(' '));
          }
          const snapshot = {
            gates,
            baseline: { baselineId: baseline!.id, number: baseline!.number, manifestHash: baseline!.manifestHash },
            transmittal: { transmittalId: transmittal!.id, number: transmittal!.number, acknowledgedAt: transmittal!.acknowledgedAt?.toISOString() ?? null },
            purchaseOrder: { number: po!.number, contentHash: po!.contentHash },
            releasedBy: actor.userId,
            releasedAt: new Date().toISOString(),
          };
          await this.production.setWorkPackageStatus({ workPackageId, status: 'released', release: { snapshot, by: actor.userId } }, tx);
          await this.production.recordWorkPackageBaseline({ workPackageId, baselineId: baseline!.id, transmittalId: transmittal!.id, by: actor.userId }, tx);
          await this.production.makeReady(workPackageId, 1, tx);
          const order = await this.orders.findSalesOrder(wp.salesOrderId, tx, true);
          if (order && (order.status === 'pending_technical_release' || order.status === 'planning')) {
            await this.orders.setSalesOrderStatus({ orderId: order.id, status: 'released_to_production' }, tx);
          }
          return {
            result: wp.salesOrderId,
            audit: [{ action: 'orders.work_package_released', subjectType: 'work_package', subjectId: workPackageId, subjectVersion: wp.aggregateVersion + 1, data: { number: wp.number, manifestHash: baseline!.manifestHash, transmittal: transmittal!.number } }],
            outbox: [{ eventType: 'orders.work_package_released.v1', aggregateType: 'work_package', aggregateId: workPackageId, data: { workPackageId, supplierOrganizationId: wp.supplierOrganizationId, salesOrderId: wp.salesOrderId } }],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.view(actor, salesOrderId);
  }

  async recordContainment(actor: Actor, purchaseOrderId: string, input: RecordContainmentRequest, opts: Opts = {}): Promise<ProductionView> {
    this.requireInternal(actor, [...RELEASE_ROLES, 'jobwork_quality']);
    requireTransactionalStrength(actor);
    const salesOrderId = await this.executor.execute(
      {
        operation: 'orders.record-containment',
        handler: async (tx, _ctx, cmd: RecordContainmentRequest) => {
          const po = await this.orders.findPurchaseOrder(purchaseOrderId, tx);
          if (!po) throw new PurchaseOrderNotFound();
          const wpId = await this.production.workPackageIdForPurchaseOrder(purchaseOrderId, tx);
          const id = await this.production.recordContainment({ purchaseOrderId, workPackageId: wpId, kind: cmd.kind, description: cmd.description, reportedBy: actor.userId }, tx);
          return {
            result: po.salesOrderId,
            audit: [{ action: 'orders.containment_recorded', subjectType: 'purchase_order', subjectId: purchaseOrderId, reason: cmd.description, data: { containmentId: id, kind: cmd.kind } }],
            outbox: [{ eventType: 'orders.containment_recorded.v1', aggregateType: 'purchase_order', aggregateId: purchaseOrderId, data: { containmentId: id, kind: cmd.kind } }],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.view(actor, salesOrderId);
  }

  // ----------------------------------------------------------------- milestones (F-09.4)

  private async lockedMilestone(milestoneId: string, expectedVersion: number, tx: PoolClient): Promise<{ milestone: MilestoneRecord; wp: WorkPackageRecord }> {
    const milestone = await this.production.findMilestone(milestoneId, tx, true);
    if (!milestone) throw new NotFound('milestone');
    const wp = (await this.production.findWorkPackage(milestone.workPackageId, tx, true))!;
    this.checkVersion(expectedVersion, milestone.aggregateVersion);
    return { milestone, wp };
  }

  /** After a milestone closes: open the next, or complete the package (and maybe the order's production). */
  private async advance(wp: WorkPackageRecord, milestone: MilestoneRecord, tx: PoolClient): Promise<{ completed: boolean; orderAdvanced: boolean }> {
    const next = wp.milestones.find((m) => m.seq === milestone.seq + 1);
    if (next) {
      await this.production.makeReady(wp.id, next.seq, tx);
      return { completed: false, orderAdvanced: false };
    }
    await this.production.setWorkPackageStatus({ workPackageId: wp.id, status: 'completed', completed: true }, tx);
    let orderAdvanced = false;
    if (await this.production.allWorkPackagesComplete(wp.salesOrderId, tx)) {
      const order = await this.orders.findSalesOrder(wp.salesOrderId, tx, true);
      if (order && ['released_to_production', 'in_production', 'quality_released'].includes(order.status)) {
        await this.orders.setSalesOrderStatus({ orderId: order.id, status: 'ready_supplier_dispatch' }, tx);
        orderAdvanced = true;
      }
    }
    return { completed: true, orderAdvanced };
  }

  async verifyMilestone(actor: Actor, milestoneId: string, input: VerifyMilestoneRequest, opts: Opts = {}): Promise<ProductionView> {
    if (!actor.isInternal) throw new NotAuthorized('JobWork only');
    requireTransactionalStrength(actor);
    const salesOrderId = await this.executor.execute(
      {
        operation: 'orders.verify-milestone',
        handler: async (tx, _ctx, cmd: VerifyMilestoneRequest) => {
          const { milestone, wp } = await this.lockedMilestone(milestoneId, cmd.expectedVersion, tx);
          requireRole(actor, milestone.verifierRole);
          if (milestone.status !== 'evidence_submitted') throw new ProductionRefusal('MILESTONE_NOT_SUBMITTED', 'There is no submitted evidence to decide on', `The milestone is ${milestone.status.replace(/_/g, ' ')}.`);
          if (milestone.evidence.some((e) => e.submittedBy === actor.userId)) {
            throw new ProductionRefusal('VERIFIER_SEPARATION', 'You cannot verify evidence you submitted', 'Ask another verifier.');
          }
          if (cmd.decision === 'rejected_evidence') {
            if (cmd.reason.trim().length < 3) throw new DomainError('VALIDATION_FAILED', 400, 'Request validation failed', undefined, [{ path: 'reason', message: 'Say what is missing' }]);
            await this.production.setMilestone({ milestoneId, status: 'rejected_evidence', decided: { by: actor.userId, reason: cmd.reason, actualDate: null, backdateReason: null } }, tx);
            return {
              result: wp.salesOrderId,
              audit: [{ action: 'orders.milestone_evidence_rejected', subjectType: 'milestone', subjectId: milestoneId, reason: cmd.reason, data: { workPackageId: wp.id } }],
              outbox: [{ eventType: 'orders.milestone_evidence_rejected.v1', aggregateType: 'milestone', aggregateId: milestoneId, data: { milestoneId, supplierOrganizationId: wp.supplierOrganizationId } }],
            };
          }
          if (milestone.evidencePolicy !== 'none') {
            if (milestone.evidence.length < milestone.minEvidence) throw new ProductionRefusal('EVIDENCE_INSUFFICIENT', 'Not enough evidence', `This milestone needs ${milestone.minEvidence} item(s).`);
            const unclean = milestone.evidence.filter((e) => e.scanState !== 'clean');
            if (unclean.length > 0) throw new ProductionRefusal('EVIDENCE_NOT_CLEAN', 'Evidence is still being scanned or was refused', unclean.map((e) => `${e.filename}: ${e.scanState}`).join('; '));
          }
          const today = todayInIndia();
          const actualDate = cmd.actualDate ?? today;
          if (actualDate > today) throw new DomainError('VALIDATION_FAILED', 400, 'Request validation failed', undefined, [{ path: 'actualDate', message: 'Cannot be in the future' }]);
          const submittedDay = milestone.submittedAt ? todayInIndia(milestone.submittedAt) : today;
          let backdateReason: string | null = null;
          if (actualDate < submittedDay) {
            // BR-OPS-04 / FR-506: enhanced permission and a reason, both kept with the record.
            if (!actor.roles.includes('jobwork_quality') || !cmd.backdateReason || cmd.backdateReason.trim().length < 10) {
              throw new ProductionRefusal('BACKDATE_NOT_PERMITTED', 'Backdating needs quality authority and a reason', 'Recording an actual date earlier than the evidence submission requires jobwork_quality and a reason of at least ten characters.', 403);
            }
            backdateReason = cmd.backdateReason.trim();
          }
          await this.production.setMilestone({ milestoneId, status: 'verified', decided: { by: actor.userId, reason: cmd.reason || null, actualDate, backdateReason } }, tx);
          const advanced = await this.advance(wp, milestone, tx);
          const audit: AuditSpec[] = [{ action: 'orders.milestone_verified', subjectType: 'milestone', subjectId: milestoneId, data: { workPackageId: wp.id, actualDate, backdateReason, evidence: milestone.evidence.map((e) => e.fileSha256), ...advanced } }];
          const outbox: OutboxSpec[] = [{ eventType: 'orders.milestone_verified.v1', aggregateType: 'milestone', aggregateId: milestoneId, data: { milestoneId, salesOrderId: wp.salesOrderId, customerVisible: milestone.customerLabel !== null } }];
          if (advanced.completed) outbox.push({ eventType: 'orders.work_package_completed.v1', aggregateType: 'work_package', aggregateId: wp.id, data: { workPackageId: wp.id, salesOrderId: wp.salesOrderId } });
          return { result: wp.salesOrderId, audit, outbox };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.view(actor, salesOrderId);
  }

  async waiveMilestone(actor: Actor, milestoneId: string, input: WaiveMilestoneRequest, opts: Opts = {}): Promise<ProductionView> {
    this.requireInternal(actor, ['jobwork_quality']);
    requireTransactionalStrength(actor);
    const salesOrderId = await this.executor.execute(
      {
        operation: 'orders.waive-milestone',
        handler: async (tx, _ctx, cmd: WaiveMilestoneRequest) => {
          const { milestone, wp } = await this.lockedMilestone(milestoneId, cmd.expectedVersion, tx);
          if (!OPEN_MILESTONE.has(milestone.status) || milestone.status === 'not_ready') throw new ProductionRefusal('MILESTONE_NOT_WAIVABLE', 'This milestone cannot be waived now', `It is ${milestone.status.replace(/_/g, ' ')}.`);
          await this.production.setMilestone({ milestoneId, status: 'waived', decided: { by: actor.userId, reason: cmd.reason, actualDate: null, backdateReason: null } }, tx);
          const advanced = await this.advance(wp, milestone, tx);
          return {
            result: wp.salesOrderId,
            audit: [{ action: 'orders.milestone_waived', subjectType: 'milestone', subjectId: milestoneId, reason: cmd.reason, data: { workPackageId: wp.id, ...advanced } }],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.view(actor, salesOrderId);
  }

  /** A delay appends a forecast revision; the original plan stays (FR-505). Supplier or JobWork. */
  async reportDelay(actor: Actor, milestoneId: string, input: ReportDelayRequest, opts: Opts = {}): Promise<Milestone> {
    const supplierOrg = actor.isInternal ? null : this.requireSupplier(actor);
    if (actor.isInternal) {
      requireRole(actor, ...RELEASE_ROLES, 'jobwork_quality');
      requireTransactionalStrength(actor);
    }
    await this.executor.execute(
      {
        operation: 'orders.report-delay',
        handler: async (tx, _ctx, cmd: ReportDelayRequest) => {
          const { milestone, wp } = await this.lockedMilestone(milestoneId, cmd.expectedVersion, tx);
          if (supplierOrg && wp.supplierOrganizationId !== supplierOrg) throw new NotFound('milestone');
          if (!OPEN_MILESTONE.has(milestone.status)) throw new ProductionRefusal('MILESTONE_CLOSED', 'A closed milestone cannot be delayed');
          const revision = await this.production.appendForecast({ milestoneId, forecastDate: cmd.forecastDate, reasonCode: cmd.reasonCode, reason: cmd.reason, by: actor.userId }, tx);
          return {
            result: undefined,
            audit: [{ action: 'orders.milestone_forecast_revised', subjectType: 'milestone', subjectId: milestoneId, reason: cmd.reason, data: { revision, plannedDate: milestone.plannedDate, forecastDate: cmd.forecastDate, reasonCode: cmd.reasonCode, workPackageId: wp.id } }],
            outbox: [{ eventType: 'orders.milestone_delayed.v1', aggregateType: 'milestone', aggregateId: milestoneId, data: { milestoneId, salesOrderId: wp.salesOrderId, forecastDate: cmd.forecastDate } }],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.milestone((await this.production.findMilestone(milestoneId))!);
  }

  // ----------------------------------------------------------------- supplier side

  async supplierProduction(actor: Actor, purchaseOrderId: string): Promise<SupplierProduction> {
    const organizationId = this.requireSupplier(actor);
    const po = await this.orders.findPurchaseOrder(purchaseOrderId);
    if (!po || po.supplierOrganizationId !== organizationId) throw new PurchaseOrderNotFound();
    const [transmittal, wpId] = await Promise.all([this.production.liveTransmittal(purchaseOrderId), this.production.workPackageIdForPurchaseOrder(purchaseOrderId)]);
    const baseline = transmittal ? await this.production.findBaseline(transmittal.baselineId) : null;
    const wp = wpId ? await this.production.findWorkPackage(wpId) : null;
    return {
      purchaseOrderId,
      transmittal:
        transmittal && baseline
          ? {
              transmittalId: transmittal.id,
              number: transmittal.number,
              status: transmittal.status,
              manifestHash: transmittal.manifestHash,
              acknowledgmentDueAt: transmittal.acknowledgmentDueAt.toISOString(),
              acknowledgedAt: transmittal.acknowledgedAt ? transmittal.acknowledgedAt.toISOString() : null,
              // F-FP.4: a baseline's documents are never the supplier's own; it meets them under JobWork's names.
              items: baseline.items.map((i) => ({ documentVersionId: i.documentVersionId, title: neutralTitle(i.documentVersionId), logicalType: i.logicalType, versionNo: i.versionNo, filename: neutralFilename(i.documentVersionId, i.filename), fileSha256: i.fileSha256, purpose: i.purpose })),
              aggregateVersion: transmittal.aggregateVersion,
            }
          : null,
      workPackage: wp
        ? {
            workPackageId: wp.id,
            number: wp.number,
            status: wp.status,
            plannedStart: wp.plannedStart,
            plannedFinish: wp.plannedFinish,
            released: wp.releasedAt !== null,
            milestones: wp.milestones.map((m) => {
              const { verifierRole: _v, customerLabel: _c, ...rest } = this.milestone(m);
              return rest;
            }),
            aggregateVersion: wp.aggregateVersion,
          }
        : null,
    };
  }

  async acknowledgeTransmittal(actor: Actor, transmittalId: string, input: AcknowledgeTransmittalRequest, opts: Opts = {}): Promise<SupplierProduction> {
    const organizationId = this.requireSupplier(actor);
    const purchaseOrderId = await this.executor.execute(
      {
        operation: 'dms.acknowledge-transmittal',
        handler: async (tx, _ctx, cmd: AcknowledgeTransmittalRequest) => {
          const t = await this.production.findTransmittal(transmittalId, tx, true);
          if (!t || t.recipientOrganizationId !== organizationId) throw new NotFound('transmittal');
          this.checkVersion(cmd.expectedVersion, t.aggregateVersion);
          if (t.status !== 'issued') throw new ProductionRefusal('TRANSMITTAL_NOT_OPEN', 'This transmittal is not waiting for acknowledgment', `It is ${t.status}.`);
          await this.production.acknowledgeTransmittal({ transmittalId, by: actor.userId, note: cmd.note }, tx);
          // From now this supplier's work package follows the acknowledged baseline (BR-ENG-04).
          const wpId = await this.production.workPackageIdForPurchaseOrder(t.purchaseOrderId, tx);
          const wpRow = wpId ? await this.production.findWorkPackage(wpId, tx) : null;
          if (wpRow?.releasedAt) await this.production.recordWorkPackageBaseline({ workPackageId: wpRow.id, baselineId: t.baselineId, transmittalId, by: actor.userId }, tx);
          return {
            result: t.purchaseOrderId,
            audit: [{ action: 'dms.transmittal_acknowledged', subjectType: 'transmittal', subjectId: transmittalId, data: { number: t.number, manifestHash: t.manifestHash, note: cmd.note, late: t.acknowledgmentDueAt.getTime() < Date.now() } }],
            outbox: [{ eventType: 'dms.transmittal_acknowledged.v1', aggregateType: 'transmittal', aggregateId: transmittalId, data: { transmittalId, purchaseOrderId: t.purchaseOrderId } }],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.supplierProduction(actor, purchaseOrderId);
  }

  async startMilestone(actor: Actor, milestoneId: string, input: MilestoneVersionRequest, opts: Opts = {}): Promise<SupplierProduction> {
    const organizationId = this.requireSupplier(actor);
    const peek = await this.production.findMilestone(milestoneId);
    const peekWp = peek ? await this.production.findWorkPackage(peek.workPackageId) : null;
    if (!peek || !peekWp || peekWp.supplierOrganizationId !== organizationId) throw new NotFound('milestone');
    if (!peekWp.releasedAt) {
      // doc 19 §5: record the attempt as containment, in its own transaction, then refuse.
      await this.db.withTransaction(async (tx) => {
        const id = await this.production.recordContainment(
          { purchaseOrderId: peekWp.purchaseOrderId, workPackageId: peekWp.id, kind: 'unauthorized_start', description: `Supplier tried to start "${peek.title}" before production release.`, reportedBy: actor.userId },
          tx,
        );
        await this.audit.write(tx, contextFromActor(actor), { action: 'orders.unauthorized_start_recorded', subjectType: 'work_package', subjectId: peekWp.id, data: { containmentId: id, milestoneId } });
      });
      throw new ProductionRefusal('WORK_PACKAGE_NOT_RELEASED', 'Work may not start yet', 'JobWork has not released this work package to production. The attempt has been recorded; do not cut material or run parts until release.');
    }
    await this.executor.execute(
      {
        operation: 'orders.start-milestone',
        handler: async (tx, _ctx, cmd: MilestoneVersionRequest) => {
          const { milestone, wp } = await this.lockedMilestone(milestoneId, cmd.expectedVersion, tx);
          if (milestone.status !== 'ready') throw new ProductionRefusal('MILESTONE_NOT_READY', 'This milestone cannot start yet', milestone.status === 'not_ready' ? 'The previous milestone is not verified yet.' : `It is ${milestone.status.replace(/_/g, ' ')}.`);
          // IN-13: an interim stop holds new work, and a new baseline must be acknowledged
          // before anything more is made to it (BR-ENG-07).
          const stop = await this.production.activeStop(wp.purchaseOrderId, tx);
          if (stop) throw new ProductionRefusal('INTERIM_STOP', `Work on this order is stopped under change ${stop.changeNumber}`, stop.reason);
          const live = await this.production.liveTransmittal(wp.purchaseOrderId, tx);
          if (live && live.status !== 'acknowledged') {
            throw new ProductionRefusal('TRANSMITTAL_NOT_ACKNOWLEDGED', 'Acknowledge the current transmittal first', `Transmittal ${live.number} carries baseline ${live.baselineNumber}; work continues once you acknowledge it.`);
          }
          await this.production.setMilestone({ milestoneId, status: 'in_progress', started: actor.userId }, tx);
          if (wp.status === 'released') await this.production.setWorkPackageStatus({ workPackageId: wp.id, status: 'in_production' }, tx);
          const order = await this.orders.findSalesOrder(wp.salesOrderId, tx, true);
          if (order?.status === 'released_to_production') await this.orders.setSalesOrderStatus({ orderId: order.id, status: 'in_production' }, tx);
          return { result: undefined, audit: [{ action: 'orders.milestone_started', subjectType: 'milestone', subjectId: milestoneId, data: { workPackageId: wp.id } }] };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.supplierProduction(actor, peekWp.purchaseOrderId);
  }

  /** Evidence goes in; the milestone waits for a verifier (`BR-OPS-03`). */
  async submitEvidence(actor: Actor, milestoneId: string, input: SubmitEvidenceRequest, opts: Opts = {}): Promise<SupplierProduction> {
    const organizationId = this.requireSupplier(actor);
    const purchaseOrderId = await this.executor.execute(
      {
        operation: 'orders.submit-milestone-evidence',
        handler: async (tx, _ctx, cmd: SubmitEvidenceRequest) => {
          const { milestone, wp } = await this.lockedMilestone(milestoneId, cmd.expectedVersion, tx);
          if (wp.supplierOrganizationId !== organizationId) throw new NotFound('milestone');
          if (milestone.status !== 'in_progress' && milestone.status !== 'rejected_evidence') {
            throw new ProductionRefusal('MILESTONE_NOT_IN_PROGRESS', 'Start the milestone before submitting evidence', `It is ${milestone.status.replace(/_/g, ' ')}.`);
          }
          // The baseline the supplier actually works to: the one it last acknowledged, not
          // whatever was released since (BR-ENG-04, BR-ENG-07).
          const baseline = { id: await this.production.acknowledgedBaselineId(wp.purchaseOrderId, tx) };
          const now = Date.now();
          const flags: string[] = [];
          for (const item of cmd.items) {
            const version = await this.production.supplierVersion(item.documentVersionId, organizationId, tx);
            if (!version) throw new ProductionRefusal('EVIDENCE_NOT_FOUND', 'That file is not one of your uploads', undefined, 422);
            if (version.status === 'quarantined' || version.status === 'revoked') throw new ProductionRefusal('EVIDENCE_REFUSED', 'That file was refused by the scanner', undefined, 422);
            const observedAt = item.observedAt ? new Date(item.observedAt) : new Date(now);
            if (observedAt.getTime() > now + 5 * 60_000) throw new DomainError('VALIDATION_FAILED', 400, 'Request validation failed', undefined, [{ path: 'observedAt', message: 'Cannot be in the future' }]);
            if (now - observedAt.getTime() > SUPPLIER_BACKDATE_WINDOW_MS) {
              throw new ProductionRefusal('BACKDATE_NOT_PERMITTED', 'Evidence observed more than two days ago cannot be backdated by the supplier', 'Ask JobWork quality to record it with a reason.', 403);
            }
            const flagReason = await this.production.evidenceReuse(version.sha256, milestoneId, tx);
            if (flagReason) flags.push(flagReason);
            await this.production.addEvidence({ milestoneId, documentVersionId: item.documentVersionId, fileSha256: version.sha256, baselineId: baseline?.id ?? null, note: item.note, observedAt, submittedBy: actor.userId, flagReason }, tx);
          }
          const total = milestone.evidence.length + cmd.items.length;
          if (milestone.evidencePolicy !== 'none' && total < milestone.minEvidence) {
            throw new ProductionRefusal('EVIDENCE_INSUFFICIENT', 'Not enough evidence', `This milestone needs ${milestone.minEvidence} item(s).`, 422);
          }
          await this.production.setMilestone({ milestoneId, status: 'evidence_submitted', submitted: actor.userId }, tx);
          return {
            result: wp.purchaseOrderId,
            audit: [{ action: 'orders.milestone_evidence_submitted', subjectType: 'milestone', subjectId: milestoneId, data: { workPackageId: wp.id, items: cmd.items.length, flags, baselineId: baseline?.id ?? null } }],
            outbox: [{ eventType: 'orders.milestone_evidence_submitted.v1', aggregateType: 'milestone', aggregateId: milestoneId, data: { milestoneId, flagged: flags.length > 0 } }],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.supplierProduction(actor, purchaseOrderId);
  }
}
