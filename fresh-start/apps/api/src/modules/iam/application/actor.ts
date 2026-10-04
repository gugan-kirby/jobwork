import { MembershipNotFound, MfaEnrollmentRequired, NotAuthorized } from '../domain/errors';

export interface Actor {
  userId: string;
  sessionId: string;
  email: string;
  displayName: string;
  authStrength: 'password' | 'password+totp';
  mfaPending: boolean;
  mfaEnrolled: boolean;
  isInternal: boolean;
  organizationId: string | null;
  organizationType: 'customer' | 'supplier' | 'internal' | null;
  roles: string[];
}

export function requireOrganization(actor: Actor): string {
  if (!actor.organizationId) throw new MembershipNotFound();
  return actor.organizationId;
}

export function requireRole(actor: Actor, ...anyOf: string[]): void {
  if (!anyOf.some((role) => actor.roles.includes(role))) {
    throw new NotAuthorized(`Requires one of: ${anyOf.join(', ')}`);
  }
}

/**
 * AUTH-15: internal users cannot perform transactional commands before MFA enrollment.
 * Enrolled internal users always carry password+totp strength after the login challenge.
 */
export function requireTransactionalStrength(actor: Actor): void {
  if (actor.isInternal && !actor.mfaEnrolled) {
    throw new MfaEnrollmentRequired();
  }
}
