import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { AuthorizeReleaseRequest, QualityRelease, ReleaseChecklist, ReleaseFactsView, ReleaseScope } from '@jobwork/contracts';
import { type Actor, requireTransactionalStrength } from '../../iam';
import { contextFromActor } from '../../../platform/commands/command';
import { CommandExecutor } from '../../../platform/commands/execute';
import { DomainError } from '../../../platform/http/domain-error';
import { QualityRefused } from '../domain/inspection';
import { Rational } from '../domain/rational';
import { computeChecklist, type CountedInspection, type ReleaseFacts, snapshotHash } from '../domain/release-checklist';
import { NcrRepository } from '../infrastructure/ncr.repository';
import { QualityRepository } from '../infrastructure/quality.repository';
import { type ReleaseRow, ReleaseRepository } from '../infrastructure/release.repository';
import { QUALITY, QUALITY_READERS, requireInternal } from './quality-plan.command';

type Opts = { idempotencyKey?: string | undefined };

const path = (outcome: string | null): 'rework' | 'deviation' | 'rejected' | 'open' =>
  outcome === 'verified' ? 'rework' : outcome === 'deviation_approved' ? 'deviation' : outcome === 'rejected' ? 'rejected' : 'open';

/**
 * Quality release (IN-15 F-15.4; doc 09 §14; FR-706; BR-QLT-01, BR-QLT-03). JobWork quality's
 * independent decision over the computed checklist, for a stated quantity and its lots and
 * serials. The release is frozen with its checklist and SHA-256; a later defect opens a new
 * hold and never rewrites it. `facts` is what the dispatch gate reads.
 */
@Injectable()
export class QualityReleaseCommand {
  constructor(
    private readonly releases: ReleaseRepository,
    private readonly quality: QualityRepository,
    private readonly ncrs: NcrRepository,
    private readonly executor: CommandExecutor,
  ) {}

  private async gather(scope: ReleaseScope, releaser: Actor, tx?: PoolClient): Promise<{ facts: ReleaseFacts; deviationNumbers: Map<string, string>; workPackageNumber: string; purchaseOrderNumber: string }> {
    const wp = await this.quality.workPackage(scope.workPackageId, tx);
    if (!wp) throw new DomainError('WORK_PACKAGE_NOT_FOUND', 404, 'Work package not found');
    const plan = (await this.quality.plansFor(wp.id, tx)).find((p) => p.status === 'approved');
    const inspections = (await this.quality.inspections({ workPackageId: wp.id }, tx)).filter((i) => i.status !== 'invalidated');
    const latestByStage = new Map<string, CountedInspection>();
    for (const i of [...inspections].sort((a, b) => b.plannedAt.getTime() - a.plannedAt.getTime())) {
      if (latestByStage.has(i.stage)) continue;
      const failing = await this.releases.failing(i.id, tx);
      latestByStage.set(i.stage, {
        id: i.id,
        number: i.number,
        stage: i.stage,
        status: i.status,
        submittedBy: i.submittedBy,
        failing: failing.map((f) => ({ characteristic: f.characteristic, sampleNo: f.sampleNo, covered: f.deviationExpiresAt !== null && f.deviationExpiresAt.getTime() > Date.now() })),
        calibrationFlags: await this.releases.calibrationFlags(i.id, tx),
        attachments: await this.releases.attachments(i.id, tx),
      });
    }
    const history = await this.releases.releases(wp.id, tx);
    const deviations = await this.releases.activeDeviations(wp.id, tx);
    const ncrs = await this.releases.ncrs(wp.id, tx);
    const sum = (rows: ReleaseRow[]): string => rows.reduce((t, r) => t.add(Rational.parse(r.quantity)), Rational.of(0)).toDisplay(4);
    const facts: ReleaseFacts = {
      releasedBaseline: await this.quality.releasedBaseline(wp.salesOrderId, tx),
      acknowledgedBaselineId: await this.releases.acknowledgedBaselineId(wp.purchaseOrderId, tx),
      milestones: await this.releases.milestones(wp.id, tx),
      planStages: plan ? plan.stages.map((s) => s.stage) : [],
      latestByStage,
      ncrs: ncrs.map((n) => ({ number: n.number, status: n.status, path: path(n.outcome), lots: n.lots })),
      activeDeviations: deviations.map((d) => ({ id: d.id, number: d.number, ncrNumber: d.ncrNumber, lots: d.lots, quantity: d.quantity, releasedUnder: sum(history.filter((r) => r.deviationIds.includes(d.id))) })),
      orderedQuantity: await this.releases.orderedQuantity(wp.purchaseOrderId, tx),
      releasedQuantity: sum(history),
      notDeliveredQuantity: await this.releases.notDelivered(wp.id, tx),
      scope: { quantity: scope.quantity, lots: scope.lots, serials: scope.serials },
      releaser: { userId: releaser.userId, isQuality: releaser.isInternal && releaser.roles.includes('jobwork_quality') },
    };
    if (!plan) facts.planStages = ['(no approved quality plan)'];
    return { facts, deviationNumbers: new Map(deviations.map((d) => [d.id, d.number])), workPackageNumber: wp.number, purchaseOrderNumber: wp.purchaseOrderNumber };
  }

  /** The checklist as it stands for a proposed scope; nothing is written. */
  async preview(actor: Actor, scope: ReleaseScope): Promise<ReleaseChecklist> {
    requireInternal(actor, QUALITY_READERS);
    const { facts, deviationNumbers } = await this.gather(scope, actor);
    const { items, deviationsReliedOn } = computeChecklist(facts);
    return { workPackageId: scope.workPackageId, items, allGreen: items.every((i) => i.pass), deviationsReliedOn: deviationsReliedOn.map((id) => deviationNumbers.get(id) ?? id) };
  }

  async authorize(actor: Actor, input: AuthorizeReleaseRequest, opts: Opts = {}): Promise<QualityRelease> {
    requireInternal(actor, QUALITY);
    requireTransactionalStrength(actor);
    const id = await this.executor.execute(
      {
        operation: 'quality.authorize-release',
        handler: async (tx, _ctx, cmd: AuthorizeReleaseRequest) => {
          await this.releases.lockWorkPackage(cmd.workPackageId, tx);
          const { facts, deviationNumbers, workPackageNumber, purchaseOrderNumber } = await this.gather(cmd, actor, tx);
          const { items, deviationsReliedOn } = computeChecklist(facts);
          const red = items.filter((i) => !i.pass);
          if (red.length > 0) throw new QualityRefused('RELEASE_BLOCKED', `${red.length} checklist item${red.length === 1 ? '' : 's'} not green`, red.flatMap((i) => i.reasons).join(' '));
          const number = await this.ncrs.allocateNumber('QR', 'quality_release', new Date(), tx);
          const snapshot = {
            release: number,
            workPackage: { id: cmd.workPackageId, number: workPackageNumber, purchaseOrder: purchaseOrderNumber },
            scope: { quantity: cmd.quantity, lots: cmd.lots, serials: cmd.serials },
            items,
            deviationsReliedOn: deviationsReliedOn.map((d) => deviationNumbers.get(d) ?? d),
            releasedBy: actor.userId,
            computedAt: new Date().toISOString(),
          };
          const sha = snapshotHash(snapshot);
          const releaseId = await this.releases.insert({ number, workPackageId: cmd.workPackageId, quantity: cmd.quantity, lots: cmd.lots, serials: cmd.serials, deviationIds: deviationsReliedOn, checklist: snapshot, snapshotSha256: sha, by: actor.userId }, tx);
          const wp = (await this.quality.workPackage(cmd.workPackageId, tx))!;
          return {
            result: releaseId,
            audit: [{ action: 'quality.release_authorized', subjectType: 'quality_release', subjectId: releaseId, subjectVersion: 1, data: { number, workPackageId: cmd.workPackageId, quantity: cmd.quantity, lots: cmd.lots, snapshotSha256: sha, deviations: snapshot.deviationsReliedOn } }],
            outbox: [
              {
                eventType: 'quality.release_authorized.v1',
                aggregateType: 'quality_release',
                aggregateId: releaseId,
                aggregateVersion: 1,
                data: { releaseId, number, workPackageId: cmd.workPackageId, purchaseOrderId: wp.purchaseOrderId, salesOrderId: wp.salesOrderId, quantity: cmd.quantity, lots: cmd.lots, serials: cmd.serials, snapshotSha256: sha },
              },
            ],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    const row = (await this.releases.releases(input.workPackageId)).find((r) => r.id === id)!;
    return this.view(row);
  }

  async list(actor: Actor, workPackageId: string): Promise<QualityRelease[]> {
    requireInternal(actor, QUALITY_READERS);
    return (await this.releases.releases(workPackageId)).map((r) => this.view(r));
  }

  /** Release facts for the dispatch gate (IN-16/17): what is released, what is held, what came after. */
  async facts(actor: Actor, workPackageId: string): Promise<ReleaseFactsView> {
    requireInternal(actor, QUALITY_READERS);
    return this.factsFor(workPackageId);
  }

  /** The same facts for another module's guard (IN-16 leg-1 dispatch), read in its transaction. */
  async factsFor(workPackageId: string, tx?: PoolClient): Promise<ReleaseFactsView> {
    const wp = await this.quality.workPackage(workPackageId, tx);
    if (!wp) throw new DomainError('WORK_PACKAGE_NOT_FOUND', 404, 'Work package not found');
    const history = await this.releases.releases(wp.id, tx);
    const ncrs = await this.releases.ncrs(wp.id, tx);
    const deviations = await this.releases.activeDeviations(wp.id, tx);
    const last = history.at(-1)?.releasedAt ?? null;
    return {
      workPackageId: wp.id,
      orderedQuantity: await this.releases.orderedQuantity(wp.purchaseOrderId, tx),
      releasedQuantity: history.reduce((t, r) => t.add(Rational.parse(r.quantity)), Rational.of(0)).toDisplay(4),
      releases: history.map((r) => ({ number: r.number, quantity: r.quantity, lots: r.lots, serials: r.serials, snapshotSha256: r.snapshotSha256, releasedAt: r.releasedAt.toISOString() })),
      openNcrs: ncrs
        .filter((n) => n.status !== 'closed' && !(n.status === 'accepted_under_deviation' && deviations.some((d) => d.ncrNumber === n.number)))
        .map((n) => ({ number: n.number, status: n.status as ReleaseFactsView['openNcrs'][number]['status'], lots: n.lots })),
      ncrsSinceLastRelease: last ? ncrs.filter((n) => n.openedAt > last).map((n) => ({ number: n.number, status: n.status as ReleaseFactsView['openNcrs'][number]['status'] })) : [],
      activeDeviations: deviations.map((d) => ({ number: d.number, lots: d.lots, quantity: d.quantity, expiresAt: d.expiresAt.toISOString() })),
    };
  }

  private view(r: ReleaseRow): QualityRelease {
    return { releaseId: r.id, number: r.number, workPackageId: r.workPackageId, quantity: r.quantity, lots: r.lots, serials: r.serials, snapshot: r.checklist, snapshotSha256: r.snapshotSha256, releasedAt: r.releasedAt.toISOString() };
  }
}
