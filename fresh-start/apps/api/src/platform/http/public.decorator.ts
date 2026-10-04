import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'jobwork:isPublic';

/** Marks a route as reachable without a session (login, invitation accept, health). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const ALLOW_MFA_PENDING_KEY = 'jobwork:allowMfaPending';

/** Routes an mfa-pending session may reach (the challenge itself, logout). */
export const AllowMfaPending = () => SetMetadata(ALLOW_MFA_PENDING_KEY, true);
