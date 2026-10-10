import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import type { Actor } from '../application/actor';
import { MfaChallengeRequired, NotAuthenticated } from '../domain/errors';
import {
  LAST_SEEN_WRITE_INTERVAL_MS,
  sessionLifetimes,
} from '../domain/session-policy';
import { hashToken } from '../domain/tokens';
import { IamRepository } from '../infrastructure/iam.repository';
import { ConfigService } from '../../../platform/config/config.service';
import {
  ALLOW_MFA_PENDING_KEY,
  INTERNAL_ONLY_KEY,
  IS_PUBLIC_KEY,
} from '../../../platform/http/public.decorator';
import { DomainError } from '../../../platform/http/domain-error';
import { SERVICE_ONLY_KEY } from '../../../platform/http/service-principal.guard';

/**
 * Global authentication guard (AUTH-04/16): resolves the session cookie to an Actor,
 * enforcing revocation, expiry, user status, and mfa-pending route restrictions.
 * Object-level authorization stays with each command (BR-AUTH-01).
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly repo: IamRepository,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    // Internal service routes carry no user session at all (doc 20 §9); the
    // service-principal guard is the only thing that may admit them.
    const serviceOnly = this.reflector.getAllAndOverride<string[]>(SERVICE_ONLY_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (serviceOnly) return true;

    const request = context.switchToHttp().getRequest<FastifyRequest & { actor?: Actor }>();
    const token = (request.cookies ?? {})[this.config.env.SESSION_COOKIE_NAME];
    if (!token) throw new NotAuthenticated();

    const ctx = await this.repo.findSessionContextByHash(hashToken(token));
    if (!ctx) throw new NotAuthenticated();

    const now = Date.now();
    const { session, user } = ctx;
    if (
      session.revokedAt !== null ||
      session.absoluteExpiresAt.getTime() <= now ||
      session.idleExpiresAt.getTime() <= now
    ) {
      throw new NotAuthenticated();
    }
    if (user.status !== 'active') throw new NotAuthenticated();

    if (session.mfaPending) {
      const allowed = this.reflector.getAllAndOverride<boolean>(ALLOW_MFA_PENDING_KEY, [
        context.getHandler(),
        context.getClass(),
      ]);
      if (!allowed) throw new MfaChallengeRequired();
    }

    const isInternal = await this.repo.hasInternalMembership(session.userId);
    const internalOnly = this.reflector.getAllAndOverride<boolean>(INTERNAL_ONLY_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (internalOnly && !isInternal) throw new DomainError('NOT_AUTHORIZED', 403, 'Not permitted', 'JobWork staff only.');

    // Sliding idle expiry, write-throttled.
    if (now - session.lastSeenAt.getTime() > LAST_SEEN_WRITE_INTERVAL_MS && !session.mfaPending) {
      const lifetimes = sessionLifetimes(isInternal ? 'internal' : 'external');
      const idleExpires = new Date(
        Math.min(now + lifetimes.idleMs, session.absoluteExpiresAt.getTime()),
      );
      await this.repo.touchSession(session.id, idleExpires);
    }

    const orgValid =
      ctx.organization !== null &&
      ctx.organization.status === 'active' &&
      ctx.membershipStatus === 'active';

    request.actor = {
      userId: user.id,
      sessionId: session.id,
      email: user.email,
      displayName: user.displayName,
      authStrength: session.authStrength,
      mfaPending: session.mfaPending,
      mfaEnrolled: user.mfaEnrolled,
      isInternal,
      organizationId: orgValid && ctx.organization ? ctx.organization.id : null,
      organizationType:
        orgValid && ctx.organization
          ? (ctx.organization.type as Actor['organizationType'])
          : null,
      roles: orgValid ? ctx.roles : [],
    };
    return true;
  }
}
