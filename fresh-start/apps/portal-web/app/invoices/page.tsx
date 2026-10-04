'use client';

import { useEffect, useMemo, useState } from 'react';
import type { CustomerInvoice } from '@jobwork/contracts';
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
 * Invoices (prototype tile 13): what JobWork has billed you and what is still open.
 * Issued once, never edited; a correction would be a separate credit note.
 */

const TONE: Record<CustomerInvoice['status'], Tone> = {
  unpaid: 'attention',
  partially_paid: 'attention',
  paid: 'positive',
  void: 'neutral',
};

type Filter = 'all' | 'open' | 'paid';

export default function InvoicesPage() {
  const [invoices, setInvoices] = useState<CustomerInvoice[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [filter, setFilter] = useState<Filter>('all');

  useEffect(() => {
    api<{ invoices: CustomerInvoice[] }>('/invoices')
      .then((res) => setInvoices(res.invoices))
      .catch((err) => {
        if (err instanceof ApiError) setError(err);
      });
  }, []);

  const all = useMemo(() => invoices ?? [], [invoices]);
  const open = all.filter((i) => i.status === 'unpaid' || i.status === 'partially_paid');
  const visible = all.filter((i) => filter === 'all' || (filter === 'open' ? open.includes(i) : i.status === 'paid'));
  const outstanding = open.reduce((sum, i) => sum + i.openMinor, 0);
  const currency = all[0]?.currency ?? 'INR';

  return (
    <Page title="Invoices" back={{ href: '/', label: 'Back to home' }} description="What JobWork has billed you, and what is still open.">
      <Stack gap={4}>
        {error ? <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} /> : null}
        {all.length > 0 ? (
          <Card>
            <p style={{ font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>Outstanding</p>
            <p className="numeric" style={{ font: 'var(--text-title)' }}>{formatMoney({ amountMinor: outstanding, currency })}</p>
            <p style={{ font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>
              {open.length === 0 ? 'Nothing to pay right now.' : `${open.length} invoice${open.length === 1 ? '' : 's'} open`}
            </p>
          </Card>
        ) : null}
        <FilterChips
          label="Filter invoices"
          value={filter}
          options={[
            { value: 'all' as const, label: 'All', count: all.length },
            { value: 'open' as const, label: 'To pay', count: open.length },
            { value: 'paid' as const, label: 'Paid', count: all.filter((i) => i.status === 'paid').length },
          ]}
          onChange={setFilter}
        />
        {error ? null : invoices === null ? (
          <Card>
            <LoadingState label="Loading your invoices" />
          </Card>
        ) : visible.length === 0 ? (
          <Card>
            <EmptyState
              title={all.length === 0 ? 'No invoices yet' : 'Nothing matches'}
              detail={
                all.length === 0
                  ? 'JobWork invoices you against an order — an advance where the quotation says so, the balance before dispatch. Each invoice is issued once and never changes; corrections are separate credit notes.'
                  : 'Try another filter.'
              }
              action={
                all.length === 0 ? (
                  <ButtonLink href="/orders" variant="secondary">See your orders</ButtonLink>
                ) : undefined
              }
            />
          </Card>
        ) : (
          <RecordList>
            {visible.map((i) => (
              <RecordCard
                key={i.invoiceId}
                href={`/invoices/${i.invoiceId}`}
                reference={i.number}
                title={`${i.kind === 'advance' ? 'Advance' : i.kind === 'balance' ? 'Balance' : 'Final'} · ${i.orderTitle}`}
                caption={i.status === 'paid' ? `Order ${i.orderNumber}` : `Due ${i.dueAt.slice(0, 10)} · order ${i.orderNumber}`}
                figure={formatMoney({ amountMinor: i.status === 'paid' ? i.totalMinor : i.openMinor, currency: i.currency })}
                status={<StatusChip tone={TONE[i.status]}>{i.statusLabel}</StatusChip>}
              />
            ))}
          </RecordList>
        )}
      </Stack>
    </Page>
  );
}
