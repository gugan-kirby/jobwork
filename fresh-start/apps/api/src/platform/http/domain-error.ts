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
 * A budget is spent (doc 08 §14). Raised before the handler runs, so the guidance can
 * promise what matters to a person retrying a payment or an approval: nothing changed.
 */
export class RateLimited extends DomainError {
  constructor(readonly retryAfterSeconds: number) {
    super(
      'RATE_LIMITED',
      429,
      'Too many requests',
      `Nothing was changed by this request. Try again in ${retryAfterSeconds} second${retryAfterSeconds === 1 ? '' : 's'}.`,
    );
  }
}
