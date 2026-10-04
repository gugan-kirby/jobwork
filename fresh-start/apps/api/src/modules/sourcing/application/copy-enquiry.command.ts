import { Injectable } from '@nestjs/common';
import type { CopyEnquiryRequest, Enquiry } from '@jobwork/contracts';
import { type Actor, requireOrganization, requireTransactionalStrength } from '../../iam';
import { assertMayAuthorEnquiry } from '../domain/enquiry-policy';
import { EnquiryNotFound } from '../domain/enquiry';
import { EnquiryRepository } from '../infrastructure/enquiry.repository';
import { contextFromActor } from '../../../platform/commands/command';
import { CommandExecutor } from '../../../platform/commands/execute';

/**
 * copy-enquiry (UC-02, the reorder path).
 *
 * The copy lands as a **draft**, never as a submission — that is the whole safety
 * property. Reordering is where a stale drawing revision or last year's quantity
 * quietly becomes this year's order, so the customer is put back through review and
 * submit, and the new enquiry freezes its own revision 1 with its own hash. The link
 * to the original is kept so the lineage is visible, not so it can be reused.
 *
 * Document links are copied by *version*, so the copy points at exactly the file the
 * original was quoted against; uploading a newer revision is a deliberate act in the
 * wizard, not something inherited by accident.
 *
 * Job type travels with the copy. A copy of a *correction* is itself a correction of the
 * source — the ECN reference is cleared, because reusing last time's ECN number is the
 * one thing a new correction must never do — while job work and new-model copies are
 * plain reorders.
 */
@Injectable()
export class CopyEnquiryCommand {
  constructor(
    private readonly repo: EnquiryRepository,
    private readonly executor: CommandExecutor,
  ) {}

  async execute(
    actor: Actor,
    sourceEnquiryId: string,
    input: CopyEnquiryRequest,
    opts: { idempotencyKey?: string | undefined } = {},
  ): Promise<Enquiry> {
    requireTransactionalStrength(actor);
    const organizationId = requireOrganization(actor);
    assertMayAuthorEnquiry(actor);

    const ctx = contextFromActor({ userId: actor.userId, organizationId });
    return this.executor.execute(
      {
        operation: 'sourcing.copy-enquiry',
        handler: async (tx, _ctx, cmd: CopyEnquiryRequest) => {
          const source = await this.repo.find(sourceEnquiryId, tx);
          if (!source || source.customerOrganizationId !== organizationId) {
            throw new EnquiryNotFound();
          }

          // Documents the original used may since have been withdrawn or re-scanned.
          // Silently dropping them would produce a copy that looks complete and is not,
          // so the unusable ones are left out and the customer re-attaches deliberately.
          const usableDocuments: typeof source.documents = [];
          for (const doc of source.documents) {
            const check = await this.repo.documentsUsable(
              [doc.documentVersionId],
              organizationId,
              tx,
            );
            if (check.usable) usableDocuments.push(doc);
          }

          const copyId = await this.repo.createDraft(
            {
              customerOrganizationId: organizationId,
              createdBy: actor.userId,
              copiedFromEnquiryId: sourceEnquiryId,
            },
            tx,
          );

          await this.repo.replaceDraft(
            copyId,
            {
              title: cmd.title ?? (source.title ? `${source.title} (copy)` : ''),
              applicationNote: source.applicationNote,
              confidentiality: source.confidentiality,
              jobType: source.jobType,
              materialSupply: source.materialSupply,
              changeReference: '',
              changeDescription: '',
              relatedEnquiryId:
                source.jobType === 'correction_ecn' && source.reference ? sourceEnquiryId : undefined,
              assistedIntake: source.assistedIntake,
              deliverySiteId: source.deliverySiteId ?? undefined,
              // Dates are the one thing a reorder must not inherit: last year's
              // required-by date is always wrong and would submit without complaint.
              requiredByDate: undefined,
              partialDelivery: source.partialDelivery,
              packagingNote: source.packagingNote,
              items: source.items.map((item) => {
                const { enquiryItemId: _ignored, targetDate: _dropped, ...rest } = item;
                return rest;
              }),
              documents: usableDocuments.map((doc) => ({
                documentVersionId: doc.documentVersionId,
                ...(doc.lineNo !== null ? { lineNo: doc.lineNo } : {}),
                role: doc.role,
                note: doc.note,
              })),
            },
            tx,
          );

          const copy = (await this.repo.find(copyId, tx))!;
          return {
            result: copy,
            audit: [
              {
                action: 'sourcing.enquiry_copied',
                subjectType: 'enquiry',
                subjectId: copyId,
                subjectVersion: copy.aggregateVersion,
                data: {
                  copiedFromEnquiryId: sourceEnquiryId,
                  droppedDocumentCount: source.documents.length - usableDocuments.length,
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
