import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { createLogger, type Logger } from '@jobwork/observability';
import { type Actor, requireRole } from './actor';
import {
  InvalidMfaCode,
  MembershipNotFound,
  NotAuthenticated,
  NotAuthorized,
  UserNotSuspended,
} from '../domain/errors';
import { generateRecoveryCodes, generateToken, hashToken } from '../domain/tokens';
import { generateTotpSecret, totpUri, verifyTotp } from '../domain/totp';
import {
  IamRepository,
  type MembershipSummary,
  type SessionRow,
} from '../infrastructure/iam.repository';
import { AuditWriter } from '../../../platform/commands/audit.writer';
import { contextFromActor } from '../../../platform/commands/command';
import { DatabaseService } from '../../../platform/database/database.service';

@Injectable()
export class AccountService {
  private readonly log: Logger = createLogger({ service: 'api' }).child({ module: 'iam.account' });

  constructor(
    private readonly repo: IamRepository,
    private readonly db: DatabaseService,
    private readonly auditWriter: AuditWriter,
  ) {}

  private async auditSecurity(
    actor: Actor,
    action: string,
    subjectType: string,
    subjectId: string,
    data?: Record<string, unknown>,
    opts: { reason?: string | undefined; client?: PoolClient } = {},
  ): Promise<void> {
    await this.auditWriter.write(opts.client ?? null, contextFromActor(actor), {
      action,
      subjectType,
      subjectId,
      ...(opts.reason ? { reason: opts.reason } : {}),
      ...(data !== undefined ? { data } : {}),
    });
  }

  async me(actor: Actor): Promise<{
    memberships: MembershipSummary[];
    phone: string;
  }> {
    const [memberships, user] = await Promise.all([
      this.repo.listMemberships(actor.userId),
      this.repo.findUserById(actor.userId),
    ]);
    return { memberships, phone: user?.phone ?? '' };
  }

  /** The two self-describing fields (F-MX.8). Email change is the verified flow of doc 20 §2. */
  async updateProfile(actor: Actor, input: { displayName: string; phone: string }): Promise<void> {
    await this.repo.updateProfile(actor.userId, input);
    await this.auditSecurity(actor, 'iam.profile_updated', 'user', actor.userId, {
      displayNameChanged: input.displayName !== actor.displayName,
    });
  }

  /** switch-organization (doc 20 §7): validate membership, rotate token, update context. */
  async switchOrganization(
    actor: Actor,
    organizationId: string,
  ): Promise<{ token: string; csrfToken: string }> {
    const membership = await this.repo.findActiveMembership(actor.userId, organizationId);
    if (!membership) throw new MembershipNotFound();
    const org = await this.repo.findOrganization(organizationId);
    if (!org || org.status !== 'active') throw new MembershipNotFound();

    const token = generateToken();
    await this.db.withTransaction(async (client) => {
      await this.repo.rotateSessionToken(actor.sessionId, hashToken(token), client);
      await this.repo.setSessionOrganization(actor.sessionId, organizationId, client);
    });
    await this.auditSecurity(actor, 'auth.org_context_switched', 'session', actor.sessionId, {
      organizationId,
    });
    this.log.info({ userId: actor.userId, organizationId }, 'auth.org_context_switched');
    return { token, csrfToken: generateToken() };
  }

  async listSessions(actor: Actor): Promise<Array<Omit<SessionRow, 'revokedAt'>>> {
    return this.repo.listUserSessions(actor.userId);
  }

  async revokeSession(actor: Actor, sessionId: string): Promise<void> {
    const sessions = await this.repo.listUserSessions(actor.userId);
    if (!sessions.some((s) => s.id === sessionId)) throw new NotAuthorized();
    await this.repo.revokeSession(sessionId, 'user_revoked');
    this.log.info({ userId: actor.userId, sessionId }, 'auth.session_revoked');
  }

  // ---- MFA enrollment (doc 20 §5) ----

  async startMfaEnrollment(actor: Actor): Promise<{ secret: string; otpauthUri: string }> {
    const secret = generateTotpSecret();
    await this.repo.setPendingTotpSecret(actor.userId, secret);
    return { secret, otpauthUri: totpUri(secret, actor.email) };
  }

  async activateMfa(actor: Actor, code: string): Promise<{ recoveryCodes: string[] }> {
    const user = await this.repo.findUserById(actor.userId);
    if (!user || !user.mfaTotpSecret) throw new NotAuthenticated();
    if (!verifyTotp(user.mfaTotpSecret, user.email, code)) throw new InvalidMfaCode();

    const recoveryCodes = generateRecoveryCodes();
    await this.db.withTransaction(async (client) => {
      await this.repo.activateTotp(actor.userId, client);
      await this.repo.replaceRecoveryCodes(
        actor.userId,
        recoveryCodes.map((c) => hashToken(c.toLowerCase())),
        client,
      );
      await this.repo.upgradeSessionStrength(actor.sessionId, client);
      // Other sessions predate the factor; they must re-authenticate (AUTH-14 posture).
      await this.repo.revokeUserSessions(
        actor.userId,
        'mfa_enrolled',
        { exceptSessionId: actor.sessionId },
        client,
      );
    });
    await this.auditSecurity(actor, 'auth.mfa_enrolled', 'user', actor.userId);
    this.log.info({ userId: actor.userId }, 'auth.mfa_enrolled');
    return { recoveryCodes };
  }

  // ---- suspension commands (AUTH-06, FR-104) ----

  /**
   * Suspensions and reinstatements write their audit row, with the reason, in the same
   * transaction as the change (`BR-SYS-02`, `BR-SYS-05`): nobody loses access without a
   * recorded why, and no record exists for a change that did not happen.
   */
  async suspendMembership(actor: Actor, membershipId: string, reason: string): Promise<void> {
    const membership = await this.repo.findMembershipById(membershipId);
    if (!membership || membership.status !== 'active') throw new MembershipNotFound();

    const authorized =
      (actor.isInternal &&
        (actor.roles.includes('platform_admin') || actor.roles.includes('security_admin'))) ||
      (actor.organizationId === membership.organizationId && actor.roles.includes('org_admin'));
    if (!authorized) throw new NotAuthorized();
    if (membership.userId === actor.userId) {
      throw new NotAuthorized('Cannot suspend your own membership');
    }

    await this.db.withTransaction(async (client) => {
      const suspended = await this.repo.suspendMembership(membershipId, client);
      if (!suspended) throw new MembershipNotFound();
      await this.repo.revokeUserSessions(
        suspended.userId,
        'membership_suspended',
        { organizationId: suspended.organizationId },
        client,
      );
      await this.auditSecurity(actor, 'iam.membership_suspended', 'membership', membershipId, { organizationId: membership.organizationId }, { reason, client });
    });
    this.log.warn({ membershipId, by: actor.userId }, 'auth.membership_suspended');
  }

  /**
   * The mirror of a suspension. Every administrative action that costs somebody their
   * access needs one: an admin who cannot undo a mistake stops using the command, and an
   * organization then runs on people nobody dares to suspend.
   *
   * Reinstatement does not resurrect the sessions the suspension revoked — the person
   * signs in again, which is also how they learn they are back.
   */
  async reinstateMembership(actor: Actor, membershipId: string, reason?: string): Promise<void> {
    const membership = await this.repo.findMembershipById(membershipId);
    if (!membership) throw new MembershipNotFound();

    const authorized =
      (actor.isInternal &&
        (actor.roles.includes('platform_admin') || actor.roles.includes('security_admin'))) ||
      (actor.organizationId === membership.organizationId && actor.roles.includes('org_admin'));
    if (!authorized) throw new NotAuthorized();

    await this.db.withTransaction(async (client) => {
      const reinstated = await this.repo.reinstateMembership(membershipId, client);
      if (!reinstated) throw new MembershipNotFound();
      await this.auditSecurity(actor, 'iam.membership_reinstated', 'membership', membershipId, { organizationId: membership.organizationId }, { reason, client });
    });
    this.log.info({ membershipId, by: actor.userId }, 'auth.membership_reinstated');
  }

  async reinstateUser(actor: Actor, userId: string, reason?: string): Promise<void> {
    if (!actor.isInternal) throw new NotAuthorized();
    requireRole(actor, 'platform_admin', 'security_admin');
    await this.db.withTransaction(async (client) => {
      const reinstated = await this.repo.reinstateUser(userId, client);
      if (!reinstated) throw new UserNotSuspended();
      await this.auditSecurity(actor, 'iam.user_reinstated', 'user', userId, undefined, { reason, client });
    });
    this.log.info({ userId, by: actor.userId }, 'auth.user_reinstated');
  }

  async suspendUser(actor: Actor, userId: string, reason: string): Promise<void> {
    if (!actor.isInternal) throw new NotAuthorized();
    requireRole(actor, 'platform_admin', 'security_admin');
    if (userId === actor.userId) throw new NotAuthorized('Cannot suspend yourself');

    await this.db.withTransaction(async (client) => {
      await this.repo.suspendUser(userId, client);
      await this.repo.revokeUserSessions(userId, 'user_suspended', {}, client);
      await this.auditSecurity(actor, 'iam.user_suspended', 'user', userId, undefined, { reason, client });
    });
    this.log.warn({ userId, by: actor.userId }, 'auth.user_suspended');
  }
}
