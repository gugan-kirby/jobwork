import { createHash } from 'node:crypto';
import type { QuoteContentInput, QuoteLine, QuoteStatus, QuoteVersionStatus } from '@jobwork/contracts';
import { DomainError } from '../../../platform/http/domain-error';
import { lineAmount, taxOn } from './money';

/**
 * Customer quote lifecycle (doc 06 §6, `FR-406`, `BR-COM-04`, `BR-COM-09`).
 *
 *   draft -> internal_approval -> approved -> sent -> accepted | rejected | expired
 *   internal_approval -> draft (returned)
 *   sent -> revision_requested -> (replacement: new version, back to draft)
 *   draft | internal_approval | approved | sent | revision_requested -> withdrawn
 *
 * A replacement is a *new version* that supersedes the sent one; the aggregate goes back
 * to `draft` and walks the same approval again. The sent version stays exactly as the
 * customer saw it (plan deviation from the doc 06 figure's `superseded` aggregate state,
 * recorded in the IN-07 plan: supersession is a version fact, per doc 05 §6).
 */

const TRANSITIONS: Record<QuoteStatus, readonly QuoteStatus[]> = {
  draft: ['internal_approval', 'withdrawn'],
  internal_approval: ['approved', 'draft', 'withdrawn'],
  approved: ['sent', 'draft', 'withdrawn'],
  sent: ['accepted', 'rejected', 'expired', 'revision_requested', 'withdrawn'],
  revision_requested: ['draft', 'withdrawn', 'expired'],
  accepted: [],
  rejected: [],
  expired: [],
  withdrawn: [],
};

export class QuoteTransitionRejected extends DomainError {
  constructor(from: string, to: string) {
    super('QUOTE_TRANSITION_REJECTED', 409, 'That is not a step this quotation can take', `Recorded ${from}; refused ${to}.`);
  }
}

export class QuoteNotFound extends DomainError {
  constructor() {
    super('QUOTE_NOT_FOUND', 404, 'Quotation not found');
  }
}

export class QuoteVersionConflict extends DomainError {
  constructor(expected: number, actual: number) {
    super(
      'VERSION_CONFLICT',
      409,
      'The quotation changed since you loaded it',
      `You were working from version ${expected}; it is now ${actual}. Reload before acting.`,
    );
  }
}

/** `BR-COM-09` in words the customer can act on. */
export class QuoteNotActionable extends DomainError {
  constructor(status: QuoteStatus) {
    const detail =
      status === 'expired'
        ? 'This quotation has expired. Ask JobWork for a fresh one.'
        : status === 'accepted'
          ? 'This quotation has already been accepted.'
          : status === 'rejected'
            ? 'This quotation was rejected.'
            : status === 'revision_requested'
              ? 'A revision has been requested; a replacement is on its way.'
              : 'This quotation is not open for a decision.';
    super(
      status === 'expired' ? 'QUOTE_EXPIRED' : status === 'accepted' ? 'QUOTE_ALREADY_ACCEPTED' : 'QUOTE_NOT_OPEN',
      409,
      'This quotation cannot be acted on',
      detail,
    );
  }
}

export function assertQuoteTransition(from: QuoteStatus, to: QuoteStatus): void {
  if (!TRANSITIONS[from].includes(to)) throw new QuoteTransitionRejected(from, to);
}

export function assertQuoteVersion(expected: number, actual: number): void {
  if (expected !== actual) throw new QuoteVersionConflict(expected, actual);
}

export interface QuoteTotals {
  lines: QuoteLine[];
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
}

/** Line amounts rounded once each, tax on the subtotal, freight added ex-tax of its own. */
export function computeQuoteTotals(content: QuoteContentInput): QuoteTotals {
  const lines: QuoteLine[] = [...content.lines]
    .sort((a, b) => a.lineNo - b.lineNo)
    .map((line) => ({ ...line, amountMinor: lineAmount(line.unitPriceMinor, line.quantity) }));
  const subtotalMinor = lines.reduce((sum, l) => sum + l.amountMinor, 0);
  const taxMinor = taxOn(subtotalMinor + content.freightMinor, content.taxRateBp);
  const totalMinor = subtotalMinor + content.freightMinor + taxMinor;
  return { lines, subtotalMinor, taxMinor, totalMinor };
}

/**
 * The content hash the acceptance will cite (`FR-407`). Canonical by construction:
 * fixed field order, sorted lines, integers only, terms by version id.
 */
export function hashQuoteContent(input: {
  currency: string;
  content: QuoteContentInput;
  totals: QuoteTotals;
  termsVersionId: string;
}): string {
  const canonical = {
    currency: input.currency,
    lines: input.totals.lines.map((l) => ({
      lineNo: l.lineNo,
      description: l.description.trim(),
      quantity: l.quantity,
      unit: l.unit,
      unitPriceMinor: l.unitPriceMinor,
      amountMinor: l.amountMinor,
    })),
    subtotalMinor: input.totals.subtotalMinor,
    taxRateBp: input.content.taxRateBp,
    taxMinor: input.totals.taxMinor,
    freightMinor: input.content.freightMinor,
    totalMinor: input.totals.totalMinor,
    deliveryLeadDays: input.content.deliveryLeadDays,
    paymentTerms: input.content.paymentTerms.trim(),
    advanceBp: input.content.advanceBp,
    balanceTrigger: input.content.balanceTrigger,
    validityUntil: input.content.validityUntil,
    assumptions: input.content.assumptions.trim(),
    exclusions: input.content.exclusions.trim(),
    scopeNote: input.content.scopeNote.trim(),
    termsVersionId: input.termsVersionId,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/**
 * "Valid until 12 October" means until the end of 12 October where the customer is —
 * India at launch (doc 10 §9), so end of day IST, not UTC (which would add 5½ hours).
 * The expiry sweep's SQL uses the same zone (`VALIDITY_TIME_ZONE`).
 */
export const VALIDITY_TIME_ZONE = 'Asia/Kolkata';
const VALIDITY_OFFSET = '+05:30';

function endOfValidity(validityUntil: string): number {
  return new Date(`${validityUntil}T23:59:59.999${VALIDITY_OFFSET}`).getTime();
}

/** Whether a sent version has passed its validity (end of day, India time). */
export function isExpired(validityUntil: string, now: Date): boolean {
  return endOfValidity(validityUntil) < now.getTime();
}

export function daysToExpiry(validityUntil: string, now: Date): number {
  return Math.floor((endOfValidity(validityUntil) - now.getTime()) / 86_400_000);
}

/** The field-level diff between two sent versions, in the customer's words. */
export function diffQuoteVersions(
  previous: { totalMinor: number; deliveryLeadDays: number; validityUntil: string; paymentTerms: string; lines: QuoteLine[] },
  next: { totalMinor: number; deliveryLeadDays: number; validityUntil: string; paymentTerms: string; lines: QuoteLine[] },
): Array<{ field: string; from: string; to: string }> {
  const changes: Array<{ field: string; from: string; to: string }> = [];
  if (previous.totalMinor !== next.totalMinor) {
    changes.push({ field: 'Total', from: String(previous.totalMinor), to: String(next.totalMinor) });
  }
  if (previous.deliveryLeadDays !== next.deliveryLeadDays) {
    changes.push({ field: 'Delivery (days)', from: String(previous.deliveryLeadDays), to: String(next.deliveryLeadDays) });
  }
  if (previous.validityUntil !== next.validityUntil) {
    changes.push({ field: 'Valid until', from: previous.validityUntil, to: next.validityUntil });
  }
  if (previous.paymentTerms !== next.paymentTerms) {
    changes.push({ field: 'Payment terms', from: previous.paymentTerms, to: next.paymentTerms });
  }
  const prevLines = new Map(previous.lines.map((l) => [l.lineNo, l]));
  for (const line of next.lines) {
    const before = prevLines.get(line.lineNo);
    if (!before) {
      changes.push({ field: `Line ${line.lineNo}`, from: '—', to: line.description });
    } else if (before.unitPriceMinor !== line.unitPriceMinor || before.quantity !== line.quantity) {
      changes.push({
        field: `Line ${line.lineNo} price`,
        from: `${before.quantity} × ${before.unitPriceMinor}`,
        to: `${line.quantity} × ${line.unitPriceMinor}`,
      });
    }
  }
  for (const line of previous.lines) {
    if (!next.lines.some((l) => l.lineNo === line.lineNo)) {
      changes.push({ field: `Line ${line.lineNo}`, from: line.description, to: '—' });
    }
  }
  return changes;
}

export const QUOTE_VERSION_VISIBLE_TO_CUSTOMER: ReadonlySet<QuoteVersionStatus> = new Set([
  'sent',
  'superseded',
  'accepted',
  'rejected',
  'expired',
]);
