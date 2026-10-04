import type { Actor } from '../../iam';
import { NotAuthorized } from '../../iam/domain/errors';

/**
 * Who may maintain a supplier's own record, and who may sit in judgement on it.
 *
 * The two lists never overlap: a supplier organization can describe itself but cannot
 * verify itself, and JobWork can verify but is not the author of the claim. Reviewer
 * separation inside JobWork (submitter ≠ reviewer) is enforced per item in the review
 * command and again by a database constraint.
 */

/** Supplier-side roles that may publish profile, capability, machine and evidence. */
export const SUPPLIER_MAINTAINER_ROLES = [
  'org_admin',
  'supplier_estimator',
  'supplier_production',
  'supplier_quality',
] as const;

/** Internal roles that may decide verification. Account administration is not one. */
export const VERIFICATION_REVIEWER_ROLES = ['jobwork_sourcing', 'jobwork_quality'] as const;

export function assertMayMaintainProfile(actor: Actor): void {
  if (!actor.roles.some((role) => SUPPLIER_MAINTAINER_ROLES.includes(role as never))) {
    throw new NotAuthorized('Role cannot maintain the supplier profile');
  }
}

export function isVerificationReviewer(actor: Actor): boolean {
  return (
    actor.isInternal &&
    actor.roles.some((role) => VERIFICATION_REVIEWER_ROLES.includes(role as never))
  );
}

export function assertMayReview(actor: Actor): void {
  if (!isVerificationReviewer(actor)) {
    throw new NotAuthorized('Only JobWork sourcing or quality reviews supplier evidence');
  }
}

/**
 * Who admits a supplier into the network, and who decides its file. Kept apart from the
 * verification reviewer list on purpose: verifying one GST certificate is an evidence
 * judgement, admitting a company is a commercial one, and the roles that may do each
 * are allowed to differ. Today both decisions sit with JobWork sourcing, with platform
 * administration able to admit (`A-SO-01`).
 */
export const SUPPLIER_ADMISSION_ROLES = ['platform_admin'] as const;

export const ADMISSION_DECISION_ROLES = ['jobwork_sourcing', 'platform_admin'] as const;

export function assertMayDecideAdmission(actor: Actor): void {
  if (
    !actor.isInternal ||
    !actor.roles.some((role) => ADMISSION_DECISION_ROLES.includes(role as never))
  ) {
    throw new NotAuthorized('Only JobWork sourcing decides a supplier admission');
  }
}
