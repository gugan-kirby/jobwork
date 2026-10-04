import { Injectable } from '@nestjs/common';
import { defaultMaterialSupply, type Enquiry, type SaveDraftRequest } from '@jobwork/contracts';
import { type Actor, requireOrganization, requireTransactionalStrength } from '../../iam';
import { assertMayAuthorEnquiry } from '../domain/enquiry-policy';
import { DraftNotEditable, EnquiryNotFound, assertVersion } from '../domain/enquiry';
import { EnquiryRepository } from '../infrastructure/enquiry.repository';
import { contextFromActor } from '../../../platform/commands/command';
import { CommandExecutor } from '../../../platform/commands/execute';
import { DomainError } from '../../../platform/http/domain-error';

class DocumentNotUsable extends DomainError {
  constructor(detail: string) {
    super('DOCUMENT_NOT_USABLE', 409, 'That document cannot be attached', detail);
  }
}

/**
 * `FR-307`: a correction refers to the customer's own enquiry or to nothing. Naming
 * another organization's enquiry is refused with the same wording whether that enquiry
 * exists or not.
 */
class RelatedEnquiryNotUsable extends DomainError {
  constructor() {
    super(
      'RELATED_ENQUIRY_NOT_USABLE',
      422,
      'That is not one of your enquiries',
      'Choose the enquiry being corrected from your own list, or leave it blank and quote the reference in the change description.',
      [{ path: 'relatedEnquiryId', message: 'Choose one of your own enquiries' }],
    );
  }
}

/** `FR-301`: an enquiry ships to an address its own organization keeps. */
class DeliverySiteNotUsable extends DomainError {
  constructor() {
    super(
      'DELIVERY_SITE_NOT_USABLE',
      422,
      'That delivery address is not one of yours',
      'Choose an address from your address book, or add a new one.',
    );
  }
}

/**
 * save-draft (`FR-302`). Creates the enquiry on first call and overwrites it on every
 * later one, always under `expectedVersion`.
 *
 * Autosave is where doc 19 §9's "two users edit the same draft" actually bites: two
 * wizards open on one enquiry will both keep saving, and without a guard the last
 * keystroke anywhere wins silently. The row is locked, the version is checked, and the
 * loser is told whose change they are about to lose rather than losing it.
 */
@Injectable()
export class SaveDraftCommand {
  constructor(
    private readonly repo: EnquiryRepository,
    private readonly executor: CommandExecutor,
  ) {}

  async execute(
    actor: Actor,
    enquiryId: string | null,
    input: SaveDraftRequest,
    opts: { idempotencyKey?: string | undefined } = {},
  ): Promise<Enquiry> {
    requireTransactionalStrength(actor);
    const organizationId = requireOrganization(actor);
    assertMayAuthorEnquiry(actor);

    const usable = await this.repo.documentsUsable(
      input.documents.map((doc) => doc.documentVersionId),
      organizationId,
    );
    if (!usable.usable) throw new DocumentNotUsable(usable.reason);

    // A delivery address is the customer's own or it is nobody's: naming another
    // organization's site would leak that it exists and send goods somewhere the
    // customer never chose (`FR-301`).
    if (input.deliverySiteId) {
      const site = await this.repo.siteBelongsTo(input.deliverySiteId, organizationId);
      if (!site) throw new DeliverySiteNotUsable();
    }

    if (input.relatedEnquiryId) {
      const own =
        input.relatedEnquiryId !== enquiryId &&
        (await this.repo.enquiryBelongsTo(input.relatedEnquiryId, organizationId));
      if (!own) throw new RelatedEnquiryNotUsable();
    }

    const ctx = contextFromActor({ userId: actor.userId, organizationId });
    return this.executor.execute(
      {
        operation: 'sourcing.save-draft',
        handler: async (tx, _ctx, cmd: SaveDraftRequest) => {
          const id =
            enquiryId ??
            (await this.repo.createDraft(
              { customerOrganizationId: organizationId, createdBy: actor.userId },
              tx,
            ));

          const existing = await this.repo.findForUpdate(id, tx);
          if (!existing) throw new EnquiryNotFound();
          if (existing.customerOrganizationId !== organizationId) {
            // Not a 403: an enquiry belonging to another organization must not be
            // distinguishable from one that does not exist (doc 11 §5).
            throw new EnquiryNotFound();
          }
          if (existing.status !== 'draft') throw new DraftNotEditable(existing.status);
          assertVersion(cmd.expectedVersion, existing.aggregateVersion);

          await this.repo.replaceDraft(
            id,
            {
              title: cmd.title,
              applicationNote: cmd.applicationNote,
              confidentiality: cmd.confidentiality,
              jobType: cmd.jobType,
              materialSupply: cmd.materialSupply ?? defaultMaterialSupply(cmd.jobType),
              // The correction fields only mean something on a correction; on any other
              // job type they are dropped rather than stored as stray text.
              changeReference: cmd.jobType === 'correction_ecn' ? cmd.changeReference : '',
              changeDescription: cmd.jobType === 'correction_ecn' ? cmd.changeDescription : '',
              relatedEnquiryId: cmd.jobType === 'correction_ecn' ? cmd.relatedEnquiryId : undefined,
              assistedIntake: cmd.assistedIntake,
              deliverySiteId: cmd.deliverySiteId,
              requiredByDate: cmd.requiredByDate,
              partialDelivery: cmd.partialDelivery,
              packagingNote: cmd.packagingNote,
              items: cmd.items,
              documents: cmd.documents,
            },
            tx,
          );

          const saved = (await this.repo.find(id, tx))!;
          return {
            result: saved,
            // A draft edit is not a business event: it is audited (who touched what,
            // for doc 19 §9 conflict forensics) but nothing outside reacts to it.
            audit: [
              {
                action: 'sourcing.enquiry_draft_saved',
                subjectType: 'enquiry',
                subjectId: id,
                subjectVersion: saved.aggregateVersion,
                data: {
                  itemCount: saved.items.length,
                  documentCount: saved.documents.length,
                  assistedIntake: saved.assistedIntake,
                  jobType: saved.jobType,
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

export { DocumentNotUsable, RelatedEnquiryNotUsable };
