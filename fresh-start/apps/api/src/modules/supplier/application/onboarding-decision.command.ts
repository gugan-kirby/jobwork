import { Injectable } from '@nestjs/common';
import type { SupplierDecisionRequest, SupplierSelfView } from '@jobwork/contracts';
import { type Actor, requireOrganization, requireTransactionalStrength } from '../../iam';
import { NotAuthorized } from '../../iam/domain/errors';
import { VersionConflict } from '../../../platform/http/domain-error';
import { blockingRows } from '../domain/onboarding-checklist';
import {
  OnboardingIncomplete,
  SupplierNotFound,
  SupplierStateRejected,
} from '../domain/errors';
import { assertMayDecideAdmission, assertMayMaintainProfile } from '../domain/supplier-policy';
import { SupplierRepository, type SupplierNetworkStatusRow } from '../infrastructure/supplier.repository';
import { SupplierView } from './supplier-view';
import { contextFromActor } from '../../../platform/commands/command';
import { CommandExecutor } from '../../../platform/commands/execute';

type Decision = 'approve' | 'return' | 'reject' | 'suspend' | 'reinstate';

const DECISION_RULES: Record<
  Decision,
  { from: readonly SupplierNetworkStatusRow[]; to: SupplierNetworkStatusRow; verb: string }
> = {
  approve: { from: ['submitted'], to: 'active', verb: 'approved' },
  return: { from: ['submitted'], to: 'onboarding', verb: 'returned' },
  reject: { from: ['submitted', 'onboarding'], to: 'rejected', verb: 'rejected' },
  suspend: { from: ['active'], to: 'paused', verb: 'suspended' },
  reinstate: { from: ['paused'], to: 'active', verb: 'reinstated' },
};

/**
 * Admission decisions (F-SO.5). Two rules carry this file:
 *
 *  1. **The checklist decides, not the mood of the day.** Submission and approval read
 *     the same computed rows, and approval re-reads them at decision time — a GST
 *     certificate that expired between submission and Monday morning stops the approval,
 *     because "active" must never mean less than the evidence says.
 *  2. **Nobody signs off their own file.** The supplier submits; JobWork decides; the
 *     database refuses a row where those are the same person, so an application bug
 *     cannot make a supplier admit itself.
 */
@Injectable()
export class OnboardingDecisionCommand {
  constructor(
    private readonly repo: SupplierRepository,
    private readonly view: SupplierView,
    private readonly executor: CommandExecutor,
  ) {}

  /** Supplier side: "we are ready to be looked at". */
  async submitForApproval(
    actor: Actor,
    input: { expectedVersion: number },
    opts: { idempotencyKey?: string | undefined } = {},
  ): Promise<SupplierSelfView> {
    requireTransactionalStrength(actor);
    const organizationId = requireOrganization(actor);
    if (actor.organizationType !== 'supplier') {
      throw new NotAuthorized('Only a supplier submits its own onboarding');
    }
    assertMayMaintainProfile(actor);

    const profile = await this.repo.findProfileByOrganization(organizationId);
    if (!profile) throw new SupplierNotFound();

    return this.executor.execute(
      {
        operation: 'supplier.submit-onboarding',
        handler: async (tx, _ctx, cmd: { expectedVersion: number }) => {
          const current = await this.repo.findProfile(profile.id, tx);
          if (!current) throw new SupplierNotFound();
          if (current.status !== 'onboarding' && current.status !== 'rejected') {
            throw new SupplierStateRejected(current.status, 'submitted');
          }

          const view = await this.view.selfView(current);
          const blocking = blockingRows(view.checklist);
          if (blocking.length > 0) {
            throw new OnboardingIncomplete(blocking.map((row) => `${row.label} — ${row.detail}`));
          }

          const updated = await this.repo.setProfileStatus(
            {
              profileId: current.id,
              expectedVersion: cmd.expectedVersion,
              status: 'submitted',
              submittedBy: actor.userId,
              submittedAt: new Date(),
            },
            tx,
          );
          if (!updated) throw new VersionConflict();

          return {
            result: await this.view.selfView(updated),
            audit: [
              {
                action: 'supplier.onboarding_submitted',
                subjectType: 'supplier_profile',
                subjectId: updated.id,
                subjectVersion: updated.aggregateVersion,
                data: { organizationId },
              },
            ],
            outbox: [
              {
                eventType: 'supplier.onboarding_submitted.v1',
                aggregateType: 'supplier_profile',
                aggregateId: updated.id,
                aggregateVersion: updated.aggregateVersion,
                data: { organizationId },
              },
            ],
          };
        },
      },
      contextFromActor({ userId: actor.userId, organizationId }),
      input,
      opts,
    );
  }

  /** JobWork side: approve, return, reject, suspend, reinstate. */
  async decide(
    actor: Actor,
    supplierProfileId: string,
    decision: Decision,
    input: SupplierDecisionRequest,
    opts: { idempotencyKey?: string | undefined } = {},
  ): Promise<SupplierSelfView> {
    requireTransactionalStrength(actor);
    assertMayDecideAdmission(actor);
    const rule = DECISION_RULES[decision];

    return this.executor.execute(
      {
        operation: `supplier.${decision}-supplier`,
        handler: async (tx, _ctx, cmd: SupplierDecisionRequest) => {
          const current = await this.repo.lockProfile(supplierProfileId, tx);
          if (!current) throw new SupplierNotFound();
          if (!rule.from.includes(current.status)) {
            throw new SupplierStateRejected(current.status, rule.verb);
          }
          if (current.submittedBy === actor.userId) {
            throw new NotAuthorized('The person who submitted a file cannot decide it');
          }

          // Approval reads the file again at the moment of the decision: what was true
          // when the supplier submitted is not necessarily true now.
          if (decision === 'approve') {
            const view = await this.view.selfView(current);
            const blocking = blockingRows(view.checklist);
            if (blocking.length > 0) {
              throw new OnboardingIncomplete(blocking.map((row) => `${row.label} — ${row.detail}`));
            }
          }

          const updated = await this.repo.setProfileStatus(
            {
              profileId: current.id,
              expectedVersion: cmd.expectedVersion,
              status: rule.to,
              decidedBy: actor.userId,
              decisionReason: cmd.reason ?? null,
            },
            tx,
          );
          if (!updated) throw new VersionConflict();

          return {
            result: await this.view.selfView(updated),
            audit: [
              {
                action: `supplier.${rule.verb}`,
                subjectType: 'supplier_profile',
                subjectId: updated.id,
                subjectVersion: updated.aggregateVersion,
                ...(cmd.reason ? { reason: cmd.reason } : {}),
                data: {
                  organizationId: updated.organizationId,
                  from: current.status,
                  to: rule.to,
                },
              },
            ],
            outbox: [
              {
                eventType: `supplier.${rule.verb}.v1`,
                aggregateType: 'supplier_profile',
                aggregateId: updated.id,
                aggregateVersion: updated.aggregateVersion,
                data: { organizationId: updated.organizationId, status: rule.to },
              },
            ],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
  }
}
