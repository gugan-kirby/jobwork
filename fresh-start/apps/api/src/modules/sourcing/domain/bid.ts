import { createHash } from 'node:crypto';
import type { BidDraft, BidVersionStatus, LateBidPolicy } from '@jobwork/contracts';
import { DomainError } from '../../../platform/http/domain-error';

/**
 * The bid version lifecycle (doc 06 §5, `FR-401`, `BR-COM-03`).
 *
 *   submitted -> superseded (a revision) | selected | rejected | withdrawn | expired
 *
 * Everything commercial is frozen at submit and covered by a content hash; a revision is
 * a *new* version that supersedes the old one, never an edit. The hash is what an award
 * cites, so it is computed here — one function, over a canonical shape — rather than
 * anywhere a field order could drift.
 */

const TRANSITIONS: Record<BidVersionStatus, readonly BidVersionStatus[]> = {
  submitted: ['superseded', 'selected', 'rejected', 'withdrawn', 'expired'],
  superseded: [],
  selected: ['withdrawn'],
  rejected: [],
  withdrawn: [],
  expired: [],
};

export class BidTransitionRejected extends DomainError {
  constructor(from: string, to: string) {
    super('BID_TRANSITION_REJECTED', 409, 'That bid version cannot move there', `${from} -> ${to}.`);
  }
}

export class BidNotFound extends DomainError {
  constructor() {
    super('BID_NOT_FOUND', 404, 'Bid not found', 'No bid of yours on that round.');
  }
}

export class BidRejected extends DomainError {
  constructor(detail: string, code = 'BID_REJECTED') {
    super(code, 422, 'That bid cannot be submitted', detail);
  }
}

export class LateBidRefused extends DomainError {
  constructor(deadlineAt: Date) {
    super(
      'BID_DEADLINE_PASSED',
      409,
      'The deadline for this round has passed',
      `Bids closed at ${deadlineAt.toISOString()}. This round does not accept late bids.`,
    );
  }
}

export function assertBidTransition(from: BidVersionStatus, to: BidVersionStatus): void {
  if (!TRANSITIONS[from].includes(to)) throw new BidTransitionRejected(from, to);
}

export interface RfqLineForPricing {
  rfqItemId: string;
  lineNo: number;
  quantityBreakpoints: Array<{ quantity: number; unit: string }>;
}

export interface ValidatedBid {
  linesTotalMinor: number;
  totalAmountMinor: number;
  contentHash: string;
}

/**
 * Validation at submit (doc 06 §5): every RFQ line quoted, at the quantities and units
 * the round actually asked for, in one currency, with a validity that has not already
 * passed. A bid that quotes something the round did not ask for is not a cheaper bid —
 * it is an incomparable one, and comparing it later is where sourcing goes wrong.
 */
export function validateBid(input: {
  draft: BidDraft;
  rfqLines: readonly RfqLineForPricing[];
  rfqCurrency: string;
  now: Date;
}): ValidatedBid {
  const { draft, rfqLines, rfqCurrency, now } = input;

  if (draft.currency !== rfqCurrency) {
    throw new BidRejected(
      `This round is quoted in ${rfqCurrency}; the bid is in ${draft.currency}.`,
      'BID_CURRENCY_MISMATCH',
    );
  }
  if (draft.lines.length === 0) throw new BidRejected('A bid needs at least one priced line.');

  const validity = new Date(`${draft.validityUntil}T23:59:59Z`);
  if (validity.getTime() <= now.getTime()) {
    throw new BidRejected('The validity date has already passed.', 'BID_VALIDITY_PASSED');
  }

  const byItem = new Map(rfqLines.map((line) => [line.rfqItemId, line]));
  const seen = new Set<string>();
  for (const line of draft.lines) {
    const rfqLine = byItem.get(line.rfqItemId);
    if (!rfqLine) {
      throw new BidRejected(
        'A priced line does not belong to this round.',
        'BID_LINE_UNKNOWN',
      );
    }
    const asked = rfqLine.quantityBreakpoints.some(
      (breakpoint) =>
        Number(breakpoint.quantity) === Number(line.quantity) && breakpoint.unit === line.unit,
    );
    if (!asked) {
      throw new BidRejected(
        `Line ${rfqLine.lineNo} was asked for at other quantities; ${line.quantity} ${line.unit} is not one of them.`,
        'BID_QUANTITY_MISMATCH',
      );
    }
    const key = `${line.rfqItemId}:${line.quantity}:${line.unit}`;
    if (seen.has(key)) throw new BidRejected('The same quantity is priced twice.');
    seen.add(key);
  }

  // Every line the round asked for must carry at least one price.
  const priced = new Set(draft.lines.map((line) => line.rfqItemId));
  const missing = rfqLines.filter((line) => !priced.has(line.rfqItemId));
  if (missing.length > 0) {
    throw new BidRejected(
      `Lines ${missing.map((line) => line.lineNo).join(', ')} are not priced.`,
      'BID_LINE_MISSING',
    );
  }

  const linesTotalMinor = draft.lines.reduce(
    (total, line) =>
      total + Math.round(line.unitPriceMinor * line.quantity) + (line.setupAmountMinor ?? 0),
    0,
  );
  const totalAmountMinor =
    linesTotalMinor + (draft.nreAmountMinor ?? 0) + (draft.freightAmountMinor ?? 0);

  return { linesTotalMinor, totalAmountMinor, contentHash: hashBid(draft, totalAmountMinor) };
}

/**
 * The content hash an award cites. Canonical by construction: fields in a fixed order,
 * lines sorted, money as integers. Two bids with the same commercial meaning hash the
 * same; anything a supplier changed changes the hash.
 */
export function hashBid(draft: BidDraft, totalAmountMinor: number): string {
  const canonical = {
    currency: draft.currency,
    taxTreatment: draft.taxTreatment,
    leadTimeDays: draft.leadTimeDays,
    validityUntil: draft.validityUntil,
    feasibility: draft.feasibility,
    assumptions: draft.assumptions.trim(),
    exclusions: draft.exclusions.trim(),
    paymentTerms: draft.paymentTerms.trim(),
    note: draft.note.trim(),
    nreAmountMinor: draft.nreAmountMinor ?? 0,
    freightAmountMinor: draft.freightAmountMinor ?? 0,
    totalAmountMinor,
    lines: [...draft.lines]
      .map((line) => ({
        rfqItemId: line.rfqItemId,
        quantity: line.quantity,
        unit: line.unit,
        unitPriceMinor: line.unitPriceMinor,
        setupAmountMinor: line.setupAmountMinor ?? 0,
        leadTimeDays: line.leadTimeDays ?? null,
      }))
      .sort((a, b) =>
        `${a.rfqItemId}:${a.quantity}`.localeCompare(`${b.rfqItemId}:${b.quantity}`),
      ),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/**
 * Whether a submission arriving now is accepted, and whether it is flagged late.
 * A late bid under `accept_flagged` is kept **with its receipt time** rather than
 * quietly treated as on time (doc 19 §4).
 */
export function lateness(input: {
  deadlineAt: Date | null;
  now: Date;
  policy: LateBidPolicy;
}): { late: boolean } {
  if (!input.deadlineAt || input.now <= input.deadlineAt) return { late: false };
  if (input.policy === 'reject') throw new LateBidRefused(input.deadlineAt);
  return { late: true };
}

/** What changed between two versions, for the supplier's own side-by-side diff. */
export function diffVersions(
  previous: { totalAmountMinor: number; leadTimeDays: number; validityUntil: string },
  next: { totalAmountMinor: number; leadTimeDays: number; validityUntil: string },
): Array<{ field: string; from: string; to: string }> {
  const changes: Array<{ field: string; from: string; to: string }> = [];
  if (previous.totalAmountMinor !== next.totalAmountMinor) {
    changes.push({
      field: 'Total',
      from: String(previous.totalAmountMinor),
      to: String(next.totalAmountMinor),
    });
  }
  if (previous.leadTimeDays !== next.leadTimeDays) {
    changes.push({
      field: 'Lead time (days)',
      from: String(previous.leadTimeDays),
      to: String(next.leadTimeDays),
    });
  }
  if (previous.validityUntil !== next.validityUntil) {
    changes.push({ field: 'Valid until', from: previous.validityUntil, to: next.validityUntil });
  }
  return changes;
}
