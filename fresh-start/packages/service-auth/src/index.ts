import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Short-lived platform credentials for internal service-to-service calls (doc 20 §9:
 * never shared user accounts, never long-lived API keys). A token is an HMAC over the
 * principal name and an expiry seconds away, minted from a secret that lives only in
 * the secret store. The deployment slot for cloud workload identity replaces the mint
 * side without changing the guard's contract.
 */

export interface ServicePrincipal {
  /** Stable name used in audit; `id` gives audit and idempotency a scope key. */
  name: string;
  id: string;
}

/** The named principal the scan worker runs as (doc 20 §9, least privilege). */
export const SCAN_WORKER_PRINCIPAL: ServicePrincipal = {
  name: 'scan-worker',
  id: '00000000-0000-4000-8000-000000000001',
};

export const SERVICE_PRINCIPALS: readonly ServicePrincipal[] = [SCAN_WORKER_PRINCIPAL];

export const SERVICE_TOKEN_HEADER = 'x-service-token';
const TOKEN_VERSION = 'v1';
const MAX_TTL_SECONDS = 300;

function sign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function mintServiceToken(
  secret: string,
  principalName: string,
  ttlSeconds = 60,
): string {
  const expiresAt = Math.floor(Date.now() / 1000) + Math.min(ttlSeconds, MAX_TTL_SECONDS);
  const nonce = randomBytes(9).toString('base64url');
  const payload = `${TOKEN_VERSION}.${principalName}.${expiresAt}.${nonce}`;
  return `${payload}.${sign(secret, payload)}`;
}

/** Returns the principal, or null for anything malformed, expired, or unknown. */
export function verifyServiceToken(secret: string, token: string): ServicePrincipal | null {
  const parts = token.split('.');
  if (parts.length !== 5) return null;
  const [version, principalName, expiresAt, nonce, signature] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (version !== TOKEN_VERSION) return null;

  const expected = Buffer.from(sign(secret, `${version}.${principalName}.${expiresAt}.${nonce}`));
  const provided = Buffer.from(signature);
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return null;

  const expiry = Number(expiresAt);
  if (!Number.isFinite(expiry) || expiry * 1000 <= Date.now()) return null;

  return SERVICE_PRINCIPALS.find((p) => p.name === principalName) ?? null;
}
