import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { ConfigService } from '../config/config.service';
import { DomainError } from './domain-error';
import {
  SERVICE_TOKEN_HEADER,
  verifyServiceToken,
  type ServicePrincipal,
} from '@jobwork/service-auth';

export const SERVICE_ONLY_KEY = 'jobwork:serviceOnly';

/**
 * Marks a route as invokable only by the named service principals — never by a user
 * session, however privileged (doc 20 §9; doc 13 §7 "invoke internal command from
 * external role").
 */
export const ServiceOnly = (...principals: string[]) =>
  SetMetadata(SERVICE_ONLY_KEY, principals);

export class ServiceAuthenticationFailed extends DomainError {
  constructor() {
    super('SERVICE_AUTH_FAILED', 401, 'Service credential required');
  }
}

export interface ServiceActorRequest extends FastifyRequest {
  servicePrincipal?: ServicePrincipal;
}

@Injectable()
export class ServicePrincipalGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly config: ConfigService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const allowed = this.reflector.getAllAndOverride<string[]>(SERVICE_ONLY_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!allowed) return true;

    const request = context.switchToHttp().getRequest<ServiceActorRequest>();
    const header = request.headers[SERVICE_TOKEN_HEADER];
    if (typeof header !== 'string') throw new ServiceAuthenticationFailed();

    const principal = verifyServiceToken(this.config.env.SERVICE_TOKEN_SECRET, header);
    if (!principal || !allowed.includes(principal.name)) throw new ServiceAuthenticationFailed();

    request.servicePrincipal = principal;
    return true;
  }
}
