import { Injectable } from '@nestjs/common';
import type { ApprovalRequest, DecideApprovalRequest } from '@jobwork/contracts';
import { type Actor, requireTransactionalStrength } from '../../iam';
import { NotAuthorized } from '../../iam/domain/errors';
import { RfqRepository } from '../../sourcing';
import {
  ApprovalNotFound,
  ApprovalNotPending,
  NotAnApprover,
  SelfApprovalRefused,
  mayDecide,
} from '../domain/approval-policy';
import { CommercialRepository } from '../infrastructure/commercial.repository';
import { ApprovalEffectRegistry } from './approval-effects';
import { CommercialView } from './commercial-view';
import { contextFromActor } from '../../../platform/commands/command';
import { CommandExecutor } from '../../../platform/commands/execute';
import { DomainError } from '../../../platform/http/domain-error';

class DecisionNotApplicable extends DomainError {
  constructor(kind: string, decision: string) {
    super('APPROVAL_DECISION_INVALID', 400, 'That decision does not apply here', `A ${kind} request cannot be ${decision}.`);
  }
}

/**
 * decide-approval (doc 03 §5, `BR-AUTH-04`, `FR-405`). One command for every approval
 * kind: it checks that the decider holds a role the request recorded, that the decider
 * is not the requester (the database refuses that too), records the immutable decision
 * with an authority snapshot, and applies the effect the kind implies — bid versions
 * selected, a cost sheet approved, a quote cleared to send.
 */
@Injectable()
export class DecideApprovalCommand {
  constructor(
    private readonly repo: CommercialRepository,
    private readonly rfqs: RfqRepository,
    private readonly view: CommercialView,
    private readonly executor: CommandExecutor,
    private readonly effects: ApprovalEffectRegistry,
  ) {}

  async execute(
    actor: Actor,
    requestId: string,
    input: DecideApprovalRequest,
    opts: { idempotencyKey?: string | undefined } = {},
  ): Promise<ApprovalRequest> {
    if (!actor.isInternal) throw new NotAuthorized('JobWork only');
    requireTransactionalStrength(actor);

    const ctx = contextFromActor(actor);
    await this.executor.execute(
      {
        operation: 'commercial.decide-approval',
        handler: async (tx, _ctx, cmd: DecideApprovalRequest) => {
          const request = await this.repo.findApprovalRequest(requestId, tx, true);
          if (!request) throw new ApprovalNotFound();
          if (request.status !== 'pending') throw new ApprovalNotPending(request.status);
          if (request.requestedBy === actor.userId) throw new SelfApprovalRefused();
          if (!mayDecide(actor.roles, request.requiredRoles)) throw new NotAnApprover(request.requiredRoles);
          if (cmd.decision !== 'approved' && cmd.reason.trim().length === 0) {
            throw new DomainError('APPROVAL_REASON_REQUIRED', 400, 'A negative decision needs a reason', undefined, [
              { path: 'reason', message: 'Say why' },
            ]);
          }
          if (request.kind === 'award' && cmd.decision === 'returned') {
            throw new DecisionNotApplicable('award', 'returned');
          }

          await this.repo.recordDecision(
            {
              requestId,
              decision: cmd.decision,
              decidedBy: actor.userId,
              authoritySnapshot: { roles: actor.roles, organizationId: actor.organizationId },
              reason: cmd.reason,
              correlationId: ctx.correlationId,
            },
            tx,
          );

          // Commercial's own kinds apply here; every other kind (finance's allocation, IN-13's change,
          // IN-15's deviation) belongs to the module that registered its effect.
          const effect =
            request.kind === 'award' || request.kind === 'cost_sheet' || request.kind === 'quote'
              ? await this.apply(request.kind, request.subjectId, cmd.decision, actor.userId, tx)
              : await this.effects.apply(request.kind, { requestId, subjectId: request.subjectId, context: request.context, decision: cmd.decision, decidedBy: actor.userId }, tx);

          return {
            result: undefined,
            audit: [
              {
                action: 'commercial.approval_decided',
                subjectType: request.subjectType,
                subjectId: request.subjectId,
                ...(request.subjectVersionNo !== null ? { subjectVersion: request.subjectVersionNo } : {}),
                ...(cmd.reason ? { reason: cmd.reason } : {}),
                data: {
                  approvalRequestId: requestId,
                  kind: request.kind,
                  decision: cmd.decision,
                  policyVersionId: request.policyVersionId,
                  requiredRoles: request.requiredRoles,
                  authority: actor.roles,
                  ...effect,
                },
              },
            ],
            outbox: [
              {
                eventType: 'commercial.approval_decided.v1',
                aggregateType: request.subjectType,
                aggregateId: request.subjectId,
                data: { approvalRequestId: requestId, kind: request.kind, decision: cmd.decision, ...effect },
              },
            ],
          };
        },
      },
      ctx,
      input,
      opts,
    );

    return this.view.approval((await this.repo.findApprovalRequest(requestId))!);
  }

  /** What a decision does to its subject. Each branch is the named transition of its aggregate. */
  private async apply(
    kind: 'award' | 'cost_sheet' | 'quote',
    subjectId: string,
    decision: 'approved' | 'rejected' | 'returned',
    decidedBy: string,
    tx: Parameters<CommercialRepository['setAwardStatus']>[2],
  ): Promise<Record<string, unknown>> {
    switch (kind) {
      case 'award': {
        const award = await this.repo.findAward(subjectId, tx, true);
        if (!award) throw new ApprovalNotFound();
        if (decision === 'approved') {
          await this.repo.setAwardStatus(award.id, 'approved', tx);
          const selected = new Set(award.lines.map((l) => l.bidVersionId));
          for (const versionId of selected) {
            await this.rfqs.setVersionStatus({ versionId, status: 'selected', reason: 'awarded', decidedBy }, tx);
          }
          // Every other live version on the round is closed out explicitly (doc 19 §4):
          // an unselected supplier is told, not left waiting.
          const live = await this.rfqs.listLiveBidsForRfq(award.rfqId);
          const rejected: string[] = [];
          for (const row of live) {
            if (row.version && !selected.has(row.version.id)) {
              await this.rfqs.setVersionStatus({ versionId: row.version.id, status: 'rejected', reason: 'not awarded', decidedBy }, tx);
              rejected.push(row.version.id);
            }
          }
          const rfq = await this.rfqs.findRfq(award.rfqId, tx);
          if (!rfq) throw new ApprovalNotFound();
          await this.rfqs.setRfqStatus(
            {
              rfqId: award.rfqId,
              expectedVersion: rfq.aggregateVersion,
              status: 'awarded',
              closed: { by: decidedBy, reason: `awarded:${award.id}` },
            },
            tx,
          );
          return { awardId: award.id, selectedBidVersionIds: [...selected], rejectedBidVersionIds: rejected };
        }
        await this.repo.setAwardStatus(award.id, 'rejected', tx);
        return { awardId: award.id };
      }
      case 'cost_sheet': {
        const found = await this.repo.findCostSheetVersion(subjectId, tx);
        if (!found) throw new ApprovalNotFound();
        const sheet = (await this.repo.findCostSheet(found.costSheetId, tx, true))!;
        if (decision === 'approved') {
          await this.repo.setCostSheetVersionStatus({ versionId: subjectId, status: 'approved' }, tx);
          for (const other of sheet.versions) {
            if (other.id !== subjectId && other.status === 'approved') {
              await this.repo.setCostSheetVersionStatus({ versionId: other.id, status: 'superseded' }, tx);
            }
          }
          await this.repo.setCostSheetStatus(sheet.id, 'approved', tx);
          return { costSheetId: sheet.id, costSheetVersionId: subjectId };
        }
        await this.repo.setCostSheetVersionStatus({ versionId: subjectId, status: 'returned' }, tx);
        await this.repo.setCostSheetStatus(sheet.id, 'returned', tx);
        return { costSheetId: sheet.id, costSheetVersionId: subjectId };
      }
      case 'quote': {
        const quoteId = await this.quoteIdOfVersion(subjectId, tx);
        const quote = await this.repo.findQuote(quoteId, tx, true);
        if (!quote) throw new ApprovalNotFound();
        if (decision === 'approved') {
          await this.repo.setQuoteVersionStatus({ versionId: subjectId, status: 'approved' }, tx);
          await this.repo.setQuoteStatus({ quoteId, status: 'approved' }, tx);
          return { quoteId, quoteVersionId: subjectId };
        }
        await this.repo.setQuoteVersionStatus({ versionId: subjectId, status: 'draft' }, tx);
        await this.repo.setQuoteStatus({ quoteId, status: 'draft' }, tx);
        return { quoteId, quoteVersionId: subjectId };
      }
    }
  }

  private async quoteIdOfVersion(versionId: string, tx: Parameters<CommercialRepository['setAwardStatus']>[2]): Promise<string> {
    const res = await tx.query<{ customer_quote_id: string }>(
      `SELECT customer_quote_id FROM commercial.quote_version WHERE id = $1`,
      [versionId],
    );
    if (!res.rows[0]) throw new ApprovalNotFound();
    return res.rows[0].customer_quote_id;
  }
}
