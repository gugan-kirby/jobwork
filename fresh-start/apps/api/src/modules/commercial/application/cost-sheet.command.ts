import { Injectable } from '@nestjs/common';
import type { CostSheet, SaveCostSheetRequest } from '@jobwork/contracts';
import { type Actor, requireRole, requireTransactionalStrength } from '../../iam';
import { NotAuthorized } from '../../iam/domain/errors';
import { RfqRepository } from '../../sourcing';
import { evaluateCostSheetPolicy, PolicyRulesInvalid } from '../domain/approval-policy';
import {
  CostSheetNotEditable,
  CostSheetNotFound,
  assertCostSheetTransition,
  computeCostSheet,
} from '../domain/cost-sheet';
import { CommercialRepository } from '../infrastructure/commercial.repository';
import { AwardNotFound } from './award.command';
import { CommercialView } from './commercial-view';
import { COMMERCIAL_READ_ROLES } from './evaluate.command';
import { contextFromActor } from '../../../platform/commands/command';
import { CommandExecutor } from '../../../platform/commands/execute';
import { DomainError } from '../../../platform/http/domain-error';

class AwardNotApproved extends DomainError {
  constructor(status: string) {
    super('COST_SHEET_AWARD_NOT_APPROVED', 409, 'A cost sheet needs an approved award', `The award is ${status}.`);
  }
}

/**
 * The cost sheet commands (`FR-404`, F-07.4). `save` builds the figures from the award
 * and the components and keeps them editable until approval is requested; `request`
 * freezes the version and routes it by the margin policy — a negative or below-floor
 * margin is an exception somebody in finance signs, never a number that slips through.
 */
@Injectable()
export class CostSheetCommand {
  constructor(
    private readonly repo: CommercialRepository,
    private readonly rfqs: RfqRepository,
    private readonly view: CommercialView,
    private readonly executor: CommandExecutor,
  ) {}

  private requireEditor(actor: Actor): void {
    if (!actor.isInternal) throw new NotAuthorized('JobWork only');
    requireRole(actor, 'jobwork_sales', 'jobwork_sourcing', 'jobwork_finance');
  }

  async minMarginBp(): Promise<number> {
    const policy = await this.repo.activePolicy('cost_sheet');
    const rules = (policy?.rules ?? {}) as { minMarginBp?: number };
    return typeof rules.minMarginBp === 'number' ? rules.minMarginBp : 0;
  }

  async get(actor: Actor, costSheetId: string): Promise<CostSheet> {
    if (!actor.isInternal) throw new NotAuthorized('JobWork only');
    requireRole(actor, ...COMMERCIAL_READ_ROLES);
    const sheet = await this.repo.findCostSheet(costSheetId);
    if (!sheet) throw new CostSheetNotFound();
    return this.view.costSheet(sheet, await this.minMarginBp());
  }

  async getByAward(actor: Actor, awardId: string): Promise<CostSheet | null> {
    if (!actor.isInternal) throw new NotAuthorized('JobWork only');
    requireRole(actor, ...COMMERCIAL_READ_ROLES);
    const sheet = await this.repo.findCostSheetByAward(awardId);
    return sheet ? this.view.costSheet(sheet, await this.minMarginBp()) : null;
  }

  async save(
    actor: Actor,
    awardId: string,
    input: SaveCostSheetRequest,
    opts: { idempotencyKey?: string | undefined } = {},
  ): Promise<CostSheet> {
    this.requireEditor(actor);
    requireTransactionalStrength(actor);

    const award = await this.repo.findAward(awardId);
    if (!award) throw new AwardNotFound();
    if (award.status !== 'approved') throw new AwardNotApproved(award.status);
    const items = await this.rfqs.listItems(award.rfqId);

    const figures = computeCostSheet({
      currency: award.currency,
      awardLines: award.lines.map((line) => ({
        rfqItemId: line.rfqItemId,
        lineNo: line.lineNo,
        description: items.find((i) => i.id === line.rfqItemId)?.partName ?? `Line ${line.lineNo}`,
        quantity: line.quantity,
        unit: line.unit,
        lineTotalMinor: line.lineTotalMinor,
      })),
      components: input.components,
      pricing: input.sellLines
        ? { unitSellByLine: new Map(input.sellLines.map((l) => [l.lineNo, l.unitSellMinor])) }
        : { targetMarginBp: input.targetMarginBp! },
      note: input.note,
    });

    const costSheetId = await this.executor.execute(
      {
        operation: 'commercial.save-cost-sheet',
        handler: async (tx) => {
          let sheet = await this.repo.findCostSheetByAward(awardId, tx);
          if (!sheet) {
            const id = await this.repo.createCostSheet(
              {
                rfqId: award.rfqId,
                awardId,
                enquiryId: award.enquiryId,
                customerOrganizationId: (await this.rfqs.findRfq(award.rfqId, tx))!.customerOrganizationId,
                createdBy: actor.userId,
              },
              tx,
            );
            sheet = (await this.repo.findCostSheet(id, tx, true))!;
          } else {
            sheet = (await this.repo.findCostSheet(sheet.id, tx, true))!;
          }
          const current = sheet.versions.find((v) => v.versionNo === sheet!.currentVersionNo) ?? null;
          if (current && current.status === 'pending_approval') throw new CostSheetNotEditable(current.status);

          // Draft or returned: edit in place. Approved or superseded: a new version.
          const editable = current && (current.status === 'draft' || current.status === 'returned');
          const versionId = await this.repo.upsertCostSheetVersion(
            {
              costSheetId: sheet.id,
              versionNo: editable ? current.versionNo : sheet.currentVersionNo + 1,
              existingVersionId: editable ? current.id : null,
              currency: award.currency,
              ...figures,
              components: input.components,
              note: input.note,
              createdBy: actor.userId,
              supersedesVersionId: editable ? null : (current?.id ?? null),
            },
            tx,
          );
          if (editable) await this.repo.setCostSheetStatus(sheet.id, 'draft', tx);
          return {
            result: sheet.id,
            audit: [
              {
                action: 'commercial.cost_sheet_saved',
                subjectType: 'cost_sheet',
                subjectId: sheet.id,
                data: { versionId, awardId, marginBp: figures.marginBp, sellTotalMinor: figures.sellTotalMinor, contentHash: figures.contentHash },
              },
            ],
          };
        },
      },
      contextFromActor(actor),
      { awardId, ...input },
      opts,
    );

    return this.get(actor, costSheetId);
  }

  async requestApproval(
    actor: Actor,
    costSheetId: string,
    opts: { idempotencyKey?: string | undefined } = {},
  ): Promise<CostSheet> {
    this.requireEditor(actor);
    requireTransactionalStrength(actor);

    const policy = await this.repo.activePolicy('cost_sheet');
    if (!policy) throw new PolicyRulesInvalid('cost_sheet');

    await this.executor.execute(
      {
        operation: 'commercial.request-cost-sheet-approval',
        handler: async (tx) => {
          const sheet = await this.repo.findCostSheet(costSheetId, tx, true);
          if (!sheet) throw new CostSheetNotFound();
          const current = sheet.versions.find((v) => v.versionNo === sheet.currentVersionNo);
          if (!current) throw new CostSheetNotFound();
          assertCostSheetTransition(current.status, 'pending_approval');

          const outcome = evaluateCostSheetPolicy(policy.rules, { marginBp: current.marginBp });
          const requestId = await this.repo.createApprovalRequest(
            {
              kind: 'cost_sheet',
              subjectType: 'cost_sheet_version',
              subjectId: current.id,
              subjectVersionNo: current.versionNo,
              subjectHash: current.contentHash,
              policyVersionId: policy.id,
              requestedBy: actor.userId,
              amountMinor: current.sellTotalMinor,
              currency: current.currency,
              marginBp: current.marginBp,
              context: {
                costSheetId: sheet.id,
                awardId: sheet.awardId,
                exception: outcome.exceptionReason,
                label: `Cost sheet v${current.versionNo} — margin ${(current.marginBp / 100).toFixed(1)} %${outcome.exceptionReason ? ` (${outcome.exceptionReason.replace(/_/g, ' ')})` : ''}`,
              },
              requiredRoles: outcome.requiredRoles,
            },
            tx,
          );
          await this.repo.setCostSheetVersionStatus({ versionId: current.id, status: 'pending_approval', approvalRequestId: requestId }, tx);
          await this.repo.setCostSheetStatus(sheet.id, 'pending_approval', tx);
          return {
            result: undefined,
            audit: [
              {
                action: 'commercial.cost_sheet_approval_requested',
                subjectType: 'cost_sheet_version',
                subjectId: current.id,
                subjectVersion: current.versionNo,
                data: { approvalRequestId: requestId, marginBp: current.marginBp, exception: outcome.exceptionReason, requiredRoles: outcome.requiredRoles },
              },
            ],
            outbox: [
              {
                eventType: 'commercial.cost_sheet_approval_requested.v1',
                aggregateType: 'cost_sheet',
                aggregateId: sheet.id,
                data: { approvalRequestId: requestId, requiredRoles: outcome.requiredRoles },
              },
            ],
          };
        },
      },
      contextFromActor(actor),
      { costSheetId },
      opts,
    );

    return this.get(actor, costSheetId);
  }
}
