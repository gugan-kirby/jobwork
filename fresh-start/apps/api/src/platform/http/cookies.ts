import type { FastifyReply } from 'fastify';
import type { ConfigService } from '../config/config.service';
import { CSRF_COOKIE } from '../../modules/iam/presentation/csrf.guard';

/** Session cookie per doc 20 §6; the double-submit CSRF cookie is intentionally readable. */
export function setSessionCookies(
  reply: FastifyReply,
  config: ConfigService,
  sessionToken: string,
  csrfToken: string,
): void {
  const secure = config.env.NODE_ENV === 'production';
  reply.setCookie(config.env.SESSION_COOKIE_NAME, sessionToken, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
  });
  reply.setCookie(CSRF_COOKIE, csrfToken, {
    httpOnly: false,
    secure,
    sameSite: 'lax',
    path: '/',
  });
}

export function clearSessionCookies(reply: FastifyReply, config: ConfigService): void {
  reply.clearCookie(config.env.SESSION_COOKIE_NAME, { path: '/' });
  reply.clearCookie(CSRF_COOKIE, { path: '/' });
}
