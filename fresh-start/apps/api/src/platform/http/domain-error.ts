/**
 * Base class for business failures with stable machine codes (ES-12, doc 08 §3).
 * The HTTP status is a transport concern carried alongside, never the identity of the error.
 */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly title: string,
    readonly detail?: string,
    readonly errors?: Array<{ path: string; message: string }>,
  ) {
    super(detail ?? title);
    this.name = 'DomainError';
  }
}

export class ValidationFailed extends DomainError {
  constructor(errors: Array<{ path: string; message: string }>) {
    super('VALIDATION_FAILED', 400, 'Request validation failed', undefined, errors);
  }
}

/** Optimistic concurrency guard shared by every versioned aggregate (doc 02 §8). */
export class VersionConflict extends DomainError {
  constructor() {
    super('VERSION_CONFLICT', 409, 'The record changed since you loaded it', 'Refresh and retry.');
  }
}

/**
 * A budget is spent (doc 08 §14). Raised before the handler runs, so a command's guidance
 * can promise what matters to a person retrying a payment or an approval: nothing changed.
 */
export class RateLimited extends DomainError {
  constructor(
    readonly retryAfterSeconds: number,
    kind: 'sign_in' | 'read' | 'command' = 'command',
  ) {
    const wait = waitInWords(retryAfterSeconds);
    const detail =
      kind === 'sign_in'
        ? `Too many sign-in attempts. Try again in ${wait}.`
        : kind === 'read'
          ? `Too many requests in a short time. Try again in ${wait}.`
          : `Nothing was changed by this request. Try again in ${wait}.`;
    super('RATE_LIMITED', 429, 'Too many requests', detail);
  }
}

/** "40 seconds", "9 minutes" — people do not count in hundreds of seconds. */
function waitInWords(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}
