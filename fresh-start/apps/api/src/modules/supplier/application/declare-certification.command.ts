import { Injectable } from '@nestjs/common';
import type { Certification, DeclareCertificationRequest } from '@jobwork/contracts';
import { type Actor, requireOrganization, requireTransactionalStrength } from '../../iam';
import { NotAuthorized } from '../../iam/domain/errors';
import { EvidenceNotUsable } from '../domain/verification';
import { SupplierNotFound } from '../domain/errors';
import { assertMayMaintainProfile } from '../domain/supplier-policy';
import { SupplierRepository } from '../infrastructure/supplier.repository';
import { contextFromActor } from '../../../platform/commands/command';
import { CommandExecutor } from '../../../platform/commands/execute';

/**
 * declare-certification (F-SO.6). A certificate a supplier holds is a claim until a
 * reviewer decides it, so declaring one raises the matching `certification` verification
 * item and leaves the certification row `declared`. The eligibility projection already
 * counts only `verified` certifications, so nothing a supplier types about itself can
 * make it eligible.
 */
@Injectable()
export class DeclareCertificationCommand {
  constructor(
    private readonly repo: SupplierRepository,
    private readonly executor: CommandExecutor,
  ) {}

  async execute(
    actor: Actor,
    input: DeclareCertificationRequest,
    opts: { idempotencyKey?: string | undefined } = {},
  ): Promise<Certification> {
    requireTransactionalStrength(actor);
    const organizationId = requireOrganization(actor);
    if (actor.organizationType !== 'supplier') {
      throw new NotAuthorized('Only a supplier declares its own certifications');
    }
    assertMayMaintainProfile(actor);

    const profile = await this.repo.findProfileByOrganization(organizationId);
    if (!profile) throw new SupplierNotFound();

    if (input.evidenceDocumentVersionId) {
      const usable = await this.repo.evidenceUsable(input.evidenceDocumentVersionId, organizationId);
      if (!usable.usable) throw new EvidenceNotUsable(usable.reason);
    }

    return this.executor.execute(
      {
        operation: 'supplier.declare-certification',
        handler: async (tx, _ctx, cmd: DeclareCertificationRequest) => {
          const certification = await this.repo.upsertCertification(
            {
              profileId: profile.id,
              certificationType: cmd.certificationType,
              certificateNumber: cmd.certificateNumber ?? null,
              issuer: cmd.issuer ?? null,
              issuedOn: cmd.issuedOn ?? null,
              expiresOn: cmd.expiresOn ?? null,
              evidenceDocumentVersionId: cmd.evidenceDocumentVersionId ?? null,
              createdBy: actor.userId,
            },
            tx,
          );

          // The evidence goes to the same queue every other supplier claim goes to;
          // a certification that nobody reviewed counts for nothing.
          const previous = await this.repo.findLatestVerification(profile.id, 'certification', tx);
          const pending = previous && ['submitted', 'under_review'].includes(previous.status);
          if (!pending && cmd.evidenceDocumentVersionId) {
            await this.repo.appendVerificationItem(
              {
                supplierProfileId: profile.id,
                kind: 'certification',
                versionNo: (previous?.versionNo ?? 0) + 1,
                referenceValue: cmd.certificationType,
                evidenceDocumentVersionId: cmd.evidenceDocumentVersionId,
                expiresAt: cmd.expiresOn ? new Date(`${cmd.expiresOn}T00:00:00Z`) : null,
                submittedBy: actor.userId,
                supersedesId: previous?.id ?? null,
              },
              tx,
            );
          }

          return {
            result: {
              certificationId: certification.id,
              certificationType: certification.certificationType,
              certificateNumber: certification.certificateNumber,
              issuer: certification.issuer,
              issuedOn: certification.issuedOn,
              expiresOn: certification.expiresOn,
              status: certification.status,
              evidenceDocumentVersionId: certification.evidenceDocumentVersionId,
            },
            audit: [
              {
                action: 'supplier.certification_declared',
                subjectType: 'certification',
                subjectId: certification.id,
                data: {
                  supplierProfileId: profile.id,
                  certificationType: cmd.certificationType,
                  expiresOn: cmd.expiresOn ?? null,
                  hasEvidence: Boolean(cmd.evidenceDocumentVersionId),
                },
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
}
