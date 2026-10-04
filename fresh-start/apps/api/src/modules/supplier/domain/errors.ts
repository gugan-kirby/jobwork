import { DomainError } from '../../../platform/http/domain-error';

/**
 * The capability taxonomy is reference data under `D-21` governance: a supplier
 * declares against codes the platform knows, never free text, so matching has
 * something stable to reason over (doc 05 §18).
 */
export class CapabilityUnknown extends DomainError {
  constructor(code: string) {
    super(
      'CAPABILITY_UNKNOWN',
      422,
      'That capability is not in the taxonomy',
      `No active capability with code ${code}.`,
    );
  }
}

/**
 * One legal entity, one supplier. Two spellings of a workshop name are two rows; one
 * GSTIN or PAN is one company, and admitting it twice would split its history, its
 * evidence and its performance across records nobody could reconcile.
 */
export class DuplicateSupplierIdentity extends DomainError {
  constructor(existingDisplayName: string, kind: string) {
    super(
      'SUPPLIER_IDENTITY_IN_USE',
      409,
      'That identity already belongs to a supplier',
      `The ${kind.toUpperCase()} given is already held by ${existingDisplayName}. Open that supplier instead of admitting a second record.`,
    );
  }
}

export class ApplicationNotFound extends DomainError {
  constructor() {
    super('APPLICATION_NOT_FOUND', 404, 'Application not found', 'No network application with that id.');
  }
}

/** A request is decided once; admitting it twice would create two suppliers from one door. */
export class ApplicationAlreadyDecided extends DomainError {
  constructor(status: string) {
    super(
      'APPLICATION_ALREADY_DECIDED',
      409,
      'That application has already been decided',
      `It is ${status}. Reload the queue.`,
    );
  }
}

export class SupplierNotFound extends DomainError {
  constructor() {
    super('SUPPLIER_NOT_FOUND', 404, 'Supplier not found', 'No supplier profile with that id.');
  }
}

/** Submission and approval read the same checklist, so they refuse for the same reason. */
export class OnboardingIncomplete extends DomainError {
  constructor(missing: readonly string[]) {
    super(
      'ONBOARDING_INCOMPLETE',
      422,
      'The supplier file is not complete yet',
      `Still outstanding: ${missing.join('; ')}.`,
    );
  }
}

export class SupplierStateRejected extends DomainError {
  constructor(from: string, action: string) {
    super(
      'SUPPLIER_STATE_INVALID',
      409,
      `A ${from} supplier cannot be ${action}`,
      `The command expected a different network state; reload the supplier and look again.`,
    );
  }
}
