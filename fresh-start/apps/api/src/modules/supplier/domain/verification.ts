import { DomainError } from '../../../platform/http/domain-error';

/**
 * The doc 06 §14 verification lifecycle, stated once here and enforced again by a
 * database trigger. Verification is not a boolean: each item carries its own status,
 * evidence, expiry and reviewer, and organization eligibility is computed over items
 * rather than stored as a flag that could drift away from them.
 *
 *   draft -> submitted -> under_review -> verified
 *                     \-> returned_for_evidence -> submitted
 *   verified -> expiring -> expired
 *   verified -> revoked
 */

export const VERIFICATION_KINDS = [
  'gst',
  'udyam',
  'pan',
  'bank_account',
  'address_proof',
  'quality_system',
  'certification',
] as const;

export type VerificationKind = (typeof VERIFICATION_KINDS)[number];

export type VerificationStatus =
  | 'draft'
  | 'submitted'
  | 'under_review'
  | 'verified'
  | 'returned_for_evidence'
  | 'expiring'
  | 'expired'
  | 'revoked';

/**
 * The items an organization must hold, live, to be matched at all (`FR-202`).
 * Everything else is a soft signal; these are the hard filter.
 */
export const MANDATORY_KINDS: readonly VerificationKind[] = ['gst', 'pan', 'bank_account'];

const TRANSITIONS: Record<VerificationStatus, readonly VerificationStatus[]> = {
  draft: ['submitted'],
  submitted: ['under_review', 'returned_for_evidence'],
  under_review: ['verified', 'returned_for_evidence'],
  returned_for_evidence: ['submitted'],
  verified: ['expiring', 'expired', 'revoked'],
  expiring: ['expired', 'revoked', 'verified'],
  expired: ['revoked'],
  revoked: [],
};

export function canTransition(from: VerificationStatus, to: VerificationStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export class VerificationTransitionRejected extends DomainError {
  constructor(from: VerificationStatus, to: VerificationStatus) {
    super(
      'VERIFICATION_TRANSITION_REJECTED',
      409,
      'That is not a step this verification can take',
      `Recorded ${from}; refused ${to}.`,
    );
  }
}

export function assertTransition(from: VerificationStatus, to: VerificationStatus): void {
  if (!canTransition(from, to)) throw new VerificationTransitionRejected(from, to);
}

export class SelfReviewRejected extends DomainError {
  constructor() {
    super(
      'SELF_REVIEW_REJECTED',
      403,
      'Evidence cannot be reviewed by the person who submitted it',
      'A second reviewer must decide this item (doc 03 §5).',
    );
  }
}

export class EvidenceNotUsable extends DomainError {
  constructor(detail: string) {
    super('EVIDENCE_NOT_USABLE', 409, 'That evidence cannot be used', detail);
  }
}

export class VerificationItemNotFound extends DomainError {
  constructor() {
    super('VERIFICATION_ITEM_NOT_FOUND', 404, 'Verification item not found');
  }
}

export class SupplierProfileNotFound extends DomainError {
  constructor() {
    super('SUPPLIER_PROFILE_NOT_FOUND', 404, 'Supplier profile not found');
  }
}

/** Why a supplier is not eligible, as codes operations can filter and explain (doc 07 §2.1). */
export const EXCLUSION_CODES = {
  profileNotActive: 'profile_not_active',
  supplierUnavailable: 'supplier_unavailable',
  organizationSuspended: 'organization_suspended',
  missingMandatoryVerification: 'missing_mandatory_verification',
  verificationExpired: 'verification_expired',
  verificationRevoked: 'verification_revoked',
  noPublishedCapability: 'no_published_capability',
  certificationExpired: 'certification_expired',
} as const;

export type ExclusionCode = (typeof EXCLUSION_CODES)[keyof typeof EXCLUSION_CODES];

export interface VerificationSnapshot {
  kind: VerificationKind;
  status: VerificationStatus;
  expiresAt: Date | null;
}

/**
 * The hard-filter verdict for one organization, computed the same way every time from
 * the same inputs — the determinism the increment exit asks for. Expiry excludes from
 * *new* matching without rewriting anything that already happened (doc 06 §14).
 */
export function computeExclusions(input: {
  profileStatus: string;
  organizationStatus: string;
  publishedCapabilityCount: number;
  items: readonly VerificationSnapshot[];
  now: Date;
  /** The supplier's own availability. Absent means available — an older caller that
   *  does not know about F-SN must not accidentally exclude everybody. */
  acceptingWork?: boolean | undefined;
}): ExclusionCode[] {
  const codes: ExclusionCode[] = [];
  if (input.organizationStatus !== 'active') codes.push(EXCLUSION_CODES.organizationSuspended);
  if (input.profileStatus !== 'active') codes.push(EXCLUSION_CODES.profileNotActive);
  // Said by the supplier, not about it: a shop that is full is not a shop in trouble.
  if (input.acceptingWork === false) codes.push(EXCLUSION_CODES.supplierUnavailable);
  if (input.publishedCapabilityCount === 0) codes.push(EXCLUSION_CODES.noPublishedCapability);

  for (const kind of MANDATORY_KINDS) {
    const forKind = input.items.filter((item) => item.kind === kind);
    // `expiring` still counts: it warns that a renewal is due, it does not withdraw
    // the evidence before its date (doc 06 §14).
    const live = forKind.find(
      (item) =>
        (item.status === 'verified' || item.status === 'expiring') &&
        (item.expiresAt === null || item.expiresAt.getTime() > input.now.getTime()),
    );
    if (live) continue;

    // Say *why* it is missing: revoked, expired, and never-submitted are different
    // conversations with the supplier.
    if (forKind.some((item) => item.status === 'revoked')) {
      codes.push(EXCLUSION_CODES.verificationRevoked);
    } else if (
      forKind.some(
        (item) =>
          item.status === 'expired' ||
          ((item.status === 'verified' || item.status === 'expiring') &&
            item.expiresAt !== null &&
            item.expiresAt.getTime() <= input.now.getTime()),
      )
    ) {
      codes.push(EXCLUSION_CODES.verificationExpired);
    } else {
      codes.push(EXCLUSION_CODES.missingMandatoryVerification);
    }
  }

  return [...new Set(codes)];
}
