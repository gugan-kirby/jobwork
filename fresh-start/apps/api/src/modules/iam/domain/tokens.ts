import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Opaque bearer secrets: 256-bit random, base64url on the wire, only SHA-256 at rest (AUTH-08/16). */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function tokenMatches(candidate: string, storedHash: string): boolean {
  const candidateHash = Buffer.from(hashToken(candidate), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  return candidateHash.length === stored.length && timingSafeEqual(candidateHash, stored);
}

export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const raw = randomBytes(5).toString('hex');
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}
