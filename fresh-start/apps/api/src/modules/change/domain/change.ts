import { IMPACT_AREAS, type ChangeClassification, type ChangeStatus, type ImpactAnswer } from '@jobwork/contracts';
import { DomainError } from '../../../platform/http/domain-error';

/**
 * Engineering change (doc 06 §9), with the exits a real process needs: a clarification
 * closes from triage, a proposal can be withdrawn before approval, an approver can return
 * the impact, and the customer can reject an internally approved change. The database
 * trigger enforces the same table (0021).
 */
const TRANSITIONS: Record<ChangeStatus, readonly ChangeStatus[]> = {
  proposed: ['triage', 'withdrawn'],
  triage: ['clarification', 'impact_analysis', 'closed', 'withdrawn'],
  clarification: ['triage', 'withdrawn'],
  impact_analysis: ['commercial_approval', 'withdrawn'],
  commercial_approval: ['approved', 'rejected', 'impact_analysis'],
  approved: ['released', 'rejected'],
  rejected: [],
  released: ['implemented'],
  implemented: ['verified'],
  verified: ['closed'],
  closed: [],
  withdrawn: [],
};

/** Statuses in which work can still be stopped or continued by an interim decision. */
export const OPEN_STATUSES: readonly ChangeStatus[] = ['proposed', 'triage', 'clarification', 'impact_analysis', 'commercial_approval', 'approved'];

export class ChangeRefused extends DomainError {
  constructor(code: string, title: string, detail?: string, status = 409) {
    super(code, status, title, detail);
  }
}

export class ChangeNotFound extends DomainError {
  constructor() {
    super('CHANGE_NOT_FOUND', 404, 'Change not found');
  }
}

export function assertChangeTransition(from: ChangeStatus, to: ChangeStatus): void {
  if (!TRANSITIONS[from].includes(to)) {
    throw new ChangeRefused('CHANGE_TRANSITION_REFUSED', `A ${from.replace(/_/g, ' ')} change cannot become ${to.replace(/_/g, ' ')}`);
  }
}

/** Doc 09 §8: the areas still unanswered (neither answered nor marked n/a with a reason). */
export function missingImpactAreas(areas: Partial<Record<string, ImpactAnswer>> | null): string[] {
  return IMPACT_AREAS.filter((area) => !areas?.[area]);
}

/** The customer decides scope changes and anything that moves its price or its date. */
export function customerApprovalRequired(classification: ChangeClassification, impact: { customerPriceDeltaMinor: number; deliveryDateDeltaDays: number }): boolean {
  return classification === 'scope' || impact.customerPriceDeltaMinor !== 0 || impact.deliveryDateDeltaDays !== 0;
}

/**
 * Who approves internally: engineering for a purely technical change; sales once money
 * moves on either leg (policy `change`, 0021).
 */
export function approverRoles(
  rules: { approverRoles?: unknown; commercialApproverRoles?: unknown },
  impact: { customerPriceDeltaMinor: number; purchaseOrders: Array<{ costDeltaMinor: number }> },
): string[] {
  const commercial = impact.customerPriceDeltaMinor !== 0 || impact.purchaseOrders.some((p) => p.costDeltaMinor !== 0);
  const roles = commercial ? rules.commercialApproverRoles : rules.approverRoles;
  if (!Array.isArray(roles) || roles.length === 0 || !roles.every((r) => typeof r === 'string')) {
    throw new DomainError('POLICY_RULES_INVALID', 500, 'The change approval policy is malformed');
  }
  return roles as string[];
}
