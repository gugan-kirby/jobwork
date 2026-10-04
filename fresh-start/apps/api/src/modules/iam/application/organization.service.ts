import { Injectable } from '@nestjs/common';
import { createLogger, type Logger } from '@jobwork/observability';
import type {
  OrganizationDetail,
  OrganizationStatus,
  OrganizationSummary,
} from '@jobwork/contracts';
import { type Actor, requireRole, requireTransactionalStrength } from './actor';
import { NotAuthorized, OrganizationNotFound } from '../domain/errors';
import { IamRepository } from '../infrastructure/iam.repository';
import { AuditWriter } from '../../../platform/commands/audit.writer';
import { contextFromActor } from '../../../platform/commands/command';
import { DatabaseService } from '../../../platform/database/database.service';

@Injectable()
export class OrganizationService {
  private readonly log: Logger = createLogger({ service: 'api' }).child({ module: 'iam.org' });

  constructor(
    private readonly repo: IamRepository,
    private readonly audit: AuditWriter,
    private readonly db: DatabaseService,
  ) {}

  /** Platform administration: creates customer/supplier organizations ahead of first invitations. */
  async createOrganization(
    actor: Actor,
    input: { type: 'customer' | 'supplier'; legalName: string; displayName: string },
  ): Promise<{ organizationId: string }> {
    if (!actor.isInternal) throw new NotAuthorized();
    requireRole(actor, 'platform_admin');
    requireTransactionalStrength(actor);

    const org = await this.db.withTransaction(async (client) => {
      const created = await this.repo.createOrganization(
        { type: input.type, legalName: input.legalName, displayName: input.displayName, createdBy: actor.userId },
        client,
      );
      await this.audit.write(client, contextFromActor(actor), {
        action: 'iam.organization_created',
        subjectType: 'organization',
        subjectId: created.id,
        data: { type: input.type },
      });
      return created;
    });
    this.log.info({ organizationId: org.id, type: input.type }, 'iam.organization_created');
    return { organizationId: org.id };
  }

  /**
   * Internal administration authority. Public so a controller can settle authorization
   * *before* parsing a body: telling someone their JSON is malformed on a route they may
   * not call at all answers a question they were not entitled to ask.
   */
  assertAdministrator(actor: Actor): void {
    if (!actor.isInternal) throw new NotAuthorized('Internal audience only');
    requireRole(actor, 'platform_admin', 'security_admin');
  }

  async listOrganizations(
    actor: Actor,
    filter: { type?: string | undefined; status?: string | undefined },
  ): Promise<OrganizationSummary[]> {
    this.assertAdministrator(actor);
    const rows = await this.repo.listOrganizations(filter);
    return rows.map((row) => ({
      organizationId: row.organizationId,
      type: row.type as OrganizationSummary['type'],
      legalName: row.legalName,
      displayName: row.displayName,
      status: row.status as OrganizationStatus,
      memberCount: row.memberCount,
      activeMemberCount: row.activeMemberCount,
      pendingInvitationCount: row.pendingInvitationCount,
      supplierProfileId: row.supplierProfileId,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async getOrganization(actor: Actor, organizationId: string): Promise<OrganizationDetail> {
    this.assertAdministrator(actor);
    const [row] = await this.repo.listOrganizations({ organizationId });
    if (!row) throw new OrganizationNotFound();

    const [members, invitations] = await Promise.all([
      this.repo.listOrganizationMemberships(organizationId),
      this.repo.listInvitations(organizationId),
    ]);
    const now = Date.now();

    return {
      organization: {
        organizationId: row.organizationId,
        type: row.type as OrganizationSummary['type'],
        legalName: row.legalName,
        displayName: row.displayName,
        status: row.status as OrganizationStatus,
        memberCount: row.memberCount,
        activeMemberCount: row.activeMemberCount,
        pendingInvitationCount: row.pendingInvitationCount,
        supplierProfileId: row.supplierProfileId,
        createdAt: row.createdAt.toISOString(),
      },
      members: members.map((member) => ({
        membershipId: member.membershipId,
        userId: member.userId,
        email: member.email,
        displayName: member.displayName,
        roles: member.roles,
        membershipStatus: member.membershipStatus,
        userStatus: member.userStatus,
        mfaEnrolled: member.mfaEnrolled,
        lastSignInAt: member.lastSignInAt ? member.lastSignInAt.toISOString() : null,
      })),
      invitations: invitations.map((invitation) => ({
        invitationId: invitation.invitationId,
        email: invitation.email,
        proposedRoleKeys: invitation.proposedRoleKeys,
        expiresAt: invitation.expiresAt.toISOString(),
        // An expired invitation is still listed: it is the thing an administrator has
        // to act on, and hiding it is how people end up invited twice.
        expired: invitation.expiresAt.getTime() < now,
        createdAt: invitation.createdAt.toISOString(),
      })),
    };
  }

  /**
   * Suspending an organization takes everyone in it out of the product at once — the
   * blunt instrument for a compliance stop or a contract ending. It is audited with a
   * mandatory reason, and it is reversible.
   */
  async setOrganizationStatus(
    actor: Actor,
    organizationId: string,
    status: OrganizationStatus,
    reason: string | undefined,
  ): Promise<void> {
    this.assertAdministrator(actor);
    requireTransactionalStrength(actor);
    if (actor.organizationId === organizationId) {
      throw new NotAuthorized('An organization cannot suspend itself');
    }
    const organization = await this.repo.findOrganization(organizationId);
    if (!organization) throw new OrganizationNotFound();

    await this.db.withTransaction(async (client) => {
      const changed = await this.repo.setOrganizationStatus(organizationId, status, client);
      if (!changed) throw new NotAuthorized(`The organization is already ${status}`);
      await this.audit.write(client, contextFromActor(actor), {
        action: status === 'active' ? 'iam.organization_reinstated' : 'iam.organization_suspended',
        subjectType: 'organization',
        subjectId: organizationId,
        ...(reason ? { reason } : {}),
        data: { status, previousStatus: organization.status },
      });
    });
    this.log.warn({ organizationId, status, by: actor.userId }, 'iam.organization_status_changed');
  }
}
