import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { CsrfRejected } from '../domain/errors';
import { ConfigService } from '../../../platform/config/config.service';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export const CSRF_COOKIE = 'jw_csrf';
export const CSRF_HEADER = 'x-csrf-token';

/**
 * State-changing requests need Origin agreement plus double-submit token (doc 20 §6).
 * Public mutations (login, invitation accept) are Origin-checked only — the token
 * cookie does not exist before a session does.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  private readonly allowedOrigins: Set<string>;

  constructor(config: ConfigService) {
    const configured = process.env['ALLOWED_ORIGINS'];
    const defaults = [
      'http://localhost:3000',
      'http://localhost:3001',
      'http://localhost:3002',
      `http://localhost:${config.env.API_PORT}`,
    ];
    this.allowedOrigins = new Set(
      (configured ? configured.split(',') : defaults).map((o) => o.trim()).filter(Boolean),
    );
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    if (SAFE_METHODS.has(request.method)) return true;

    const origin = request.headers.origin;
    if (typeof origin === 'string' && origin !== 'null' && !this.allowedOrigins.has(origin)) {
      throw new CsrfRejected();
    }

    const cookieToken = (request.cookies ?? {})[CSRF_COOKIE];
    if (!cookieToken) return true; // pre-session public mutation: origin check only
    const headerToken = request.headers[CSRF_HEADER];
    if (typeof headerToken !== 'string') throw new CsrfRejected();
    const a = Buffer.from(cookieToken);
    const b = Buffer.from(headerToken);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new CsrfRejected();
    return true;
  }
}
