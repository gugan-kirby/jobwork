import type { Actor } from '../../iam';
import { NotAuthorized } from '../../iam/domain/errors';

/**
 * Who may state a requirement, and who may judge it. As with supplier verification,
 * the two lists never overlap: the customer describes what they want, JobWork decides
 * whether it can be sourced, and neither one can do the other's job.
 */

/** Customer-side roles that may create, edit and submit an enquiry. */
export const ENQUIRY_AUTHOR_ROLES = ['org_admin', 'customer_requester'] as const;

/** Customer-side roles that may answer a clarification. Same list: the author answers. */
export const CLARIFICATION_RESPONDER_ROLES = ENQUIRY_AUTHOR_ROLES;

/** Internal roles that run intake triage. */
export const INTAKE_REVIEWER_ROLES = ['jobwork_sourcing', 'jobwork_engineering'] as const;

export function assertMayAuthorEnquiry(actor: Actor): void {
  if (actor.organizationType !== 'customer') {
    throw new NotAuthorized('Only a customer organization raises an enquiry');
  }
  if (!actor.roles.some((role) => ENQUIRY_AUTHOR_ROLES.includes(role as never))) {
    throw new NotAuthorized('Role cannot raise or edit an enquiry');
  }
}

export function isIntakeReviewer(actor: Actor): boolean {
  return (
    actor.isInternal && actor.roles.some((role) => INTAKE_REVIEWER_ROLES.includes(role as never))
  );
}

export function assertMayTriage(actor: Actor): void {
  if (!isIntakeReviewer(actor)) {
    throw new NotAuthorized('Only JobWork sourcing or engineering triages an enquiry');
  }
}
