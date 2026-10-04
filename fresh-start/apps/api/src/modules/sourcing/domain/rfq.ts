import type { InvitationStatus, RfqStatus } from '@jobwork/contracts';
import { DomainError } from '../../../platform/http/domain-error';

/**
 * The RFQ and invitation state machines (doc 06 §4), stated once here and enforced again
 * by database triggers.
 *
 *   rfq:        draft -> internal_review -> open -> responses_received -> evaluation
 *                     -> awarded | no_bid | expired | cancelled
 *               any live state -> superseded (the requirement was revised, F-12.5)
 *   invitation: prepared -> invited -> acknowledged -> clarifying -> responded
 *                                  \-> declined | no_response | revoked
 *
 * The invitation machine is per supplier and deliberately independent: one supplier
 * declining says nothing about the others, and a round with one response is a round
 * with one response, not a failed round.
 */

const RFQ_TRANSITIONS: Record<RfqStatus, readonly RfqStatus[]> = {
  draft: ['internal_review', 'open', 'cancelled', 'superseded'],
  internal_review: ['open', 'draft', 'cancelled', 'superseded'],
  open: ['responses_received', 'evaluation', 'no_bid', 'expired', 'cancelled', 'superseded'],
  responses_received: ['evaluation', 'expired', 'cancelled', 'superseded'],
  evaluation: ['awarded', 'no_bid', 'cancelled', 'superseded'],
  awarded: [],
  no_bid: [],
  expired: [],
  cancelled: [],
  superseded: [],
};

/** Rounds a requirement revision supersedes: everything not yet history. */
export const LIVE_RFQ_STATUSES: readonly RfqStatus[] = ['draft', 'internal_review', 'open', 'responses_received', 'evaluation'];

const INVITATION_TRANSITIONS: Record<InvitationStatus, readonly InvitationStatus[]> = {
  prepared: ['invited', 'revoked'],
  // `responded` directly from `invited`: submitting a bid is the strongest
  // acknowledgement there is, and doc 06 §4's chain is the happy path, not a gate. A
  // supplier who quotes without clicking "acknowledge" first has still answered.
  invited: ['acknowledged', 'responded', 'declined', 'no_response', 'revoked'],
  acknowledged: ['clarifying', 'responded', 'declined', 'no_response', 'revoked'],
  clarifying: ['responded', 'declined', 'no_response', 'revoked'],
  // A responded supplier can still revise (a new version) or withdraw entirely.
  responded: ['clarifying', 'revoked'],
  declined: [],
  no_response: [],
  revoked: [],
};

export class RfqTransitionRejected extends DomainError {
  constructor(from: string, to: string) {
    super(
      'RFQ_TRANSITION_REJECTED',
      409,
      'That is not a step this RFQ can take',
      `Recorded ${from}; refused ${to}.`,
    );
  }
}

export class RfqNotFound extends DomainError {
  constructor() {
    super('RFQ_NOT_FOUND', 404, 'RFQ not found', 'No sourcing round with that id.');
  }
}

export class InvitationNotFound extends DomainError {
  constructor() {
    super('INVITATION_NOT_FOUND', 404, 'Invitation not found', 'No invitation with that id.');
  }
}

/** Release refuses rather than releasing something a supplier must not see. */
export class ReleaseBlocked extends DomainError {
  constructor(detail: string) {
    super('RFQ_RELEASE_BLOCKED', 422, 'This round cannot be released yet', detail);
  }
}

export class SupplierNotEligible extends DomainError {
  constructor(exclusions: readonly string[]) {
    super(
      'SUPPLIER_NOT_ELIGIBLE',
      422,
      'That supplier is not eligible for this round',
      `Excluded for: ${exclusions.join(', ') || 'unknown reason'}. Invite them anyway only with a recorded override reason.`,
    );
  }
}

export function assertRfqTransition(from: RfqStatus, to: RfqStatus): void {
  if (!RFQ_TRANSITIONS[from].includes(to)) throw new RfqTransitionRejected(from, to);
}

export function assertInvitationTransition(from: InvitationStatus, to: InvitationStatus): void {
  if (!INVITATION_TRANSITIONS[from].includes(to)) throw new RfqTransitionRejected(from, to);
}

/** Invitation states that still owe the round an answer. */
export const OPEN_INVITATION_STATES: readonly InvitationStatus[] = [
  'invited',
  'acknowledged',
  'clarifying',
];

/**
 * Whether a round may be closed for evaluation (doc 06 §4): the deadline has passed, or
 * every invited supplier has said something. Closing early while somebody is still
 * quoting would make the shortlist a function of who typed fastest.
 */
export function closeReadiness(input: {
  deadlineAt: Date | null;
  now: Date;
  invitations: ReadonlyArray<{ status: InvitationStatus }>;
}): { ready: boolean; reason: string } {
  const live = input.invitations.filter((invitation) =>
    OPEN_INVITATION_STATES.includes(invitation.status),
  );
  if (input.deadlineAt && input.deadlineAt <= input.now) {
    return { ready: true, reason: 'deadline passed' };
  }
  if (live.length === 0) {
    return { ready: true, reason: 'every invited supplier has responded or declined' };
  }
  return {
    ready: false,
    reason: `${live.length} supplier${live.length === 1 ? ' is' : 's are'} still within the deadline`,
  };
}

/**
 * The outcome a closed round lands on. A round nobody bid on is `no_bid` — an explicit
 * disposition, not a dead end somebody has to interpret later (doc 19 §4).
 */
export function closingStatus(responded: number): RfqStatus {
  return responded > 0 ? 'evaluation' : 'no_bid';
}

/** A single response is not a failure, but it is a fact an award has to acknowledge. */
export function singleSourceRisk(responded: number, invited: number): boolean {
  return responded === 1 && invited > 1;
}
