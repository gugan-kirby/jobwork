export type Audience = 'internal' | 'external';

export interface SessionLifetimes {
  idleMs: number;
  absoluteMs: number;
}

const HOUR = 60 * 60 * 1000;

/** Doc 20 §6 lifetimes; values become configuration when the config module lands (FR-1006). */
export function sessionLifetimes(audience: Audience): SessionLifetimes {
  return audience === 'internal'
    ? { idleMs: 2 * HOUR, absoluteMs: 24 * HOUR }
    : { idleMs: 12 * HOUR, absoluteMs: 7 * 24 * HOUR };
}

export const LOCKOUT_THRESHOLD = 5;
export const LOCKOUT_MS = 15 * 60 * 1000;

export const INVITATION_TTL_DAYS = 7;

/** How fresh the strong factor must be for step-up-protected operations (doc 20 §5). */
export const STEP_UP_MAX_AGE_MS = 15 * 60 * 1000;

/** last_seen writes are throttled to avoid a write per request. */
export const LAST_SEEN_WRITE_INTERVAL_MS = 60 * 1000;
