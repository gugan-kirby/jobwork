import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'jobwork:isPublic';

/** Marks a route as reachable without a session (login, invitation accept, health). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const ALLOW_MFA_PENDING_KEY = 'jobwork:allowMfaPending';

/** Routes an mfa-pending session may reach (the challenge itself, logout). */
export const AllowMfaPending = () => SetMetadata(ALLOW_MFA_PENDING_KEY, true);

export const INTERNAL_ONLY_KEY = 'jobwork:internalOnly';

/**
 * Marks a route as JobWork staff's own: the session guard refuses any session without an internal
 * membership before the handler runs (deny by default; doc 03 §3). A route that serves suppliers or
 * customers lives on its own audience path (`supplier/…`, `customer/…`, `support/…`) instead of
 * sharing an internal one. Role and object checks stay with each command.
 */
export const InternalOnly = () => SetMetadata(INTERNAL_ONLY_KEY, true);
