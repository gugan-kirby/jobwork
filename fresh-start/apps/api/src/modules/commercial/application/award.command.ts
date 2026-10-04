import { Injectable } from '@nestjs/common';
import type { Award, ProposeAwardRequest } from '@jobwork/contracts';
import { type Actor, requireRole, requireTransactionalStrength } from '../../iam';
import { NotAuthorized } from '../../iam/domain/errors';
import { RfqRepository } from '../../sourcing';
import { RfqNotFound } from '../../sourcing/domain/rfq';
import { evaluateAwardPolicy, PolicyRulesInvalid } from '../domain/approval-policy';
import { lineAmount } from '../domain/money';
import { CommercialRepository } from '../infrastructure/commercial.repository';
import { CommercialView } from './commercial-view';
import { contextFromActor } from '../../../platform/commands/command';
import { CommandExecutor } from '../../../platform/commands/execute';
import { DomainError } from '../../../platform/http/domain-error';

export class AwardRejected extends DomainError {
  constructor(code: string, title: string, detail: string, path?: string) {
    super(code, 422, title, detail, path ? [{ path, message: detail }] : undefined);
  }
}

export class AwardNotFound extends DomainError {
  constructor() {
    super('AWARD_NOT_FOUND', 404, 'Award not found');
  }
}

/**
 * propose-award (`FR-403`, `BR-COM-07`, F-07.3). An award names exact bid versions and
 * the lines read from them; it cannot cite "the current bid". Quantities per RFQ item
 * must conserve exactly (doc 19 §4 split), every version cited must still be live, and
 * a single-source round must say what the fallback is. The proposer never approves —
 * the approval request that leaves here is decided by somebody else.
 */
@Injectable()
export class ProposeAwardCommand {
  constructor(
    private readonly repo: CommercialRepository,
    private readonly rfqs: RfqRepository,
    private readonly view: CommercialView,
    private readonly executor: CommandExecutor,
  ) {}

  async execute(
    actor: Actor,
    input: ProposeAwardRequest,
    opts: { idempotencyKey?: string | undefined } = {},
  ): Promise<Award> {
    if (!actor.isInternal) throw new NotAuthorized('JobWork only');
    requireRole(actor, 'jobwork_sourcing');
    requireTransactionalStrength(actor);

    const rfq = await this.rfqs.findRfq(input.rfqId);
    if (!rfq) throw new RfqNotFound();
    if (rfq.status !== 'evaluation') {
      throw new AwardRejected('AWARD_RFQ_NOT_IN_EVALUATION', 'This round is not open for an award', `The round is ${rfq.status}.`);
    }
    if (input.evaluationId) {
      const evaluation = await this.repo.findEvaluation(input.evaluationId);
      if (!evaluation || evaluation.rfqId !== rfq.id) {
        throw new AwardRejected('AWARD_EVALUATION_MISMATCH', 'That evaluation is not of this round', 'Evaluate the round and cite that evaluation.', 'evaluationId');
      }
    }

    const items = await this.rfqs.listItems(rfq.id);
    const live = await this.rfqs.listLiveBidsForRfq(rfq.id);
    const liveVersions = new Map(
      live
        .filter((row) => row.version !== null)
        .map((row) => [row.version!.id, { version: row.version!, invitation: row.invitation }]),
    );
    const respondedSuppliers = new Set(live.filter((row) => row.version !== null).map((row) => row.invitation.supplierOrganizationId));
    const singleSource = respondedSuppliers.size === 1;
    if (singleSource && input.fallbackNote.trim().length === 0) {
      throw new AwardRejected(
        'AWARD_FALLBACK_REQUIRED',
        'A single-source award needs a fallback',
        'Only one supplier bid. Say what happens if they cannot deliver (doc 19 §4).',
        'fallbackNote',
      );
    }

    // Every RFQ item is covered exactly once; every cited version is live and on this
    // round; every price is read from a line the version actually quoted.
    const seenItems = new Set<string>();
    const lines: Array<{
      rfqItemId: string;
      bidVersionId: string;
      supplierOrganizationId: string;
      bidQuantity: number;
      quantity: number;
      unit: string;
      unitPriceMinor: number;
      setupAmountMinor: number;
      lineTotalMinor: number;
    }> = [];
    for (const item of input.items) {
      const rfqItem = items.find((i) => i.id === item.rfqItemId);
      if (!rfqItem) {
        throw new AwardRejected('AWARD_ITEM_UNKNOWN', 'An item is not on this round', `No RFQ item ${item.rfqItemId}.`, 'items');
      }
      if (seenItems.has(item.rfqItemId)) {
        throw new AwardRejected('AWARD_ITEM_DUPLICATED', 'An item appears twice', `Line ${rfqItem.lineNo} is listed more than once.`, 'items');
      }
      seenItems.add(item.rfqItemId);

      const awarded = item.lines.reduce((sum, l) => sum + l.quantity, 0);
      if (Math.abs(awarded - item.targetQuantity) > 1e-9) {
        throw new AwardRejected(
          'AWARD_QUANTITY_MISMATCH',
          'Split quantities do not add up',
          `Line ${rfqItem.lineNo}: awarded ${awarded}, target ${item.targetQuantity}. A split must conserve the quantity exactly.`,
          'items',
        );
      }
      for (const line of item.lines) {
        const cited = liveVersions.get(line.bidVersionId);
        if (!cited) {
          throw new AwardRejected(
            'AWARD_BID_VERSION_NOT_LIVE',
            'A cited bid version is not live',
            'It is superseded, withdrawn, expired, or belongs to another round. Cite the supplier\'s current submitted version.',
            'items',
          );
        }
        const bidLine = cited.version.lines.find(
          (l) => l.rfqItemId === item.rfqItemId && Number(l.quantity) === Number(line.bidQuantity),
        );
        if (!bidLine) {
          throw new AwardRejected(
            'AWARD_LINE_MISMATCH',
            'The bid did not price that quantity',
            `${cited.invitation.displayName} did not quote line ${rfqItem.lineNo} at ${line.bidQuantity} ${rfqItem.quantityBreakpoints[0]?.unit ?? ''}.`,
            'items',
          );
        }
        const first = item.lines[0] === line;
        const lineTotalMinor = lineAmount(bidLine.unitPriceMinor, line.quantity) + (first ? bidLine.setupAmountMinor : 0);
        lines.push({
          rfqItemId: item.rfqItemId,
          bidVersionId: line.bidVersionId,
          supplierOrganizationId: cited.invitation.supplierOrganizationId,
          bidQuantity: line.bidQuantity,
          quantity: line.quantity,
          unit: bidLine.unit,
          unitPriceMinor: bidLine.unitPriceMinor,
          setupAmountMinor: first ? bidLine.setupAmountMinor : 0,
          lineTotalMinor,
        });
      }
    }
    const uncovered = items.filter((i) => !seenItems.has(i.id));
    if (uncovered.length > 0) {
      throw new AwardRejected(
        'AWARD_ITEMS_UNCOVERED',
        'Some lines are not awarded',
        `Lines ${uncovered.map((i) => i.lineNo).join(', ')} have no award line. Award every line or close the round with a reason.`,
        'items',
      );
    }
    const buyTotalMinor = lines.reduce((sum, l) => sum + l.lineTotalMinor, 0);

    const policy = await this.repo.activePolicy('award');
    if (!policy) throw new PolicyRulesInvalid('award');
    const outcome = evaluateAwardPolicy(policy.rules, { singleSource });

    const awardId = await this.executor.execute(
      {
        operation: 'commercial.propose-award',
        handler: async (tx) => {
          const id = await this.repo.createAward(
            {
              rfqId: rfq.id,
              evaluationId: input.evaluationId ?? null,
              singleSource,
              rationale: input.rationale,
              fallbackNote: input.fallbackNote,
              proposedBy: actor.userId,
              currency: rfq.currency,
              buyTotalMinor,
              lines,
            },
            tx,
          );
          const requestId = await this.repo.createApprovalRequest(
            {
              kind: 'award',
              subjectType: 'award',
              subjectId: id,
              subjectVersionNo: null,
              subjectHash: `award:${id}`,
              policyVersionId: policy.id,
              requestedBy: actor.userId,
              amountMinor: buyTotalMinor,
              currency: rfq.currency,
              marginBp: null,
              context: {
                awardId: id,
                rfqId: rfq.id,
                rfqReference: rfq.reference,
                singleSource,
                exception: outcome.exceptionReason,
                label: `Award on ${rfq.reference ?? 'round'} — ${new Set(lines.map((l) => l.supplierOrganizationId)).size} supplier(s)`,
              },
              requiredRoles: outcome.requiredRoles,
            },
            tx,
          );
          await this.repo.setAwardApproval(id, requestId, tx);
          return {
            result: id,
            audit: [
              {
                action: 'commercial.award_proposed',
                subjectType: 'award',
                subjectId: id,
                data: {
                  rfqId: rfq.id,
                  bidVersionIds: [...new Set(lines.map((l) => l.bidVersionId))],
                  singleSource,
                  buyTotalMinor,
                  approvalRequestId: requestId,
                },
              },
            ],
            outbox: [
              {
                eventType: 'commercial.award_proposed.v1',
                aggregateType: 'award',
                aggregateId: id,
                data: { awardId: id, rfqId: rfq.id, approvalRequestId: requestId, requiredRoles: outcome.requiredRoles },
              },
            ],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );

    return this.view.award((await this.repo.findAward(awardId))!);
  }
}
