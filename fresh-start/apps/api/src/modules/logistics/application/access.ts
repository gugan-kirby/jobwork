import { type Actor, requireTransactionalStrength } from '../../iam';
import { DomainError } from '../../../platform/http/domain-error';

export const LOGISTICS = ['jobwork_logistics'];
export const QUALITY = ['jobwork_quality'];
/** Support reads shipments to triage what customers report about deliveries (IN-17). */
export const LOGISTICS_READERS = ['jobwork_logistics', 'jobwork_quality', 'jobwork_sourcing', 'jobwork_engineering', 'jobwork_sales', 'jobwork_support', 'platform_admin'];

/** A JobWork member with one of `roles`, at transactional strength (AUTH-15). */
export function requireJobWork(actor: Actor, roles: readonly string[]): void {
  if (!actor.isInternal || !actor.roles.some((r) => roles.includes(r))) throw new DomainError('NOT_AUTHORIZED', 403, 'Not permitted', `Requires ${roles.join(' or ')}.`);
  requireTransactionalStrength(actor);
}

export function requireLogisticsReader(actor: Actor): void {
  if (!actor.isInternal || !actor.roles.some((r) => LOGISTICS_READERS.includes(r))) throw new DomainError('NOT_AUTHORIZED', 403, 'Not permitted');
}
