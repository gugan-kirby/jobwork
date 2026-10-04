'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { Quote } from '@jobwork/contracts';
import { Card, DataTable, ErrorState, Page, Select, Stack, StatusChip, formatMoney, type Column, type Tone } from '@jobwork/ui';
import { api, ApiError } from '../../lib/api';

/** Every customer quotation and where it stands (F-07.5). */

const TONE: Record<Quote['status'], Tone> = {
  draft: 'neutral',
  internal_approval: 'attention',
  approved: 'progress',
  sent: 'progress',
  revision_requested: 'attention',
  accepted: 'positive',
  rejected: 'blocked',
  expired: 'neutral',
  withdrawn: 'neutral',
};

const FILTERS = [
  { value: '', label: 'All' },
  { value: 'draft', label: 'Draft' },
  { value: 'internal_approval', label: 'Awaiting approval' },
  { value: 'approved', label: 'Approved, not sent' },
  { value: 'sent', label: 'With the customer' },
  { value: 'revision_requested', label: 'Revision requested' },
  { value: 'accepted', label: 'Accepted' },
];

export default function QuotesPage(): React.JSX.Element {
  const [rows, setRows] = useState<Quote[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [status, setStatus] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api<{ quotes: Quote[] }>(`/quotes${status ? `?status=${status}` : ''}`);
      setRows(res.quotes);
    } catch (err) {
      if (err instanceof ApiError) setError(err);
      setRows([]);
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  const columns: Array<Column<Quote>> = [
    { key: 'ref', header: 'Quotation', render: (q) => <Link href={`/quotes/${q.quoteId}`}>{q.reference ?? `Draft (${q.optionLabel})`}</Link> },
    { key: 'customer', header: 'Customer', render: (q) => q.customerDisplayName },
    { key: 'enquiry', header: 'Enquiry', render: (q) => <Link href={`/intake/${q.enquiryId}`}>{q.enquiryReference ?? q.enquiryTitle}</Link> },
    { key: 'option', header: 'Option', render: (q) => q.optionLabel },
    {
      key: 'total',
      header: 'Total',
      numeric: true,
      render: (q) => {
        const v = q.versions.find((x) => x.versionNo === q.currentVersionNo);
        return v ? formatMoney({ amountMinor: v.totalMinor, currency: v.currency }) : '—';
      },
    },
    { key: 'version', header: 'Version', numeric: true, render: (q) => q.currentVersionNo },
    { key: 'status', header: 'Status', render: (q) => <StatusChip tone={TONE[q.status]}>{q.status.replace(/_/g, ' ')}</StatusChip> },
  ];

  return (
    <Page
      title="Customer quotations"
      description="JobWork's sell-side offers, version by version."
      width="wide"
      actions={<Select label="Show" value={status} options={FILTERS} onChange={(e) => setStatus(e.target.value)} />}
    >
      <Stack gap={4}>
        {error ? <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} /> : null}
        <Card flush>
          <DataTable
            caption="Customer quotations"
            columns={columns}
            rows={rows}
            rowKey={(q) => q.quoteId}
            loadingLabel="Loading quotations"
            stackTitle={(q) => q.reference ?? `Draft ${q.optionLabel}`}
            empty={{ title: 'No quotations', detail: 'A quotation is drafted from an approved cost sheet on an award.' }}
          />
        </Card>
      </Stack>
    </Page>
  );
}
