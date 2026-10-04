import { Injectable } from '@nestjs/common';
import type { Enquiry, SubmitEnquiryRequest } from '@jobwork/contracts';
import { type Actor, requireOrganization, requireTransactionalStrength } from '../../iam';
import { assertMayAuthorEnquiry } from '../domain/enquiry-policy';
import {
  EnquiryIncomplete,
  EnquiryNotFound,
  assertTransition,
  assertVersion,
  validateForSubmission,
} from '../domain/enquiry';
import { requirementSnapshot } from './enquiry-snapshot';
import { EnquiryRepository } from '../infrastructure/enquiry.repository';
import { contextFromActor } from '../../../platform/commands/command';
import { CommandExecutor } from '../../../platform/commands/execute';

/**
 * submit-enquiry (`FR-302`, doc 06 §3). The moment a draft becomes evidence.
 *
 * Three things happen atomically and never separately: the mandatory fields are
 * checked, revision 1 is frozen with a content hash, and the enquiry gets the
 * reference the customer will quote at us on the phone. Everything downstream — RFQ,
 * bid, cost sheet, quote — cites that revision number, so it must be impossible for
 * the enquiry to be `submitted` without one existing.
 */
@Injectable()
export class SubmitEnquiryCommand {
  constructor(
    private readonly repo: EnquiryRepository,
    private readonly executor: CommandExecutor,
  ) {}

  async execute(
    actor: Actor,
    enquiryId: string,
    input: SubmitEnquiryRequest,
    opts: { idempotencyKey?: string | undefined } = {},
  ): Promise<Enquiry> {
    requireTransactionalStrength(actor);
    const organizationId = requireOrganization(actor);
    assertMayAuthorEnquiry(actor);

    const ctx = contextFromActor({ userId: actor.userId, organizationId });
    return this.executor.execute(
      {
        operation: 'sourcing.submit-enquiry',
        handler: async (tx, _ctx, cmd: SubmitEnquiryRequest) => {
          const enquiry = await this.repo.findForUpdate(enquiryId, tx);
          if (!enquiry || enquiry.customerOrganizationId !== organizationId) {
            throw new EnquiryNotFound();
          }
          assertVersion(cmd.expectedVersion, enquiry.aggregateVersion);
          assertTransition(enquiry.status, 'submitted');

          const issues = validateForSubmission({
            title: enquiry.title,
            jobType: enquiry.jobType,
            changeReference: enquiry.changeReference,
            changeDescription: enquiry.changeDescription,
            requiredByDate: enquiry.requiredByDate,
            assistedIntake: enquiry.assistedIntake,
            items: enquiry.items.map((item) => ({
              lineNo: item.lineNo,
              partName: item.partName,
              description: item.description,
              processCapabilityId: item.processCapabilityId ?? null,
              materialCapabilityId: item.materialCapabilityId ?? null,
              materialGrade: item.materialGrade ?? null,
              quantityBreakpoints: item.quantityBreakpoints,
            })),
            documents: enquiry.documents.map((doc) => ({ role: doc.role, lineNo: doc.lineNo })),
          });
          if (issues.length > 0) throw new EnquiryIncomplete(issues);

          const now = new Date();
          const reference = await this.repo.allocateReference(tx, now);
          const revision = await this.repo.freezeRequirement(
            {
              enquiryId,
              kind: 'intake',
              frozenBy: actor.userId,
              snapshot: requirementSnapshot(enquiry),
            },
            tx,
          );
          await this.repo.transition(
            enquiryId,
            'submitted',
            {
              reference,
              submittedBy: actor.userId,
              submittedAt: now,
              submittedRevisionNo: revision.revisionNo,
              currentRevisionNo: revision.revisionNo,
            },
            tx,
          );

          const submitted = (await this.repo.find(enquiryId, tx))!;
          return {
            result: submitted,
            audit: [
              {
                action: 'sourcing.enquiry_submitted',
                subjectType: 'enquiry',
                subjectId: enquiryId,
                subjectVersion: submitted.aggregateVersion,
                data: {
                  reference,
                  revisionNo: revision.revisionNo,
                  contentHash: revision.contentHash,
                  itemCount: submitted.items.length,
                  assistedIntake: submitted.assistedIntake,
                  jobType: submitted.jobType,
                },
              },
            ],
            outbox: [
              {
                eventType: 'sourcing.enquiry_submitted',
                aggregateType: 'enquiry',
                aggregateId: enquiryId,
                aggregateVersion: submitted.aggregateVersion,
                data: {
                  reference,
                  revisionNo: revision.revisionNo,
                  customerOrganizationId: organizationId,
                  assistedIntake: submitted.assistedIntake,
                },
              },
            ],
          };
        },
      },
      ctx,
      input,
      opts,
    );
  }
}
