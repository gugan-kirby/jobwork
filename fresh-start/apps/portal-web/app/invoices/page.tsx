'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { CustomerInvoice, CustomerPaymentIntent } from '@jobwork/contracts';
import {
  ButtonLink,
  Card,
  EmptyState,
  ErrorState,
  FilterChips,
  Icon,
  IconTextInput,
  LoadingState,
  Page,
  Select,
  Stack,
  formatMoney,
} from '@jobwork/ui';
import { api, ApiError } from '../../lib/api';
import { isOpen } from '../../lib/invoice-due';
import { InvoiceCard } from '../invoice-card';

/**
 * Invoices (prototype tile 13): what JobWork has billed you and what is still open.
 * Issued once, never edited; a correction would be a separate credit note.
 *
 * VF-13 (reference screen 13): tab root with search and sort; All · Unpaid · Paid ·
 * Overdue; each invoice a card whose body opens the invoice and, while it is open, a due
 * strip with Pay Now beside it (a separate control, never nested in the card's link).
 * Payment goes to JobWork through the existing intent flow (`F-08.4`).
 */

type Filter = 'all' | 'open' | 'paid' | 'overdue';

type Sort = 'newest' | 'oldest' | 'amount';

const SORTS: Array<{ value: Sort; label: string }> = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'amount', label: 'Amount, highest first' },
];

export default function InvoicesPage() {
  const [invoices, setInvoices] = useState<CustomerInvoice[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<Sort>('newest');
  const [showOptions, setShowOptions] = useState(false);
  const router = useRouter();

  useEffect(() => {
    api<{ invoices: CustomerInvoice[] }>('/invoices')
      .then((res) => setInvoices(res.invoices))
      .catch((err) => {
        if (err instanceof ApiError) setError(err);
      });
  }, []);

  const all = useMemo(() => invoices ?? [], [invoices]);
  const now = Date.now();
  const open = all.filter(isOpen);
  const overdue = open.filter((i) => Date.parse(i.dueAt) < now);
  const needle = search.trim().toLowerCase();
  const visible = all
    .filter((i) =>
      filter === 'all' ? true : filter === 'open' ? isOpen(i) : filter === 'overdue' ? overdue.includes(i) : i.status === 'paid',
    )
    .filter((i) => !needle || `${i.number} ${i.orderNumber} ${i.orderTitle}`.toLowerCase().includes(needle))
    .sort((a, b) =>
      sort === 'amount' ? b.totalMinor - a.totalMinor : sort === 'oldest' ? a.issuedAt.localeCompare(b.issuedAt) : b.issuedAt.localeCompare(a.issuedAt),
    );
  const outstanding = open.reduce((sum, i) => sum + i.openMinor, 0);
  const currency = all[0]?.currency ?? 'INR';

  async function pay(invoiceId: string): Promise<void> {
    const intent = await api<CustomerPaymentIntent>(`/invoices/${invoiceId}/pay`, { method: 'POST', idempotencyKey: `pay-${invoiceId}-${Date.now()}` });
    router.push(`/pay/${intent.paymentIntentId}`);
  }

  return (
    <Page
      title="Invoices"
      description={
        open.length > 0
          ? `View and manage your invoices and payments · ${formatMoney({ amountMinor: outstanding, currency })} outstanding`
          : 'View and manage your invoices and payments'
      }
    >
      <Stack gap={4}>
        {error ? <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} /> : null}
        <div className="jw-search-row">
          <IconTextInput icon="search" label="Search invoices…" type="search" value={search} onChange={(event) => setSearch(event.target.value)} />
          <button
            type="button"
            className="jw-square-button"
            aria-label="Sort invoices"
            aria-expanded={showOptions}
            aria-controls="invoice-sort"
            onClick={() => setShowOptions((v) => !v)}
          >
            <Icon name="sliders" size={1.5} />
          </button>
        </div>
        {showOptions ? (
          <div id="invoice-sort">
            <Select label="Sort by" value={sort} options={SORTS} onChange={(event) => setSort(event.target.value as Sort)} />
          </div>
        ) : null}
        <FilterChips
          label="Filter invoices"
          value={filter}
          options={[
            { value: 'all' as const, label: 'All', count: all.length },
            { value: 'open' as const, label: 'Unpaid', count: open.length },
            { value: 'paid' as const, label: 'Paid', count: all.filter((i) => i.status === 'paid').length },
            { value: 'overdue' as const, label: 'Overdue', count: overdue.length },
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
          <div className="jw-record-list">
            {visible.map((i) => (
              <InvoiceCard key={i.invoiceId} invoice={i} now={now} onPay={pay} />
            ))}
          </div>
        )}
      </Stack>
    </Page>
  );
}
