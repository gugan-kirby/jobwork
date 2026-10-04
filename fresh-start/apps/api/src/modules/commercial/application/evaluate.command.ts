import { Injectable } from '@nestjs/common';
import type { CreateEvaluationRequest, Evaluation } from '@jobwork/contracts';
import { evaluationScenarioSchema } from '@jobwork/contracts';
import { type Actor, requireRole, requireTransactionalStrength } from '../../iam';
import { NotAuthorized } from '../../iam/domain/errors';
import { RfqRepository } from '../../sourcing';
import { RfqNotFound } from '../../sourcing/domain/rfq';
import { NORMALIZATION_CONFIG_VERSION, evaluateBids, scenarioHash, type BidForNormalization } from '../domain/normalization';
import { CommercialRepository } from '../infrastructure/commercial.repository';
import { CommercialView } from './commercial-view';
import { contextFromActor } from '../../../platform/commands/command';
import { CommandExecutor } from '../../../platform/commands/execute';
import { DomainError } from '../../../platform/http/domain-error';

export class NothingToEvaluate extends DomainError {
  constructor(status: string) {
    super(
      'EVALUATION_NOT_POSSIBLE',
      409,
      'This round cannot be evaluated yet',
      status === 'evaluation'
        ? 'No live bid versions are on the round.'
        : `The round is ${status}; close it for evaluation first.`,
    );
  }
}

/** The roles that read the buy side. Platform admin is deliberately absent (BR-AUTH-03). */
export const COMMERCIAL_READ_ROLES = ['jobwork_sourcing', 'jobwork_sales', 'jobwork_finance'] as const;

export function requireCommercialReader(actor: Actor): void {
  if (!actor.isInternal) throw new NotAuthorized('JobWork only');
  requireRole(actor, ...COMMERCIAL_READ_ROLES);
}

/**
 * create-evaluation (`FR-402`, F-07.2). Every live bid version on a closed round is
 * normalized under one scenario and the result is persisted with its inputs, so the
 * comparison the award cites can be reproduced — not just remembered.
 */
@Injectable()
export class CreateEvaluationCommand {
  constructor(
    private readonly repo: CommercialRepository,
    private readonly rfqs: RfqRepository,
    private readonly view: CommercialView,
    private readonly executor: CommandExecutor,
  ) {}

  async execute(
    actor: Actor,
    rfqId: string,
    input: CreateEvaluationRequest,
    opts: { idempotencyKey?: string | undefined } = {},
  ): Promise<Evaluation> {
    if (!actor.isInternal) throw new NotAuthorized('JobWork only');
    requireRole(actor, 'jobwork_sourcing', 'jobwork_sales');
    requireTransactionalStrength(actor);

    const rfq = await this.rfqs.findRfq(rfqId);
    if (!rfq) throw new RfqNotFound();
    if (rfq.status !== 'evaluation' && rfq.status !== 'awarded') throw new NothingToEvaluate(rfq.status);

    const scenario = evaluationScenarioSchema.parse(input.scenario ?? {});
    const live = await this.rfqs.listLiveBidsForRfq(rfqId);
    const bids: BidForNormalization[] = live
      .filter((row) => row.version !== null)
      .map((row) => ({
        bidVersionId: row.version!.id,
        supplierOrganizationId: row.invitation.supplierOrganizationId,
        supplierDisplayName: row.invitation.displayName,
        versionNo: row.version!.versionNo,
        taxTreatment: row.version!.taxTreatment,
        nreAmountMinor: row.version!.nreAmountMinor,
        freightAmountMinor: row.version!.freightAmountMinor,
        totalAmountMinor: row.version!.totalAmountMinor,
        leadTimeDays: row.version!.leadTimeDays,
        validityUntil: row.version!.validityUntil,
        feasibility: row.version!.feasibility,
        late: row.version!.late,
        receivedAt: row.version!.receivedAt,
        lines: row.version!.lines,
      }));
    if (bids.length === 0) throw new NothingToEvaluate('evaluation');

    const rows = evaluateBids(bids, scenario, new Date());
    const hash = scenarioHash(scenario);

    const evaluationId = await this.executor.execute(
      {
        operation: 'commercial.create-evaluation',
        handler: async (tx) => {
          const id = await this.repo.createEvaluation(
            {
              rfqId,
              configVersion: NORMALIZATION_CONFIG_VERSION,
              scenario,
              scenarioHash: hash,
              createdBy: actor.userId,
              rows,
            },
            tx,
          );
          return {
            result: id,
            audit: [
              {
                action: 'commercial.evaluation_created',
                subjectType: 'evaluation',
                subjectId: id,
                data: { rfqId, scenarioHash: hash, bidCount: rows.length, configVersion: NORMALIZATION_CONFIG_VERSION },
              },
            ],
          };
        },
      },
      contextFromActor(actor),
      { rfqId, scenario },
      opts,
    );

    const record = (await this.repo.findEvaluation(evaluationId))!;
    return this.view.evaluation(record, rfq.currency);
  }
}
