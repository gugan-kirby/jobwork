import { Injectable } from '@nestjs/common';
import type { AdmitSupplierRequest, AdmitSupplierResponse } from '@jobwork/contracts';
import { type Actor, requireRole, requireTransactionalStrength } from '../../iam';
import { NotAuthorized } from '../../iam/domain/errors';
import { IamRepository } from '../../iam/infrastructure/iam.repository';
import { INVITATION_TTL_DAYS } from '../../iam/domain/session-policy';
import { generateToken, hashToken } from '../../iam/domain/tokens';
import { ApplicationAlreadyDecided, ApplicationNotFound, DuplicateSupplierIdentity } from '../domain/errors';
import { NetworkApplicationRepository, SupplierRepository } from '../infrastructure/supplier.repository';
import { ConfigService } from '../../../platform/config/config.service';
import { contextFromActor } from '../../../platform/commands/command';
import { CommandExecutor } from '../../../platform/commands/execute';

/**
 * admit-supplier (F-SO.2). JobWork admits a supplier: organization, profile and the
 * first invitation are written in one transaction, because each on its own is a
 * half-admission — an organization nobody can sign into, a profile with no organization,
 * an invitation into nothing.
 *
 * Admission is not qualification. The supplier leaves this command in `onboarding` with
 * everything still to prove; only `approveSupplier` makes it a member of the network.
 */
@Injectable()
export class AdmitSupplierCommand {
  constructor(
    private readonly repo: SupplierRepository,
    private readonly applications: NetworkApplicationRepository,
    private readonly iam: IamRepository,
    private readonly config: ConfigService,
    private readonly executor: CommandExecutor,
  ) {}

  async execute(
    actor: Actor,
    input: AdmitSupplierRequest,
    opts: { idempotencyKey?: string | undefined } = {},
  ): Promise<AdmitSupplierResponse> {
    if (!actor.isInternal) throw new NotAuthorized('Only JobWork admits suppliers');
    requireRole(actor, 'platform_admin');
    requireTransactionalStrength(actor);

    // The identifier catches the duplicate the name never does: two spellings of one
    // workshop are two rows, one GSTIN is one legal entity.
    const identities = [input.gstin, input.pan].filter((v): v is string => Boolean(v));
    const existing = await this.repo.findSupplierByIdentity(identities);
    if (existing) {
      throw new DuplicateSupplierIdentity(existing.displayName, existing.kind);
    }

    const token = generateToken();
    const result = await this.executor.execute(
      {
        operation: 'supplier.admit-supplier',
        handler: async (tx, _ctx, cmd: AdmitSupplierRequest) => {
          const organization = await this.iam.createOrganization(
            {
              type: 'supplier',
              legalName: cmd.legalName,
              displayName: cmd.displayName,
              createdBy: actor.userId,
            },
            tx,
          );
          const supplierProfileId = await this.repo.createProfile(
            {
              organizationId: organization.id,
              createdBy: actor.userId,
              regionClass: cmd.regionClass,
              tradeName: cmd.tradeName,
              primaryContactName: cmd.primaryContactName,
              primaryContactEmail: cmd.primaryContactEmail,
              primaryContactPhone: cmd.primaryContactPhone,
            },
            tx,
          );

          // Identity numbers JobWork was given at admission start their own evidence
          // items in draft: the supplier still has to back them with a document, and a
          // reviewer still has to decide them. Nothing here counts as verified.
          for (const [kind, value] of [
            ['gst', cmd.gstin],
            ['pan', cmd.pan],
          ] as const) {
            if (!value) continue;
            await this.repo.appendVerificationItem(
              {
                supplierProfileId,
                kind,
                versionNo: 1,
                referenceValue: value,
                evidenceDocumentVersionId: null,
                expiresAt: null,
                submittedBy: null,
                supersedesId: null,
                status: 'draft',
              },
              tx,
            );
          }

          // Admission that answers an application closes it here, inside the same
          // transaction: an admitted supplier with an application still "received"
          // would be admitted twice by the next operator to open the queue (F-MX.4).
          if (cmd.applicationId) {
            const application = await this.applications.find(cmd.applicationId, tx);
            if (!application) throw new ApplicationNotFound();
            const closed = await this.applications.decide(
              {
                id: cmd.applicationId,
                status: 'admitted',
                decidedBy: actor.userId,
                reason: '',
                admittedOrganizationId: organization.id,
              },
              tx,
            );
            if (!closed) throw new ApplicationAlreadyDecided(application.status);
          }

          const invitation = await this.iam.createInvitation(
            {
              organizationId: organization.id,
              email: cmd.firstUserEmail,
              proposedRoleKeys: cmd.firstUserRoleKeys,
              tokenHash: hashToken(token),
              invitedBy: actor.userId,
              expiresAt: new Date(Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000),
            },
            tx,
          );

          return {
            result: {
              supplierProfileId,
              organizationId: organization.id,
              invitationId: invitation.id,
            },
            audit: [
              {
                action: 'supplier.admitted',
                subjectType: 'supplier_profile',
                subjectId: supplierProfileId,
                data: {
                  organizationId: organization.id,
                  legalName: cmd.legalName,
                  regionClass: cmd.regionClass,
                  hasGstin: Boolean(cmd.gstin),
                  hasPan: Boolean(cmd.pan),
                },
              },
              {
                action: 'iam.organization_created',
                subjectType: 'organization',
                subjectId: organization.id,
                data: { type: 'supplier' },
              },
              {
                action: 'iam.invitation_issued',
                subjectType: 'invitation',
                subjectId: invitation.id,
                data: {
                  organizationId: organization.id,
                  roleKeys: cmd.firstUserRoleKeys,
                },
              },
            ],
            outbox: [
              {
                eventType: 'iam.invitation.issued.v1',
                aggregateType: 'invitation',
                aggregateId: invitation.id,
                data: {
                  invitationId: invitation.id,
                  organizationId: organization.id,
                  organizationName: cmd.displayName,
                  email: cmd.firstUserEmail,
                  // The raw token lives only as long as delivery; the worker strips it.
                  rawToken: token,
                },
              },
              {
                eventType: 'supplier.admitted.v1',
                aggregateType: 'supplier_profile',
                aggregateId: supplierProfileId,
                data: { organizationId: organization.id, regionClass: cmd.regionClass },
              },
            ],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );

    return this.config.env.NODE_ENV === 'production'
      ? result
      : { ...result, acceptUrl: `http://localhost:3000/accept-invitation?token=${token}` };
  }
}
