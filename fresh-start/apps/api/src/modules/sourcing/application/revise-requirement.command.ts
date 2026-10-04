import { Injectable } from '@nestjs/common';
import type { Enquiry, RequirementRevision, ReviseRequirementRequest } from '@jobwork/contracts';
import { type Actor, requireRole, requireTransactionalStrength } from '../../iam';
import { EnquiryNotFound, assertVersion } from '../domain/enquiry';
import { LIVE_RFQ_STATUSES } from '../domain/rfq';
import { requirementSnapshot } from './enquiry-snapshot';
import { EnquiryRepository } from '../infrastructure/enquiry.repository';
import { RfqRepository } from '../infrastructure/rfq.repository';
import { contextFromActor, type AuditSpec, type OutboxSpec } from '../../../platform/commands/command';
import { CommandExecutor } from '../../../platform/commands/execute';
import { DomainError } from '../../../platform/http/domain-error';

export class RevisionRefused extends DomainError {
  constructor(code: string, status: number, title: string, detail: string) {
    super(code, status, title, detail);
  }
}

export interface RevisedRequirement {
  enquiry: Enquiry;
  revision: RequirementRevision;
  supersededRounds: Array<{ rfqId: string; reference: string | null; roundNo: number }>;
}

/**
 * revise-requirement (F-12.5; doc 19 §10 scenario 5; doc 19 §3 "new revision after
 * quote"): engineering changes what suppliers are pricing after they have started to bid —
 * a tighter tolerance, another material grade, a new quantity, a new governing drawing.
 *
 * The change is a new frozen revision with its reason; the enquiry's live items carry
 * the edit so the next round copies it. Every round still live on the old revision is
 * superseded in the same transaction, and its suppliers are told; their bids are not
 * touched — they stay exactly as submitted, as history, and cannot be awarded because a
 * superseded round takes no award.
 *
 * Refused once an award is approved (the change then belongs to engineering change
 * control, IN-13) or while one is waiting for approval (approving it would land on a
 * round that no longer stands).
 */
@Injectable()
export class ReviseRequirementCommand {
  constructor(
    private readonly repo: EnquiryRepository,
    private readonly rfqs: RfqRepository,
    private readonly executor: CommandExecutor,
  ) {}

  async execute(
    actor: Actor,
    enquiryId: string,
    input: ReviseRequirementRequest,
    opts: { idempotencyKey?: string | undefined } = {},
  ): Promise<RevisedRequirement> {
    if (!actor.isInternal) throw new RevisionRefused('NOT_AUTHORIZED', 403, 'Internal audience only', 'Only JobWork engineering revises a requirement.');
    requireRole(actor, 'jobwork_engineering');
    requireTransactionalStrength(actor);

    const ctx = contextFromActor({ userId: actor.userId, organizationId: actor.organizationId });
    return this.executor.execute(
      {
        operation: 'sourcing.revise-requirement',
        handler: async (tx, _ctx, cmd: ReviseRequirementRequest) => {
          const enquiry = await this.repo.findForUpdate(enquiryId, tx);
          if (!enquiry) throw new EnquiryNotFound();
          assertVersion(cmd.expectedVersion, enquiry.aggregateVersion);
          if (enquiry.status !== 'approved_for_sourcing') {
            throw new RevisionRefused('REVISION_NOT_IN_SOURCING', 409, 'This enquiry is not being sourced', `It is ${enquiry.status}; triage changes it through clarifications instead.`);
          }
          if (await this.rfqs.hasRoundInStatus(enquiryId, 'awarded', tx)) {
            throw new RevisionRefused('REVISION_AFTER_AWARD', 409, 'An award has been approved', 'A change now goes through engineering change control, which weighs its cost and schedule.');
          }
          if (await this.rfqs.hasPendingAward(enquiryId, tx)) {
            throw new RevisionRefused('REVISION_AWARD_PENDING', 409, 'An award is waiting for approval', 'Approve, reject or withdraw it before the requirement changes underneath it.');
          }

          let changed = await this.repo.reviseItems(enquiryId, cmd.items, tx);
          if (cmd.governingDocumentVersionId) {
            const governing = enquiry.documents.find((d) => d.role === 'governing')?.documentVersionId;
            if (governing !== cmd.governingDocumentVersionId) {
              const linked = await this.repo.setGoverningDocument(enquiryId, cmd.governingDocumentVersionId, tx);
              if (!linked) {
                throw new RevisionRefused('GOVERNING_DOCUMENT_NOT_LINKED', 409, 'That document is not attached to this enquiry', 'The governing document has to be one of the enquiry’s own attachments.');
              }
              changed += 1;
            }
          }
          if (changed === 0) {
            throw new RevisionRefused('REVISION_UNCHANGED', 422, 'Nothing changed', 'The revision reads exactly like the requirement already in force.');
          }

          const current = (await this.repo.find(enquiryId, tx))!;
          const revision = await this.repo.freezeRequirement(
            {
              enquiryId,
              kind: 'reviewed',
              frozenBy: actor.userId,
              snapshot: { ...requirementSnapshot(current), approvedForSourcing: true, revisionReason: cmd.reason },
              revisionReason: cmd.reason,
            },
            tx,
          );
          const version = await this.repo.transition(enquiryId, 'approved_for_sourcing', { currentRevisionNo: revision.revisionNo }, tx);

          const live = await this.rfqs.lockLiveRounds(enquiryId, LIVE_RFQ_STATUSES, tx);
          const audit: AuditSpec[] = [
            {
              action: 'sourcing.requirement_revised',
              subjectType: 'enquiry',
              subjectId: enquiryId,
              subjectVersion: version,
              reason: cmd.reason,
              data: { revisionNo: revision.revisionNo, contentHash: revision.contentHash, supersededRounds: live.length },
            },
          ];
          const outbox: OutboxSpec[] = [
            {
              eventType: 'sourcing.requirement_revised.v1',
              aggregateType: 'enquiry',
              aggregateId: enquiryId,
              aggregateVersion: version,
              data: { revisionNo: revision.revisionNo, supersededRounds: live.map((r) => r.id) },
            },
          ];
          for (const round of live) {
            const suppliers = await this.rfqs.invitedOrganizations(round.id, tx);
            await this.rfqs.supersede(round.id, revision.requirementId, actor.userId, cmd.reason, tx);
            audit.push({
              action: 'sourcing.rfq_superseded',
              subjectType: 'rfq',
              subjectId: round.id,
              subjectVersion: round.aggregateVersion + 1,
              reason: cmd.reason,
              data: { revisionNo: revision.revisionNo, previousStatus: round.status },
            });
            outbox.push({
              eventType: 'sourcing.rfq_superseded.v1',
              aggregateType: 'rfq',
              aggregateId: round.id,
              aggregateVersion: round.aggregateVersion + 1,
              data: { rfqId: round.id, reference: round.reference, roundNo: round.roundNo, supplierOrganizationIds: suppliers },
            });
          }

          return {
            result: {
              enquiry: (await this.repo.find(enquiryId, tx))!,
              revision,
              supersededRounds: live.map((r) => ({ rfqId: r.id, reference: r.reference, roundNo: r.roundNo })),
            },
            audit,
            outbox,
          };
        },
      },
      ctx,
      input,
      opts,
    );
  }
}
