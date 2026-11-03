'use client';

import { useEffect, useMemo, useState } from 'react';
import type { CustomerQuoteListItem } from '@jobwork/contracts';
import Link from 'next/link';
import {
  BrandGlyph,
  ButtonLink,
  Card,
  EmptyState,
  ErrorState,
  FilterChips,
  Icon,
  LoadingState,
  Page,
  Stack,
  StatusChip,
  formatMoney,
  type Tone,
} from '@jobwork/ui';
import { api, ApiError } from '../../lib/api';

/**
 * Quotations (prototype tile 9, corrected per doc 14 §4): every offer is from JobWork.
 * There is no supplier on this page because there is no supplier in the payload — the
 * customer projection has no field for one.
 *
 * VF-09 (reference screen 09, corrected): the reference groups "quotes received" under
 * one enquiry and gives each a supplier card with city and rating. Here each enquiry is
 * a summary card with its count, and each offer card is a JobWork option — Standard,
 * Fast, Premium — with amount, validity and version where the reference had amount,
 * lead time and minimum quantity. Accept goes to the acceptance page, which carries the
 * approval and terms checks; only an offer still open for decision shows it.
 */

const TONE: Record<CustomerQuoteListItem['status'], Tone> = {
  quotation_ready: 'attention',
  revision_requested: 'progress',
  accepted: 'positive',
  rejected: 'neutral',
  expired: 'neutral',
  withdrawn: 'neutral',
};

type Filter = 'all' | 'quotation_ready' | 'revision_requested' | 'accepted' | 'closed';

const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'quotation_ready', label: 'To decide' },
  { value: 'revision_requested', label: 'Being revised' },
  { value: 'accepted', label: 'Accepted' },
  { value: 'closed', label: 'Closed' },
];

const OPTION_TINT: Record<CustomerQuoteListItem['optionLabel'], string> = {
  standard: 'jw-record-tile-green',
  fast: 'jw-record-tile-violet',
  premium: 'jw-record-tile-orange',
};

const dayMonth = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', timeZone: 'Asia/Kolkata' });

const shortDate = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

/** Offers grouped by the enquiry they answer, newest group first. */
function byEnquiry(list: CustomerQuoteListItem[]): Array<{ key: string; title: string; reference: string | null; sentAt: string | null; offers: CustomerQuoteListItem[] }> {
  const groups = new Map<string, { key: string; title: string; reference: string | null; sentAt: string | null; offers: CustomerQuoteListItem[] }>();
  for (const q of list) {
    const key = q.enquiryReference ?? q.enquiryTitle;
    const group = groups.get(key) ?? { key, title: q.enquiryTitle, reference: q.enquiryReference, sentAt: null, offers: [] };
    group.offers.push(q);
    if (q.sentAt && (!group.sentAt || q.sentAt > group.sentAt)) group.sentAt = q.sentAt;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => (b.sentAt ?? '').localeCompare(a.sentAt ?? ''));
}

const OPTION_LABEL: Record<CustomerQuoteListItem['optionLabel'], string> = {
  standard: 'Standard',
  fast: 'Fast',
  premium: 'Premium',
};

export default function QuotationsPage() {
  const [quotations, setQuotations] = useState<CustomerQuoteListItem[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [filter, setFilter] = useState<Filter>('all');

  useEffect(() => {
    api<{ quotations: CustomerQuoteListItem[] }>('/quotations')
      .then((res) => setQuotations(res.quotations))
      .catch((err) => {
        if (err instanceof ApiError) setError(err);
      });
  }, []);

  const all = quotations ?? [];
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const q of all) map.set(q.status, (map.get(q.status) ?? 0) + 1);
    return map;
  }, [all]);
  const visible = all.filter((q) => {
    if (filter === 'all') return true;
    if (filter === 'closed') return ['rejected', 'expired', 'withdrawn'].includes(q.status);
    return q.status === filter;
  });

  return (
    <Page
      title="Quotes Received"
      back={{ href: '/', label: 'Back to home' }}
      description="Offers from JobWork. Each one is valid until its stated date; the decision is yours."
    >
      <Stack gap={4}>
        {error ? (
          <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} />
        ) : null}

        <FilterChips
          label="Filter quotations by status"
          value={filter}
          options={FILTERS.map((f) => ({
            ...f,
            count:
              f.value === 'all'
                ? all.length
                : f.value === 'closed'
                  ? (counts.get('rejected') ?? 0) + (counts.get('expired') ?? 0) + (counts.get('withdrawn') ?? 0)
                  : counts.get(f.value) ?? 0,
          }))}
          onChange={setFilter}
        />

        {error ? null : quotations === null ? (
          <Card>
            <LoadingState label="Loading your quotations" />
          </Card>
        ) : visible.length === 0 ? (
          <Card>
            <EmptyState
              title={all.length === 0 ? 'No quotations yet' : 'Nothing matches'}
              detail={
                all.length === 0
                  ? 'A quotation from JobWork follows the review and sourcing of an enquiry. When one is ready it appears here with its validity, lines and terms.'
                  : 'Try another filter.'
              }
              action={
                all.length === 0 ? (
                  <ButtonLink href="/enquiries" variant="secondary">See your enquiries</ButtonLink>
                ) : undefined
              }
            />
          </Card>
        ) : (
          <div className="jw-offer-groups">
            {byEnquiry(visible).map((group) => (
              <section key={group.key} className="jw-offer-group" aria-label={`Quotes for ${group.title}`}>
                <div className="jw-offer-summary">
                  <span className="jw-record-tile jw-record-tile-blue" aria-hidden="true">
                    <Icon name="settings" size={1.9} />
                  </span>
                  <span className="jw-offer-summary-main">
                    <span className="jw-offer-summary-title">{group.title}</span>
                    <span className="jw-record-caption">
                      {group.reference ? <span className="mono">{group.reference}</span> : 'Enquiry'} • from JobWork
                    </span>
                    {group.sentAt ? (
                      <span className="jw-record-date">
                        <Icon name="calendar" size={1.15} />
                        {shortDate(group.sentAt)}
                      </span>
                    ) : null}
                  </span>
                  <span className="jw-count-badge">
                    {group.offers.length} {group.offers.length === 1 ? 'Quote' : 'Quotes'}
                  </span>
                </div>

                {group.offers.map((q) => (
                  <article key={q.quotationId} className="jw-offer" aria-labelledby={`offer-${q.quotationId}`}>
                    <div className="jw-offer-head">
                      <span className={`jw-record-tile ${OPTION_TINT[q.optionLabel]}`} aria-hidden="true">
                        <BrandGlyph size={30} />
                      </span>
                      <span className="jw-offer-name">
                        <span id={`offer-${q.quotationId}`} className="jw-offer-title">
                          JobWork · {OPTION_LABEL[q.optionLabel]}
                        </span>
                        <span className="jw-record-caption">
                          <span className="mono">{q.reference}</span> • v{q.versionNo}
                        </span>
                      </span>
                      <StatusChip tone={TONE[q.status]}>{q.statusLabel}</StatusChip>
                    </div>

                    <dl className="jw-offer-metrics">
                      <div>
                        <dt>Quote Amount</dt>
                        <dd className="jw-offer-amount numeric">{formatMoney({ amountMinor: q.totalMinor, currency: q.currency })}</dd>
                      </div>
                      <div>
                        <dt>Valid Until</dt>
                        <dd>
                          <Icon name="calendar" size={1.15} />
                          {q.status === 'quotation_ready' && q.daysToExpiry >= 0
                            ? `${q.daysToExpiry} day${q.daysToExpiry === 1 ? '' : 's'}`
                            : dayMonth(q.validityUntil)}
                        </dd>
                      </div>
                      <div>
                        <dt>Option</dt>
                        <dd>
                          <Icon name="layers" size={1.15} />
                          {OPTION_LABEL[q.optionLabel]}
                        </dd>
                      </div>
                    </dl>

                    <div className={q.status === 'quotation_ready' ? 'jw-action-pair' : undefined}>
                      <Link href={`/quotations/${q.quotationId}`} className="jw-cta-outline jw-cta-sm">
                        View Details<span className="jw-visually-hidden">, {q.reference}</span>
                      </Link>
                      {q.status === 'quotation_ready' ? (
                        <Link href={`/quotations/${q.quotationId}/accept`} className="jw-cta jw-cta-sm">
                          Accept Quote<span className="jw-visually-hidden">, {q.reference}</span>
                        </Link>
                      ) : null}
                    </div>
                  </article>
                ))}
              </section>
            ))}
          </div>
        )}
      </Stack>
    </Page>
  );
}
