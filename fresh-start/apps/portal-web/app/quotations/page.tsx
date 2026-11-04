'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { CustomerQuoteListItem } from '@jobwork/contracts';
import { Card, ButtonLink, EmptyState, ErrorState, Icon, LoadingState, Page, Stack, StatusChip } from '@jobwork/ui';
import { api, ApiError } from '../../lib/api';
import { displayMoney, unitLabel } from '../../lib/enquiry-facts';

/**
 * Quotes Received (VF-09, VF-18, reference screen 09, ADR-0007): one summary per enquiry,
 * then a card per quote naming its supplier, with city, verified state and rating, the
 * amount, lead time and quantity, View Details and Accept Quote. The amount is JobWork's
 * price; a rating is earned and a supplier with none reads "New". Accept goes to the
 * acceptance page, which carries the approval and terms checks.
 */

type Group = { key: string; enquiryId: string; title: string; reference: string | null; sentAt: string | null; offers: CustomerQuoteListItem[] };

const shortDate = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

/** Offers grouped by the enquiry they answer, newest group first. */
function byEnquiry(list: CustomerQuoteListItem[]): Group[] {
  const groups = new Map<string, Group>();
  for (const q of list) {
    const group = groups.get(q.enquiryId) ?? { key: q.enquiryId, enquiryId: q.enquiryId, title: q.enquiryTitle, reference: q.enquiryReference, sentAt: null, offers: [] };
    group.offers.push(q);
    if (q.sentAt && (!group.sentAt || q.sentAt > group.sentAt)) group.sentAt = q.sentAt;
    groups.set(q.enquiryId, group);
  }
  return [...groups.values()].sort((a, b) => (b.sentAt ?? '').localeCompare(a.sentAt ?? ''));
}

const TINTS = ['jw-record-tile-green', 'jw-record-tile-violet', 'jw-record-tile-orange'];

export default function QuotationsPage() {
  const [quotations, setQuotations] = useState<CustomerQuoteListItem[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    api<{ quotations: CustomerQuoteListItem[] }>('/quotations')
      .then((res) => setQuotations(res.quotations))
      .catch((err) => {
        if (err instanceof ApiError) setError(err);
      });
  }, []);

  const all = quotations ?? [];

  return (
    <Page title="Quotes Received" back={{ href: '/', label: 'Back to home' }}>
      <Stack gap={4}>
        {error ? <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} /> : null}

        {error ? null : quotations === null ? (
          <Card>
            <LoadingState label="Loading your quotes" />
          </Card>
        ) : all.length === 0 ? (
          <Card>
            <EmptyState
              title="No quotes yet"
              detail="Quotes follow the review of an enquiry. When one is ready it appears here."
              action={<ButtonLink href="/enquiries" variant="secondary">See your enquiries</ButtonLink>}
            />
          </Card>
        ) : (
          <div className="jw-offer-groups">
            {byEnquiry(all).map((group) => (
              <section key={group.key} className="jw-offer-group" aria-label={`Quotes for ${group.title}`}>
                <div className="jw-offer-summary">
                  <span className="jw-record-tile jw-record-tile-blue" aria-hidden="true">
                    <Icon name="settings" size={1.9} />
                  </span>
                  <span className="jw-offer-summary-main">
                    <span className="jw-offer-summary-title">{group.title}</span>
                    {group.reference ? <span className="jw-record-caption mono">{group.reference}</span> : null}
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

                <nav className="jw-underline-tabs" aria-label={`Quotes and details for ${group.title}`}>
                  <span aria-current="page">Quotes ({group.offers.length})</span>
                  <Link href={`/enquiries/${group.enquiryId}`}>Enquiry Details</Link>
                </nav>

                {group.offers.map((q, index) => {
                  const name = q.supplier?.name ?? 'JobWork';
                  const open = q.status === 'quotation_ready';
                  return (
                    <article key={q.quotationId} className="jw-offer" aria-labelledby={`offer-${q.quotationId}`}>
                      <div className="jw-offer-head">
                        <span className={`jw-record-tile ${TINTS[index % TINTS.length]}`} aria-hidden="true">
                          <Icon name="factory" size={1.9} />
                        </span>
                        <span className="jw-offer-name">
                          <span id={`offer-${q.quotationId}`} className="jw-offer-title">
                            {name}
                          </span>
                          {q.supplier ? (
                            <span className="jw-supplier-line">
                              {q.supplier.city ? (
                                <span>
                                  <Icon name="location" size={1.1} /> {[q.supplier.city, q.supplier.state].filter(Boolean).join(', ')}
                                </span>
                              ) : null}
                              <span className="jw-rating">
                                <Icon name="star" size={1.1} />{' '}
                                {q.supplier.ratingAverage !== null ? `${q.supplier.ratingAverage.toFixed(1)} (${q.supplier.ratingCount})` : 'New'}
                              </span>
                            </span>
                          ) : null}
                        </span>
                        {q.supplier?.verified && open ? (
                          <StatusChip tone="positive" silent>
                            Verified
                          </StatusChip>
                        ) : open ? null : (
                          <StatusChip tone={q.status === 'accepted' ? 'positive' : 'neutral'}>{q.statusLabel}</StatusChip>
                        )}
                      </div>

                      <dl className="jw-offer-metrics">
                        <div>
                          <dt>Quote Amount</dt>
                          <dd className="jw-offer-amount numeric">{displayMoney(q.totalMinor, q.currency)}</dd>
                        </div>
                        <div>
                          <dt>Lead Time</dt>
                          <dd>
                            <Icon name="calendar" size={1.15} />
                            {q.deliveryLeadDays} Days
                          </dd>
                        </div>
                        <div>
                          <dt>Min. Qty</dt>
                          <dd>
                            <Icon name="layers" size={1.15} />
                            {q.quantity ?? '—'} {unitLabel(q.unit)}
                          </dd>
                        </div>
                      </dl>

                      <div className="jw-action-pair">
                        <Link href={`/quotations/${q.quotationId}`} className="jw-cta-outline jw-cta-sm">
                          View Details<span className="jw-visually-hidden">, {name}</span>
                        </Link>
                        {open ? (
                          <Link href={`/quotations/${q.quotationId}/accept`} className="jw-cta jw-cta-sm">
                            Accept Quote<span className="jw-visually-hidden">, {name}</span>
                          </Link>
                        ) : (
                          <span className="jw-cta jw-cta-sm jw-cta-off">{q.statusLabel}</span>
                        )}
                      </div>
                    </article>
                  );
                })}
              </section>
            ))}
          </div>
        )}
      </Stack>
    </Page>
  );
}
