import { Injectable } from '@nestjs/common';
import { createLogger, type Logger } from '@jobwork/observability';
import type { Actor } from './actor';
import {
  AccountLocked,
  InvalidCredentials,
  InvalidMfaCode,
  NotAuthenticated,
} from '../domain/errors';
import {
  burnVerification,
  PASSWORD_PARAMS_VERSION,
  hashPassword,
  verifyPassword,
} from '../domain/password';
import { LOCKOUT_MS, LOCKOUT_THRESHOLD, sessionLifetimes } from '../domain/session-policy';
import { generateToken, hashToken } from '../domain/tokens';
import { verifyTotp } from '../domain/totp';
import { IamRepository, type UserRow } from '../infrastructure/iam.repository';
import { MetricsService } from '../../../platform/metrics/metrics.service';

export interface IssuedSession {
  token: string;
  csrfToken: string;
  mfaRequired: boolean;
  organizationId: string | null;
}

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

@Injectable()
export class AuthService {
  private readonly log: Logger = createLogger({ service: 'api' }).child({ module: 'iam.auth' });

  constructor(
    private readonly repo: IamRepository,
    private readonly metrics: MetricsService,
  ) {}

  async login(email: string, password: string, meta: RequestMeta): Promise<IssuedSession> {
    const user = await this.repo.findUserByEmail(email);

    if (!user || !user.passwordHash || user.status !== 'active') {
      await burnVerification(); // uniform timing for unknown/inactive accounts (AUTH-11)
      this.log.info({ outcome: 'failed' }, 'auth.login_failed');
      this.metrics.authEvents.inc({ event: 'login_failed' });
      throw new InvalidCredentials();
    }
    if (user.lockoutUntil && user.lockoutUntil.getTime() > Date.now()) {
      this.log.info({ userId: user.id, outcome: 'locked' }, 'auth.login_failed');
      this.metrics.authEvents.inc({ event: 'login_failed' });
      throw new AccountLocked();
    }

    const ok = await verifyPassword(user.passwordHash, password);
    if (!ok) {
      const failures = user.failedLoginCount + 1;
      const lockoutUntil =
        failures >= LOCKOUT_THRESHOLD ? new Date(Date.now() + LOCKOUT_MS) : null;
      await this.repo.recordLoginFailure(user.id, lockoutUntil);
      if (lockoutUntil) {
        this.log.warn({ userId: user.id, outcome: 'lockout' }, 'auth.lockout_applied');
        this.metrics.authEvents.inc({ event: 'lockout' });
      } else {
        this.log.info({ userId: user.id, outcome: 'failed' }, 'auth.login_failed');
        this.metrics.authEvents.inc({ event: 'login_failed' });
      }
      throw new InvalidCredentials();
    }

    await this.repo.recordLoginSuccess(user.id);
    this.metrics.authEvents.inc({ event: 'login_succeeded' });
    const session = await this.issueSession(user, meta);
    this.log.info(
      { userId: user.id, outcome: 'success', mfaRequired: session.mfaRequired },
      'auth.login_succeeded',
    );
    return session;
  }

  private async issueSession(user: UserRow, meta: RequestMeta): Promise<IssuedSession> {
    const isInternal = await this.repo.hasInternalMembership(user.id);
    const mfaEnrolled = user.mfaEnrolledAt !== null;
    const mfaRequired = mfaEnrolled; // enrolled users always challenge; unenrolled internal users are gated by AUTH-15
    const lifetimes = sessionLifetimes(isInternal ? 'internal' : 'external');

    const memberships = await this.repo.listMemberships(user.id);
    const activeMemberships = memberships.filter(
      (m) => m.status === 'active' && m.organizationStatus === 'active',
    );
    const organizationId =
      activeMemberships.length === 1 ? (activeMemberships[0]?.organizationId ?? null) : null;

    const token = generateToken();
    const now = Date.now();
    await this.repo.createSession({
      tokenHash: hashToken(token),
      userId: user.id,
      organizationId,
      authStrength: 'password',
      mfaPending: mfaRequired,
      idleExpiresAt: new Date(now + (mfaRequired ? 10 * 60 * 1000 : lifetimes.idleMs)),
      absoluteExpiresAt: new Date(now + lifetimes.absoluteMs),
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return { token, csrfToken: generateToken(), mfaRequired, organizationId };
  }

  /** Completes the login MFA challenge: verifies factor, rotates token, upgrades strength. */
  async verifyMfaChallenge(
    actor: Actor,
    input: { code?: string | undefined; recoveryCode?: string | undefined },
  ): Promise<IssuedSession> {
    const user = await this.repo.findUserById(actor.userId);
    if (!user || user.status !== 'active') throw new NotAuthenticated();

    let verified = false;
    if (input.code && user.mfaTotpSecret && user.mfaEnrolledAt) {
      verified = verifyTotp(user.mfaTotpSecret, user.email, input.code);
    } else if (input.recoveryCode) {
      verified = await this.repo.consumeRecoveryCode(
        user.id,
        hashToken(input.recoveryCode.trim().toLowerCase()),
      );
      if (verified) this.log.warn({ userId: user.id }, 'auth.recovery_code_used');
    }
    if (!verified) {
      this.log.info({ userId: user.id, outcome: 'failed' }, 'auth.step_up_failed');
      this.metrics.authEvents.inc({ event: 'mfa_failed' });
      throw new InvalidMfaCode();
    }

    const isInternal = await this.repo.hasInternalMembership(user.id);
    const lifetimes = sessionLifetimes(isInternal ? 'internal' : 'external');
    const token = generateToken();
    await this.repo.rotateSessionToken(actor.sessionId, hashToken(token));
    await this.repo.upgradeSessionStrength(actor.sessionId);
    await this.repo.touchSession(actor.sessionId, new Date(Date.now() + lifetimes.idleMs));
    this.log.info({ userId: user.id, outcome: 'passed' }, 'auth.step_up_passed');
    return {
      token,
      csrfToken: generateToken(),
      mfaRequired: false,
      organizationId: actor.organizationId,
    };
  }

  async logout(actor: Actor): Promise<void> {
    await this.repo.revokeSession(actor.sessionId, 'logout');
    this.log.info({ userId: actor.userId }, 'auth.session_revoked');
  }

  async logoutAll(actor: Actor): Promise<number> {
    const count = await this.repo.revokeUserSessions(actor.userId, 'logout_all');
    this.log.info({ userId: actor.userId, count }, 'auth.sessions_revoked_all');
    return count;
  }

  /** Used by seeds/tests; password change flows arrive with the account surface. */
  async setPassword(userId: string, password: string): Promise<void> {
    const hash = await hashPassword(password);
    await this.repo.updatePassword(userId, hash, PASSWORD_PARAMS_VERSION);
  }
}
