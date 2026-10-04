'use client';

import { useEffect, useMemo, useState } from 'react';
import type { CustomerQuoteListItem } from '@jobwork/contracts';
import {
  ButtonLink,
  Card,
  EmptyState,
  ErrorState,
  FilterChips,
  LoadingState,
  Page,
  RecordCard,
  RecordList,
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
      title="Quotations"
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
          <RecordList>
            {visible.map((q) => (
              <RecordCard
                key={q.quotationId}
                href={`/quotations/${q.quotationId}`}
                reference={q.reference}
                title={q.enquiryTitle}
                caption={`${OPTION_LABEL[q.optionLabel]} option · v${q.versionNo}${
                  q.status === 'quotation_ready'
                    ? q.daysToExpiry >= 0
                      ? ` · valid ${q.daysToExpiry} more day${q.daysToExpiry === 1 ? '' : 's'}`
                      : ' · validity passed'
                    : ''
                }`}
                figure={formatMoney({ amountMinor: q.totalMinor, currency: q.currency })}
                status={<StatusChip tone={TONE[q.status]}>{q.statusLabel}</StatusChip>}
              />
            ))}
          </RecordList>
        )}
      </Stack>
    </Page>
  );
}
