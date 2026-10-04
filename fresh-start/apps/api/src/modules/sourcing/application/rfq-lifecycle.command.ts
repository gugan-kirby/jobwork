import { Injectable } from '@nestjs/common';
import type {
  CloseRfqRequest,
  CreateRfqRequest,
  InviteSupplierRequest,
  ReleaseRfqRequest,
  RevokeInvitationRequest,
} from '@jobwork/contracts';
import { type Actor, requireOrganization, requireTransactionalStrength } from '../../iam';
import { NotAuthorized } from '../../iam/domain/errors';
import { VersionConflict } from '../../../platform/http/domain-error';
import { DmsRepository } from '../../dms';
import { EligibilityProjection, SupplierRepository } from '../../supplier';
import { EnquiryNotFound } from '../domain/enquiry';
import {
  assertInvitationTransition,
  assertRfqTransition,
  closeReadiness,
  closingStatus,
  InvitationNotFound,
  ReleaseBlocked,
  RfqNotFound,
  SupplierNotEligible,
} from '../domain/rfq';
import { EnquiryRepository } from '../infrastructure/enquiry.repository';
import { RfqRepository } from '../infrastructure/rfq.repository';
import { MatchSuppliersQuery } from './match-suppliers.query';
import { contextFromActor } from '../../../platform/commands/command';
import { CommandExecutor } from '../../../platform/commands/execute';

/** Internal roles that run a sourcing round (doc 03 §2). */
function assertMaySource(actor: Actor): void {
  if (
    !actor.isInternal ||
    !actor.roles.some((role) => ['jobwork_sourcing', 'platform_admin'].includes(role))
  ) {
    throw new NotAuthorized('Only JobWork sourcing runs an RFQ');
  }
}

/**
 * The sourcing round's lifecycle (doc 06 §4, `FR-304`, `FR-305`).
 *
 * Release is the command that matters. It is the moment a customer's drawings reach
 * another company, so it checks four things in one transaction and refuses the whole
 * release if any fails: the enquiry is approved for sourcing, every document is scanned
 * clean and available, every invited supplier is still eligible *now* (not when they
 * were shortlisted), and any required agreement has been accepted. Then it grants each
 * invited organization access to exactly the versions on the manifest — no more.
 */
@Injectable()
export class RfqLifecycleCommand {
  constructor(
    private readonly rfqs: RfqRepository,
    private readonly enquiries: EnquiryRepository,
    private readonly eligibility: EligibilityProjection,
    private readonly suppliers: SupplierRepository,
    private readonly dms: DmsRepository,
    private readonly matcher: MatchSuppliersQuery,
    private readonly executor: CommandExecutor,
  ) {}

  async create(
    actor: Actor,
    input: CreateRfqRequest,
    opts: { idempotencyKey?: string | undefined } = {},
  ): Promise<{ rfqId: string }> {
    requireTransactionalStrength(actor);
    assertMaySource(actor);
    requireOrganization(actor);

    const enquiry = await this.enquiries.find(input.enquiryId);
    if (!enquiry) throw new EnquiryNotFound();
    if (enquiry.status !== 'approved_for_sourcing') {
      throw new ReleaseBlocked(
        `Only an approved enquiry can be sourced; this one is ${enquiry.status}.`,
      );
    }
    const requirement = await this.enquiries.latestRequirement(input.enquiryId);
    if (!requirement) throw new ReleaseBlocked('This enquiry has no frozen requirement revision.');

    return this.executor.execute(
      {
        operation: 'sourcing.create-rfq',
        handler: async (tx, _ctx, cmd: CreateRfqRequest) => {
          const roundNo = await this.rfqs.nextRoundNo(cmd.enquiryId, tx);
          const rfqId = await this.rfqs.createRfq(
            {
              enquiryId: cmd.enquiryId,
              requirementId: requirement.id,
              roundNo,
              deadlineAt: new Date(cmd.deadlineAt),
              lateBidPolicy: cmd.lateBidPolicy,
              instructions: cmd.instructions,
              createdBy: actor.userId,
            },
            tx,
          );

          // The lines are frozen from the requirement revision, not read live from the
          // enquiry: a round quotes what it quoted (`FR-304`).
          let lineNo = 1;
          for (const item of enquiry.items) {
            await this.rfqs.addItem(
              {
                rfqId,
                enquiryItemId: item.enquiryItemId,
                lineNo: lineNo++,
                partName: item.partName,
                description: item.description,
                quantityBreakpoints: item.quantityBreakpoints,
                specification: {
                  materialGrade: item.materialGrade ?? null,
                  toleranceClass: item.toleranceClass ?? null,
                  criticalTolerance: item.criticalTolerance ?? null,
                  inspectionLevel: item.inspectionLevel,
                  qualityNote: item.qualityNote,
                },
              },
              tx,
            );
          }

          return {
            result: { rfqId },
            audit: [
              {
                action: 'sourcing.rfq_created',
                subjectType: 'rfq',
                subjectId: rfqId,
                data: {
                  enquiryId: cmd.enquiryId,
                  roundNo,
                  requirementId: requirement.id,
                  deadlineAt: cmd.deadlineAt,
                },
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

  /** Shortlisting. An ineligible supplier needs an override reason, recorded on the row. */
  async invite(
    actor: Actor,
    rfqId: string,
    input: InviteSupplierRequest,
    opts: { idempotencyKey?: string | undefined } = {},
  ): Promise<{ rfqSupplierId: string }> {
    requireTransactionalStrength(actor);
    assertMaySource(actor);

    const rfq = await this.rfqs.findRfq(rfqId);
    if (!rfq) throw new RfqNotFound();
    if (rfq.status !== 'draft' && rfq.status !== 'internal_review') {
      throw new ReleaseBlocked('Suppliers are invited before the round is released.');
    }

    const profile = await this.suppliers.findProfile(input.supplierProfileId);
    if (!profile) throw new SupplierNotEligible(['unknown supplier']);

    const records = await this.eligibility.query({ limit: 500 });
    const snapshot = records.find(
      (candidate) => candidate.supplierProfileId === input.supplierProfileId,
    );
    const exclusions = snapshot?.exclusions ?? ['no_published_capability'];
    const eligible = snapshot?.eligible ?? false;
    if (!eligible && !input.overrideReason) throw new SupplierNotEligible(exclusions);

    return this.executor.execute(
      {
        operation: 'sourcing.invite-supplier',
        handler: async (tx, _ctx, cmd: InviteSupplierRequest) => {
          const rfqSupplierId = await this.rfqs.addInvitation(
            {
              rfqId,
              supplierProfileId: cmd.supplierProfileId,
              supplierOrganizationId: profile.organizationId,
              eligibilitySnapshot: { eligible, exclusions },
              overrideReason: cmd.overrideReason ?? null,
            },
            tx,
          );
          return {
            result: { rfqSupplierId },
            audit: [
              {
                action: 'sourcing.supplier_shortlisted',
                subjectType: 'rfq_supplier',
                subjectId: rfqSupplierId,
                ...(cmd.overrideReason ? { reason: cmd.overrideReason } : {}),
                data: {
                  rfqId,
                  supplierProfileId: cmd.supplierProfileId,
                  eligible,
                  exclusions,
                  overridden: Boolean(cmd.overrideReason),
                },
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

  async release(
    actor: Actor,
    rfqId: string,
    input: ReleaseRfqRequest,
    opts: { idempotencyKey?: string | undefined } = {},
  ): Promise<{ rfqId: string; reference: string; invited: number; documents: number }> {
    requireTransactionalStrength(actor);
    assertMaySource(actor);

    const rfq = await this.rfqs.findRfq(rfqId);
    if (!rfq) throw new RfqNotFound();
    assertRfqTransition(rfq.status, 'open');

    const enquiry = await this.enquiries.find(rfq.enquiryId);
    if (!enquiry) throw new EnquiryNotFound();
    if (enquiry.status !== 'approved_for_sourcing') {
      throw new ReleaseBlocked(`The enquiry is ${enquiry.status}, not approved for sourcing.`);
    }

    const invitations = await this.rfqs.listInvitations(rfqId);
    const live = invitations.filter((invitation) => invitation.status !== 'revoked');
    if (live.length === 0) {
      throw new ReleaseBlocked('Nobody is on the shortlist. Invite at least one supplier.');
    }

    // Documents: only scan-clean, available versions travel (doc 09 §6, `BR-ENG-02`).
    const documents = await this.rfqs.listEnquiryDocuments(rfq.enquiryId);
    const unreleasable = documents.filter(
      (document) => document.versionStatus !== 'available' || document.scanState !== 'clean',
    );
    if (unreleasable.length > 0) {
      throw new ReleaseBlocked(
        `${unreleasable.length} attached document${unreleasable.length === 1 ? ' is' : 's are'} not scanned clean yet. Release would send suppliers something nobody has checked.`,
      );
    }

    // Eligibility is re-checked at release, not trusted from shortlisting time: a
    // certificate can lapse between Tuesday and Friday (doc 19 §4).
    const records = await this.eligibility.query({ limit: 500 });
    const ndaRequired = enquiry.confidentiality === 'nda_required';
    for (const invitation of live) {
      const current = records.find(
        (record) => record.supplierProfileId === invitation.supplierProfileId,
      );
      if (!current?.eligible && !invitation.overrideReason) {
        throw new ReleaseBlocked(
          `${invitation.displayName} is no longer eligible (${(current?.exclusions ?? ['unknown']).join(', ')}). Remove them or record an override.`,
        );
      }
      if (ndaRequired) {
        const accepted = await this.rfqs.hasAcceptedAgreement(
          invitation.supplierOrganizationId,
          'nda',
        );
        if (!accepted) {
          throw new ReleaseBlocked(
            `${invitation.displayName} has not accepted the NDA this enquiry requires.`,
          );
        }
      }
    }

    return this.executor.execute(
      {
        operation: 'sourcing.release-rfq',
        handler: async (tx, _ctx, cmd: ReleaseRfqRequest) => {
          const updated = await this.rfqs.setRfqStatus(
            {
              rfqId,
              expectedVersion: cmd.expectedVersion,
              status: 'open',
              released: { by: actor.userId },
            },
            tx,
          );
          if (!updated) throw new VersionConflict();
          const reference = await this.rfqs.allocateReference(rfqId, tx);

          // The manifest first, then one grant per invited organization per version.
          for (const document of documents) {
            await this.rfqs.addReleaseItem(
              {
                rfqId,
                documentVersionId: document.documentVersionId,
                role: document.role,
                sha256: document.sha256,
              },
              tx,
            );
          }

          const audit: Array<{
            action: string;
            subjectType: string;
            subjectId: string;
            data: Record<string, unknown>;
          }> = [
            {
              action: 'sourcing.rfq_released',
              subjectType: 'rfq',
              subjectId: rfqId,
              data: {
                reference,
                enquiryId: rfq.enquiryId,
                invited: live.length,
                documents: documents.length,
                deadlineAt: rfq.deadlineAt?.toISOString() ?? null,
              },
            },
          ];

          for (const invitation of live) {
            assertInvitationTransition(invitation.status, 'invited');
            await this.rfqs.setInvitationStatus(
              { invitationId: invitation.id, status: 'invited' },
              tx,
            );
            for (const document of documents) {
              await this.dms.ensureGrant(
                {
                  versionId: document.documentVersionId,
                  organizationId: invitation.supplierOrganizationId,
                  actions: ['view', 'download'],
                  grantedBy: actor.userId,
                },
                tx,
              );
            }
            audit.push({
              action: 'sourcing.supplier_invited',
              subjectType: 'rfq_supplier',
              subjectId: invitation.id,
              data: {
                rfqId,
                reference,
                supplierOrganizationId: invitation.supplierOrganizationId,
                documents: documents.length,
              },
            });
          }

          return {
            result: {
              rfqId,
              reference,
              invited: live.length,
              documents: documents.length,
            },
            audit,
            outbox: [
              {
                eventType: 'sourcing.rfq_released.v1',
                aggregateType: 'rfq',
                aggregateId: rfqId,
                aggregateVersion: updated.aggregateVersion,
                data: {
                  reference,
                  // Supplier organizations only: this event must never carry the
                  // customer's identity to a supplier-facing consumer.
                  invitedOrganizationIds: live.map((i) => i.supplierOrganizationId),
                  deadlineAt: rfq.deadlineAt?.toISOString() ?? null,
                },
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

  /**
   * Revoking an invitation withdraws the document grants with it. What the supplier
   * already downloaded is a fact that happened — the access log holds it — and revocation
   * is honest about being forward-looking (doc 19 §3).
   */
  async revokeInvitation(
    actor: Actor,
    rfqId: string,
    invitationId: string,
    input: RevokeInvitationRequest,
    opts: { idempotencyKey?: string | undefined } = {},
  ): Promise<{ revoked: true; grantsRevoked: number }> {
    requireTransactionalStrength(actor);
    assertMaySource(actor);

    const invitation = await this.rfqs.findInvitation(invitationId);
    if (!invitation || invitation.rfqId !== rfqId) throw new InvitationNotFound();
    assertInvitationTransition(invitation.status, 'revoked');

    const release = await this.rfqs.listReleaseItems(rfqId);

    return this.executor.execute(
      {
        operation: 'sourcing.revoke-invitation',
        handler: async (tx, _ctx, cmd: RevokeInvitationRequest) => {
          await this.rfqs.setInvitationStatus(
            { invitationId, status: 'revoked', revokeReason: cmd.reason },
            tx,
          );
          let grantsRevoked = 0;
          for (const item of release) {
            grantsRevoked += await this.dms.revokeGrantsFor(
              {
                versionId: item.documentVersionId,
                organizationId: invitation.supplierOrganizationId,
                revokedBy: actor.userId,
                reason: `RFQ invitation revoked: ${cmd.reason}`,
              },
              tx,
            );
          }
          return {
            result: { revoked: true as const, grantsRevoked },
            audit: [
              {
                action: 'sourcing.invitation_revoked',
                subjectType: 'rfq_supplier',
                subjectId: invitationId,
                reason: cmd.reason,
                data: {
                  rfqId,
                  supplierOrganizationId: invitation.supplierOrganizationId,
                  grantsRevoked,
                },
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

  /** Close for evaluation (doc 06 §4). A round nobody bid on closes as `no_bid`. */
  async close(
    actor: Actor,
    rfqId: string,
    input: CloseRfqRequest,
    opts: { idempotencyKey?: string | undefined } = {},
  ): Promise<{ status: string; responded: number; reason: string }> {
    requireTransactionalStrength(actor);
    assertMaySource(actor);

    const rfq = await this.rfqs.findRfq(rfqId);
    if (!rfq) throw new RfqNotFound();
    const invitations = await this.rfqs.listInvitations(rfqId);
    const readiness = closeReadiness({
      deadlineAt: rfq.deadlineAt,
      now: new Date(),
      invitations,
    });
    if (!readiness.ready) throw new ReleaseBlocked(`Not ready to close: ${readiness.reason}.`);

    const responded = invitations.filter((invitation) => invitation.status === 'responded').length;
    const target = closingStatus(responded);
    assertRfqTransition(rfq.status, target);

    return this.executor.execute(
      {
        operation: 'sourcing.close-rfq',
        handler: async (tx, _ctx, cmd: CloseRfqRequest) => {
          const updated = await this.rfqs.setRfqStatus(
            {
              rfqId,
              expectedVersion: cmd.expectedVersion,
              status: target,
              closed: { by: actor.userId, reason: cmd.reason ?? readiness.reason },
            },
            tx,
          );
          if (!updated) throw new VersionConflict();

          // Anybody who never answered is dispositioned explicitly rather than left
          // ambiguous (doc 19 §4 "all decline / no response").
          for (const invitation of invitations) {
            if (['invited', 'acknowledged', 'clarifying'].includes(invitation.status)) {
              await this.rfqs.setInvitationStatus(
                { invitationId: invitation.id, status: 'no_response' },
                tx,
              );
            }
          }

          return {
            result: { status: target, responded, reason: readiness.reason },
            audit: [
              {
                action: target === 'no_bid' ? 'sourcing.rfq_no_bid' : 'sourcing.rfq_closed',
                subjectType: 'rfq',
                subjectId: rfqId,
                subjectVersion: updated.aggregateVersion,
                ...(cmd.reason ? { reason: cmd.reason } : {}),
                data: {
                  responded,
                  invited: invitations.length,
                  singleSource: responded === 1 && invitations.length > 1,
                },
              },
            ],
            outbox: [
              {
                eventType: 'sourcing.rfq_closed.v1',
                aggregateType: 'rfq',
                aggregateId: rfqId,
                aggregateVersion: updated.aggregateVersion,
                data: { status: target, responded },
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

  /** Recorded matching, kept with the round it informed (`FR-204`). */
  async recordMatch(actor: Actor, enquiryId: string, rfqId: string | null): Promise<void> {
    const result = await this.matcher.execute(actor, enquiryId);
    await this.executor.execute(
      {
        operation: 'sourcing.record-match',
        handler: async (tx) => {
          const snapshotId = await this.rfqs.recordMatchSnapshot(
            {
              rfqId,
              enquiryId,
              configVersion: result.configVersion,
              inputs: { requiredCapabilityCodes: result.requiredCapabilityCodes },
              candidates: result.candidates,
              shortlist: result.candidates.filter((candidate) => candidate.eligible),
              createdBy: actor.userId,
            },
            tx,
          );
          return {
            result: undefined,
            audit: [
              {
                action: 'sourcing.match_recorded',
                subjectType: 'match_snapshot',
                subjectId: snapshotId,
                data: {
                  enquiryId,
                  rfqId,
                  configVersion: result.configVersion,
                  eligibleCount: result.eligibleCount,
                },
              },
            ],
          };
        },
      },
      contextFromActor(actor),
      { enquiryId, rfqId },
      {},
    );
  }
}
