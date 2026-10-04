import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { ServicePrincipal } from '@jobwork/service-auth';
import { DomainError } from './domain-error';

/**
 * Extracts the actor the session guard attached. Typed as the caller's actor shape;
 * platform stays ignorant of the iam module's concrete type (ES-03 direction).
 *
 * A `@ServiceOnly` route carries no session: the service-principal guard verified a
 * token and attached the principal instead. It is surfaced here as an internal actor
 * whose id is the principal's stable uuid, so audit, idempotency scoping and
 * `requireTransactionalStrength` all see a real, named party (doc 20 §9) — and a
 * command never has to know whether a person or the worker asked.
 */
export const CurrentActor = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): unknown => {
    const request = ctx
      .switchToHttp()
      .getRequest<FastifyRequest & { actor?: unknown; servicePrincipal?: ServicePrincipal }>();
    if (request.actor) return request.actor;
    if (request.servicePrincipal) {
      const principal = request.servicePrincipal;
      return {
        userId: principal.id,
        sessionId: `service:${principal.name}`,
        email: `${principal.name}@service.jobwork.internal`,
        displayName: principal.name,
        authStrength: 'password+totp',
        mfaPending: false,
        mfaEnrolled: true,
        isInternal: true,
        organizationId: null,
        organizationType: 'internal',
        roles: [`service:${principal.name}`],
      };
    }
    throw new DomainError('NOT_AUTHENTICATED', 401, 'Authentication required');
  },
);
