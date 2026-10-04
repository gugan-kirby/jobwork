import type { CustomerQuote, CustomerQuoteListItem, CustomerQuoteStatus } from '@jobwork/contracts';
import { QUOTE_VERSION_VISIBLE_TO_CUSTOMER, daysToExpiry, diffQuoteVersions, isExpired } from '../domain/quote';
import type { QuoteRecord, QuoteVersionRecord } from '../infrastructure/commercial.repository';

/**
 * The customer projection of a quotation (doc 06 §13, `BR-COM-05`, `ES-11`). Built by
 * construction from the internal record into a different type: there is no field on
 * `CustomerQuote` for a supplier, a bid, a cost or a margin, so nothing has to be
 * stripped and nothing can be forgotten.
 *
 * Only versions the customer was sent are visible. A replacement in progress is reported
 * as a revision on its way, with the last sent version still readable exactly as sent.
 */

const STATUS_LABELS: Record<CustomerQuoteStatus, string> = {
  quotation_ready: 'Quotation ready',
  revision_requested: 'Revision in progress',
  accepted: 'Accepted',
  rejected: 'Rejected',
  expired: 'Expired',
  withdrawn: 'Withdrawn by JobWork',
};

/** The latest version the customer has been sent, if any. */
export function visibleVersion(quote: QuoteRecord): QuoteVersionRecord | null {
  return quote.versions.find((v) => QUOTE_VERSION_VISIBLE_TO_CUSTOMER.has(v.status)) ?? null;
}

function customerStatus(quote: QuoteRecord, version: QuoteVersionRecord, now: Date): CustomerQuoteStatus {
  switch (quote.status) {
    case 'sent':
      return isExpired(version.validityUntil, now) ? 'expired' : 'quotation_ready';
    case 'accepted':
      return 'accepted';
    case 'rejected':
      return 'rejected';
    case 'expired':
      return 'expired';
    case 'withdrawn':
      return 'withdrawn';
    case 'revision_requested':
    case 'draft':
    case 'internal_approval':
    case 'approved':
      // A sent version exists (we are past the visibility check), so a replacement is on its way.
      return 'revision_requested';
  }
}

export function projectCustomerQuote(
  quote: QuoteRecord,
  siblings: readonly QuoteRecord[],
  now: Date = new Date(),
): CustomerQuote | null {
  const version = visibleVersion(quote);
  if (!version || !quote.reference) return null;
  const status = customerStatus(quote, version, now);
  const open = status === 'quotation_ready';

  const sentVersions = quote.versions
    .filter((v) => QUOTE_VERSION_VISIBLE_TO_CUSTOMER.has(v.status) && v.id !== version.id)
    .sort((a, b) => b.versionNo - a.versionNo);
  const ordered = [...sentVersions, version].sort((a, b) => a.versionNo - b.versionNo);
  const previousVersions = sentVersions.map((v) => {
    const index = ordered.findIndex((o) => o.id === v.id);
    const before = index > 0 ? ordered[index - 1]! : null;
    return {
      versionNo: v.versionNo,
      totalMinor: v.totalMinor,
      sentAt: v.sentAt ? v.sentAt.toISOString() : null,
      revisionReason: v.revisionReason,
      changes: before ? diffQuoteVersions(before, v) : [],
    };
  });

  return {
    quotationId: quote.id,
    reference: quote.reference,
    optionLabel: quote.optionLabel,
    status,
    statusLabel: STATUS_LABELS[status],
    versionNo: version.versionNo,
    enquiry: { enquiryId: quote.enquiryId, reference: quote.enquiryReference, title: quote.enquiryTitle },
    issuedBy: 'JobWork',
    currency: version.currency,
    lines: version.lines.map((l) => ({
      lineNo: l.lineNo,
      description: l.description,
      quantity: l.quantity,
      unit: l.unit,
      unitPriceMinor: l.unitPriceMinor,
      amountMinor: l.amountMinor,
    })),
    subtotalMinor: version.subtotalMinor,
    taxRateBp: version.taxRateBp,
    taxMinor: version.taxMinor,
    freightMinor: version.freightMinor,
    totalMinor: version.totalMinor,
    deliveryLeadDays: version.deliveryLeadDays,
    paymentTerms: version.paymentTerms,
    advanceBp: version.advanceBp,
    balanceTrigger: version.balanceTrigger,
    validityUntil: version.validityUntil,
    daysToExpiry: daysToExpiry(version.validityUntil, now),
    assumptions: version.assumptions,
    exclusions: version.exclusions,
    scopeNote: version.scopeNote,
    terms: { code: version.termsCode, versionNo: version.termsVersionNo, hash: version.termsHash },
    contentHash: version.contentHash,
    sentAt: version.sentAt ? version.sentAt.toISOString() : null,
    decisionReason: quote.decisionReason,
    siblingOptions: siblings
      .filter((s) => s.id !== quote.id)
      .map((s) => ({ sibling: s, version: visibleVersion(s) }))
      .filter((s): s is { sibling: QuoteRecord; version: QuoteVersionRecord } => s.version !== null && s.sibling.reference !== null)
      .map(({ sibling, version: v }) => ({
        quotationId: sibling.id,
        optionLabel: sibling.optionLabel,
        totalMinor: v.totalMinor,
        deliveryLeadDays: v.deliveryLeadDays,
        status: customerStatus(sibling, v, now),
      })),
    previousVersions,
    actions: { canAccept: open, canRequestRevision: open, canReject: open },
    aggregateVersion: quote.aggregateVersion,
  };
}

export function projectCustomerQuoteListItem(quote: QuoteRecord, now: Date = new Date()): CustomerQuoteListItem | null {
  const version = visibleVersion(quote);
  if (!version || !quote.reference) return null;
  const status = customerStatus(quote, version, now);
  return {
    quotationId: quote.id,
    reference: quote.reference,
    optionLabel: quote.optionLabel,
    status,
    statusLabel: STATUS_LABELS[status],
    enquiryTitle: quote.enquiryTitle,
    enquiryReference: quote.enquiryReference,
    currency: version.currency,
    totalMinor: version.totalMinor,
    validityUntil: version.validityUntil,
    daysToExpiry: daysToExpiry(version.validityUntil, now),
    sentAt: version.sentAt ? version.sentAt.toISOString() : null,
    versionNo: version.versionNo,
  };
}
