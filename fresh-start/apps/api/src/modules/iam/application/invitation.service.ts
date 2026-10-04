import { Injectable } from '@nestjs/common';
import { createLogger, type Logger } from '@jobwork/observability';
import { type Actor, requireRole, requireTransactionalStrength } from './actor';
import {
  AccountExists,
  InvitationInvalid,
  NotAuthorized,
} from '../domain/errors';
import { ValidationFailed } from '../../../platform/http/domain-error';
import {
  PASSWORD_PARAMS_VERSION,
  hashPassword,
  passwordPolicyIssue,
} from '../domain/password';
import { INVITATION_TTL_DAYS } from '../domain/session-policy';
import { generateToken, hashToken } from '../domain/tokens';
import { IamRepository } from '../infrastructure/iam.repository';
import { AuditWriter } from '../../../platform/commands/audit.writer';
import { contextFromActor } from '../../../platform/commands/command';
import { CommandExecutor } from '../../../platform/commands/execute';
import { DatabaseService } from '../../../platform/database/database.service';
import { ConfigService } from '../../../platform/config/config.service';

/** Roles an organization administrator may propose, constrained by organization type. */
const ROLE_SCOPE: Record<string, string[]> = {
  customer: ['org_admin', 'customer_requester', 'customer_approver'],
  supplier: ['org_admin', 'supplier_estimator', 'supplier_production', 'supplier_quality'],
  internal: [
    'org_admin',
    'jobwork_sales',
    'jobwork_sourcing',
    'jobwork_engineering',
    'jobwork_quality',
    'jobwork_finance',
    'jobwork_logistics',
    'jobwork_support',
    'platform_admin',
    'security_admin',
    'auditor',
  ],
};

@Injectable()
export class InvitationService {
  private readonly log: Logger = createLogger({ service: 'api' }).child({ module: 'iam.invitation' });

  constructor(
    private readonly repo: IamRepository,
    private readonly db: DatabaseService,
    private readonly config: ConfigService,
    private readonly executor: CommandExecutor,
    private readonly audit: AuditWriter,
  ) {}

  /**
   * invite-member (doc 08 §5): org_admin invites into their own organization;
   * internal platform_admin may invite into any organization (first admins).
   */
  async inviteMember(
    actor: Actor,
    targetOrganizationId: string,
    input: { email: string; roleKeys: string[]; idempotencyKey?: string | undefined },
  ): Promise<{ invitationId: string; acceptUrl?: string }> {
    requireTransactionalStrength(actor);

    const targetOrg = await this.repo.findOrganization(targetOrganizationId);
    if (!targetOrg || targetOrg.status !== 'active') {
      throw new NotAuthorized('Organization unavailable');
    }

    if (actor.organizationId === targetOrganizationId) {
      requireRole(actor, 'org_admin', 'platform_admin');
    } else if (actor.isInternal && actor.roles.includes('platform_admin')) {
      // internal administration path
    } else {
      throw new NotAuthorized();
    }

    const allowed = ROLE_SCOPE[targetOrg.type] ?? [];
    const invalid = input.roleKeys.filter((k) => !allowed.includes(k));
    if (invalid.length > 0) {
      throw new ValidationFailed(
        invalid.map((k) => ({ path: 'roleKeys', message: `role ${k} not valid for ${targetOrg.type} organization` })),
      );
    }

    const token = generateToken();
    const invitationId = await this.executor.execute(
      {
        operation: 'iam.invite-member',
        handler: async (tx, _ctx, cmd: { email: string; roleKeys: string[] }) => {
          const invitation = await this.repo.createInvitation(
            {
              organizationId: targetOrganizationId,
              email: cmd.email,
              proposedRoleKeys: cmd.roleKeys,
              tokenHash: hashToken(token),
              invitedBy: actor.userId,
              expiresAt: new Date(Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000),
            },
            tx,
          );
          return {
            result: invitation.id,
            audit: [
              {
                action: 'iam.invitation_issued',
                subjectType: 'invitation',
                subjectId: invitation.id,
                data: { organizationId: targetOrganizationId, roleKeys: cmd.roleKeys },
              },
            ],
            outbox: [
              {
                eventType: 'iam.invitation.issued.v1',
                aggregateType: 'invitation',
                aggregateId: invitation.id,
                data: {
                  invitationId: invitation.id,
                  organizationId: targetOrganizationId,
                  organizationName: targetOrg.displayName,
                  email: cmd.email,
                  // Raw token must not outlive delivery: the worker strips it after send.
                  rawToken: token,
                },
              },
            ],
          };
        },
      },
      contextFromActor(actor),
      { email: input.email, roleKeys: input.roleKeys },
      { idempotencyKey: input.idempotencyKey },
    );

    this.log.info(
      { invitationId, organizationId: targetOrganizationId },
      'auth.invitation_issued',
    );
    const result: { invitationId: string; acceptUrl?: string } = { invitationId };
    if (this.config.env.NODE_ENV !== 'production') {
      result.acceptUrl = `http://localhost:3000/accept-invitation?token=${token}`;
    }
    return result;
  }

  /**
   * Resend: revoke the outstanding link and issue a fresh one to the same person with the
   * same roles. Not a second invitation — two live links to one seat is how somebody
   * ends up with a membership they were meant to lose, and an expired link is the most
   * common reason an organization sits empty (F-OPS gap 3).
   */
  async resendInvitation(
    actor: Actor,
    organizationId: string,
    invitationId: string,
    idempotencyKey?: string | undefined,
  ): Promise<{ invitationId: string; acceptUrl?: string }> {
    const existing = await this.repo.findInvitationById(invitationId, organizationId);
    if (!existing) throw new InvitationInvalid();

    await this.revokeInvitation(actor, invitationId, organizationId);
    return this.inviteMember(actor, organizationId, {
      email: existing.email,
      roleKeys: existing.proposedRoleKeys,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
  }

  async revokeInvitation(actor: Actor, invitationId: string, organizationId: string): Promise<void> {
    if (actor.organizationId === organizationId) {
      requireRole(actor, 'org_admin', 'platform_admin');
    } else if (actor.isInternal && actor.roles.includes('platform_admin')) {
      // allowed
    } else {
      throw new NotAuthorized();
    }
    const revoked = await this.repo.revokeInvitation(invitationId, organizationId);
    if (!revoked) throw new InvitationInvalid();
    await this.audit.write(null, contextFromActor(actor), {
      action: 'iam.invitation_revoked',
      subjectType: 'invitation',
      subjectId: invitationId,
      data: { organizationId },
    });
    this.log.info({ invitationId }, 'auth.invitation_revoked');
  }

  /** Public read for the accept page; reveals only organization display name, email, roles. */
  async previewInvitation(token: string): Promise<{
    organizationName: string;
    email: string;
    roleKeys: string[];
    accountExists: boolean;
  }> {
    const invitation = await this.repo.findInvitationByHash(hashToken(token));
    if (
      !invitation ||
      invitation.consumedAt !== null ||
      invitation.revokedAt !== null ||
      invitation.expiresAt.getTime() <= Date.now()
    ) {
      throw new InvitationInvalid();
    }
    const org = await this.repo.findOrganization(invitation.organizationId);
    const existing = await this.repo.findUserByEmail(invitation.email);
    return {
      organizationName: org?.displayName ?? '',
      email: invitation.email,
      roleKeys: invitation.proposedRoleKeys,
      accountExists: existing !== null,
    };
  }

  /**
   * Atomic accept (AUTH-08): create/attach account + membership + consume token in one
   * transaction; the SQL guard on consumption wins any race.
   */
  async acceptInvitation(input: {
    token: string;
    password?: string;
    displayName?: string;
    authenticatedUserId?: string;
  }): Promise<{ organizationId: string; organizationName: string }> {
    const invitation = await this.repo.findInvitationByHash(hashToken(input.token));
    if (
      !invitation ||
      invitation.consumedAt !== null ||
      invitation.revokedAt !== null ||
      invitation.expiresAt.getTime() <= Date.now()
    ) {
      throw new InvitationInvalid();
    }

    return this.db.withTransaction(async (client) => {
      const existing = await this.repo.findUserByEmail(invitation.email, client);

      let userId: string;
      if (existing) {
        if (input.authenticatedUserId !== existing.id) throw new AccountExists();
        if (existing.status !== 'active') throw new InvitationInvalid();
        userId = existing.id;
      } else {
        if (!input.password) {
          throw new ValidationFailed([{ path: 'password', message: 'Password is required' }]);
        }
        const issue = passwordPolicyIssue(input.password);
        if (issue) throw new ValidationFailed([{ path: 'password', message: issue }]);
        const user = await this.repo.createUser(
          {
            email: invitation.email,
            passwordHash: await hashPassword(input.password),
            passwordParamsVersion: PASSWORD_PARAMS_VERSION,
            displayName: input.displayName?.trim() || invitation.email.split('@')[0] || 'member',
          },
          client,
        );
        userId = user.id;
      }

      const consumed = await this.repo.consumeInvitation(invitation.id, userId, client);
      if (!consumed) throw new InvitationInvalid();

      const existingMembership = await this.repo.findActiveMembership(
        userId,
        invitation.organizationId,
        client,
      );
      if (!existingMembership) {
        await this.repo.createMembership(
          {
            userId,
            organizationId: invitation.organizationId,
            roleKeys: invitation.proposedRoleKeys,
            createdBy: invitation.invitedBy,
          },
          client,
        );
      }

      const org = await this.repo.findOrganization(invitation.organizationId, client);
      await this.audit.write(
        client,
        {
          actor: { type: 'user', id: userId, organizationId: invitation.organizationId },
          correlationId: 'invitation-accept',
        },
        {
          action: 'iam.invitation_accepted',
          subjectType: 'invitation',
          subjectId: invitation.id,
          data: { organizationId: invitation.organizationId },
        },
      );
      this.log.info(
        { invitationId: invitation.id, organizationId: invitation.organizationId },
        'auth.invitation_accepted',
      );
      return {
        organizationId: invitation.organizationId,
        organizationName: org?.displayName ?? '',
      };
    });
  }
}
