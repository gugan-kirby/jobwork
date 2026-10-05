import { QualityRefused } from './inspection';

/**
 * Nonconformance rules (IN-15 F-15.2; doc 06 §10; doc 09 §§11, 13; FR-703, FR-705; BR-QLT-04, BR-QLT-06).
 * The database enforces the same machine; these are the refusals a person reads.
 */

export type NcrStatus =
  | 'open'
  | 'containment'
  | 'disposition_pending'
  | 'rework'
  | 'reinspection'
  | 'deviation_pending'
  | 'accepted_under_deviation'
  | 'rejected'
  | 'verified'
  | 'closed';

const TRANSITIONS: Record<NcrStatus, readonly NcrStatus[]> = {
  open: ['containment'],
  containment: ['disposition_pending'],
  disposition_pending: ['rework', 'deviation_pending', 'rejected'],
  rework: ['reinspection'],
  reinspection: ['disposition_pending', 'verified'],
  deviation_pending: ['accepted_under_deviation', 'disposition_pending'],
  accepted_under_deviation: ['closed'],
  rejected: ['closed'],
  verified: ['closed'],
  closed: [],
};

export function assertNcrTransition(from: NcrStatus, to: NcrStatus): void {
  if (!TRANSITIONS[from].includes(to)) {
    throw new QualityRefused('NCR_TRANSITION_REFUSED', `A ${from.replace(/_/g, ' ')} NCR cannot become ${to.replace(/_/g, ' ')}`);
  }
}

/** Corrective action is required for these severities (doc 09 §13 "where required"; owner default). */
export const CORRECTIVE_ACTION_SEVERITIES = ['critical', 'major'];

/** Doc 09 §13: "operator mistake" without causal evidence does not satisfy a corrective action. */
export function thinCause(cause: string): boolean {
  return /^\s*(operator|human|worker|staff)\s+(mistake|error|fault|carelessness)\s*\.?\s*$/i.test(cause) || cause.trim().length < 15;
}

export interface ClosureFacts {
  status: NcrStatus;
  dispositionDecidedBy: string | null;
  correctiveActionRequired: boolean;
  correctiveActionStatus: string | null;
  originalInspectionId: string;
  /** The reinspection that verified the latest rework, when the NCR was verified that way. */
  verifyingReinspection: { id: string; status: string; plannedAt: Date; reinspectionChain: string[] } | null;
  latestDispositionAt: Date | null;
  openChildren: string[];
}

/** Why the NCR cannot close yet, for `actorId`; empty when it can (BR-QLT-06; FR-705). */
export function closeBlockers(f: ClosureFacts, actorId: string): string[] {
  const out: string[] = [];
  if (!['verified', 'accepted_under_deviation', 'rejected'].includes(f.status)) out.push(`It is ${f.status.replace(/_/g, ' ')}: a disposition must be carried through first.`);
  if (f.dispositionDecidedBy === actorId) out.push('You decided its disposition; another member of JobWork quality verifies and closes it.');
  if (f.correctiveActionRequired && f.correctiveActionStatus !== 'verified') out.push('Its corrective action is not verified effective yet.');
  if (f.status === 'verified') {
    const r = f.verifyingReinspection;
    // No circular closure: the evidence is a new inspection after the rework, never the failing one.
    if (!r || r.status !== 'passed') out.push('No passed reinspection verifies the rework.');
    else if (r.id === f.originalInspectionId || !r.reinspectionChain.includes(f.originalInspectionId)) out.push('The verifying inspection must be a reinspection of the failed one.');
    else if (f.latestDispositionAt && r.plannedAt < f.latestDispositionAt) out.push('The verifying reinspection was planned before the rework was approved.');
  }
  if (f.openChildren.length > 0) out.push(`Branched NCRs are still open: ${f.openChildren.join(', ')}.`);
  return out;
}
