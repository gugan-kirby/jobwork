'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { CustomerInvoice, CustomerPaymentIntent } from '@jobwork/contracts';
import {
  ButtonLink,
  Card,
  CommandButton,
  EmptyState,
  ErrorState,
  FilterChips,
  Icon,
  IconTextInput,
  LoadingState,
  Page,
  Select,
  Stack,
  StatusChip,
  formatMoney,
  type Tone,
} from '@jobwork/ui';
import { api, ApiError } from '../../lib/api';
import { dueWords, fmt, isOpen } from '../../lib/invoice-due';

/**
 * Invoices (prototype tile 13): what JobWork has billed you and what is still open.
 * Issued once, never edited; a correction would be a separate credit note.
 *
 * VF-13 (reference screen 13): tab root with search and sort; All · Unpaid · Paid ·
 * Overdue; each invoice a card whose body opens the invoice and, while it is open, a due
 * strip with Pay Now beside it (a separate control, never nested in the card's link).
 * Payment goes to JobWork through the existing intent flow (`F-08.4`).
 */

const TONE: Record<CustomerInvoice['status'], Tone> = {
  unpaid: 'attention',
  partially_paid: 'attention',
  paid: 'positive',
  void: 'neutral',
};

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
            {visible.map((i) => {
              const due = isOpen(i) ? dueWords(i, now) : null;
              const paid = i.status === 'paid';
              return (
                <article key={i.invoiceId} className="jw-invoice">
                  <Link href={`/invoices/${i.invoiceId}`} className="jw-record jw-record-rich jw-invoice-main">
                    <span className={`jw-record-tile ${paid ? 'jw-record-tile-green' : 'jw-record-tile-sky'}`} aria-hidden="true">
                      <Icon name={paid ? 'checkCircle' : 'invoice'} size={1.9} />
                    </span>
                    <span className="jw-record-main">
                      <span className="jw-record-top">
                        <span className="jw-record-title">{i.number}</span>
                        <StatusChip tone={TONE[i.status]}>{i.statusLabel}</StatusChip>
                      </span>
                      <span className="jw-record-caption">
                        Order #<span className="mono">{i.orderNumber}</span> •{' '}
                        {i.kind === 'advance' ? 'Advance' : i.kind === 'balance' ? 'Balance' : i.kind === 'change' ? 'Change' : 'Final'}
                      </span>
                      <span className="jw-record-foot">
                        <span className="jw-record-date">
                          <Icon name="calendar" size={1.15} />
                          {fmt(i.issuedAt)}
                        </span>
                        <span className="jw-invoice-amount numeric">
                          {formatMoney({ amountMinor: paid ? i.totalMinor : i.openMinor, currency: i.currency })}
                        </span>
                      </span>
                    </span>
                    <span className="jw-record-chevron">
                      <Icon name="chevron" size={1.4} />
                    </span>
                  </Link>
                  {due ? (
                    <div className={due.overdue ? 'jw-due jw-due-overdue' : 'jw-due'}>
                      <span className="jw-due-text">
                        <Icon name="clock" size={1.2} />
                        {due.text}
                      </span>
                      {i.pendingPayment ? (
                        <span className="jw-due-text">Verifying payment…</span>
                      ) : (
                        <CommandButton size="sm" receiptLabel="Opening payment" onCommand={() => pay(i.invoiceId)}>
                          Pay Now<span className="jw-visually-hidden">, {i.number}</span>
                        </CommandButton>
                      )}
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </Stack>
    </Page>
  );
}
