import type { AudienceType } from '@jobwork/contracts';
import type { Actor } from '../../iam';
import { NotAuthorized } from '../../iam/domain/errors';
import { DocumentNotFound } from './errors';

/**
 * Who may release a document and who may read a released one (doc 03 §3, §7).
 *
 * Two rules from doc 03 §7 shape these lists and are easy to get wrong:
 * account administration is not business access — `platform_admin` and
 * `security_admin` appear nowhere below — and a customer never names a supplier
 * organization (nor the reverse), so an external party can only release *to JobWork*;
 * onward release to the other side is JobWork's act, which is what keeps identities
 * shielded (doc 11 §9).
 */

/** Internal roles that handle document content as part of their work. */
export const INTERNAL_DOCUMENT_ROLES = [
  'jobwork_sales',
  'jobwork_sourcing',
  'jobwork_engineering',
  'jobwork_quality',
  'jobwork_logistics',
  'jobwork_support',
] as const;

/** Roles that may release a document their own organization owns. */
export const EXTERNAL_RELEASE_ROLES = [
  'org_admin',
  'customer_requester',
  'customer_approver',
  'supplier_estimator',
  'supplier_quality',
  'supplier_production',
] as const;

export function isInternalDocumentHandler(actor: Actor): boolean {
  return actor.isInternal && actor.roles.some((r) => INTERNAL_DOCUMENT_ROLES.includes(r as never));
}

export function isAuditor(actor: Actor): boolean {
  return actor.isInternal && actor.roles.includes('auditor');
}

/**
 * Releasing requires standing over the document: either it belongs to the actor's own
 * organization and they hold a releasing role, or they are JobWork staff handling it.
 *
 * Someone with no standing at all is told the version does not exist, matching what
 * the download path says — otherwise a 403 would confirm the id of another
 * organization's document to anyone guessing (doc 03 §7). Inside one's own
 * organization existence is no secret, so a wrong role is refused as a wrong role.
 */
export function assertMayRelease(actor: Actor, owningOrganizationId: string): void {
  if (actor.organizationId === owningOrganizationId) {
    if (actor.isInternal ? isInternalDocumentHandler(actor) : hasReleaseRole(actor)) return;
    throw new NotAuthorized('Role cannot release documents');
  }
  if (isInternalDocumentHandler(actor)) return;
  throw new DocumentNotFound();
}

function hasReleaseRole(actor: Actor): boolean {
  return actor.roles.some((r) => EXTERNAL_RELEASE_ROLES.includes(r as never));
}

/**
 * An external organization may release only to JobWork. Naming another organization —
 * the counterparty — is JobWork's privilege precisely because the parties are not
 * supposed to know each other (doc 03 §7, doc 11 §9).
 */
export function assertAudienceAllowed(actor: Actor, audienceType: AudienceType): void {
  if (isInternalDocumentHandler(actor)) return;
  if (audienceType === 'internal') return;
  throw new NotAuthorized('Only JobWork can release documents to another organization');
}
