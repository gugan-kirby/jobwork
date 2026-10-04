import { DomainError } from '../../../platform/http/domain-error';

export { VersionConflict } from '../../../platform/http/domain-error';

/** Uniform for unknown email and wrong password alike (AUTH-11 — no enumeration). */
export class InvalidCredentials extends DomainError {
  constructor() {
    super('INVALID_CREDENTIALS', 401, 'Invalid email or password');
  }
}

export class AccountLocked extends DomainError {
  constructor() {
    super('ACCOUNT_LOCKED', 423, 'Too many failed attempts', 'Try again later.');
  }
}

export class NotAuthenticated extends DomainError {
  constructor() {
    super('NOT_AUTHENTICATED', 401, 'Authentication required');
  }
}

export class NotAuthorized extends DomainError {
  constructor(detail?: string) {
    super('NOT_AUTHORIZED', 403, 'Not authorized', detail);
  }
}

export class MfaChallengeRequired extends DomainError {
  constructor() {
    super('MFA_CHALLENGE_REQUIRED', 401, 'Second factor required');
  }
}

export class MfaEnrollmentRequired extends DomainError {
  constructor() {
    super(
      'MFA_ENROLLMENT_REQUIRED',
      403,
      'Multi-factor enrollment required',
      'Enroll a second factor before performing this action.',
    );
  }
}

export class InvalidMfaCode extends DomainError {
  constructor() {
    super('INVALID_MFA_CODE', 401, 'Invalid verification code');
  }
}

export class InvitationInvalid extends DomainError {
  constructor() {
    super('INVITATION_INVALID', 410, 'Invitation is not valid', 'It may be used, expired, or revoked.');
  }
}

export class AccountExists extends DomainError {
  constructor() {
    super('ACCOUNT_EXISTS', 409, 'Account already exists', 'Sign in, then accept the invitation.');
  }
}

/**
 * Registration says so plainly: the person typing their own email deserves to know it is
 * taken, and the sign-in path exists for exactly that case. The response is produced
 * after the same password-hashing cost as a successful registration (AUTH-11 timing).
 */
export class EmailAlreadyRegistered extends DomainError {
  constructor() {
    super(
      'EMAIL_ALREADY_REGISTERED',
      409,
      'That email already has an account',
      'Sign in instead, or use the password reset if you have forgotten it.',
    );
  }
}

export class VerificationInvalid extends DomainError {
  constructor() {
    super(
      'VERIFICATION_INVALID',
      410,
      'That verification link is not valid',
      'It may have been used already or expired. Register again to get a fresh link.',
    );
  }
}

export class MembershipNotFound extends DomainError {
  constructor() {
    super('MEMBERSHIP_NOT_FOUND', 403, 'No active membership for that organization');
  }
}

export class CsrfRejected extends DomainError {
  constructor() {
    super('CSRF_REJECTED', 403, 'Request origin could not be verified');
  }
}

/** Reinstating an account that was never suspended is a mistaken click, not a no-op. */
export class UserNotSuspended extends DomainError {
  constructor() {
    super(
      'USER_NOT_SUSPENDED',
      409,
      'That account is not suspended',
      'Nothing to reinstate — the account is already active, or it no longer exists.',
    );
  }
}

export class OrganizationNotFound extends DomainError {
  constructor() {
    super('ORGANIZATION_NOT_FOUND', 404, 'Organization not found', 'No organization with that id.');
  }
}
