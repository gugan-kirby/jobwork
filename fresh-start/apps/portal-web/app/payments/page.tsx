'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { CustomerInvoice, CustomerPaymentIntent, CustomerPayments } from '@jobwork/contracts';
import {
  ButtonLink,
  Callout,
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
} from '@jobwork/ui';
import { api, ApiError } from '../../lib/api';
import { fmt, isOpen } from '../../lib/invoice-due';
import { InvoiceCard } from '../invoice-card';

type Filter = 'all' | 'paid' | 'pending' | 'refunds';

/**
 * Payments (prototype tile 14, corrected per D-03): every payment you made to JobWork,
 * matched to its invoice. There is no wallet and no "add money": an overpayment stays
 * yours as visible credit, applied to a later invoice or refunded on request.
 *
 * VF-14 (reference screen 14): tab root; a summary of what was paid and what is pending;
 * All · Paid · Pending · Refunds. Pending is the open invoices (with Pay Now), so the page
 * answers both "what have I paid" and "what do I still owe JobWork". Nothing is a balance
 * held by JobWork, and there is no "add money".
 */
export default function PaymentsPage() {
  const [data, setData] = useState<CustomerPayments | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [invoices, setInvoices] = useState<CustomerInvoice[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const router = useRouter();

  useEffect(() => {
    api<CustomerPayments>('/payments')
      .then(setData)
      .catch((err) => {
        if (err instanceof ApiError) setError(err);
      });
    api<{ invoices: CustomerInvoice[] }>('/invoices')
      .then((res) => setInvoices(res.invoices))
      .catch(() => setInvoices([]));
  }, []);

  async function pay(invoiceId: string): Promise<void> {
    const intent = await api<CustomerPaymentIntent>(`/invoices/${invoiceId}/pay`, { method: 'POST', idempotencyKey: `pay-${invoiceId}-${Date.now()}` });
    router.push(`/pay/${intent.paymentIntentId}`);
  }

  const now = Date.now();
  const payments = data?.payments ?? [];
  const paidEntries = payments.filter((p) => p.kind === 'payment');
  const refundEntries = payments.filter((p) => p.kind !== 'payment');
  const pending = invoices.filter(isOpen);
  const currency = data?.currency ?? 'INR';
  const totalPaid = paidEntries.reduce((sum, p) => sum + p.amountMinor, 0);
  const totalPending = pending.reduce((sum, i) => sum + i.openMinor, 0);
  const listed = filter === 'paid' ? paidEntries : filter === 'refunds' ? refundEntries : filter === 'pending' ? [] : payments;
  const showPending = filter === 'all' || filter === 'pending';

  return (
    <Page title="Payments" description="Track your transactions, payments and refunds">
      <Stack gap={4}>
        {error ? <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} /> : null}
        {data ? (
          <section className="jw-tinted-card jw-pay-summary" aria-label="Payment summary">
            <div>
              <span className="jw-record-tile jw-record-tile-blue" aria-hidden="true">
                <Icon name="payment" size={1.7} />
              </span>
              <span>
                <span className="jw-summary-label">Total Paid</span>
                <span className="jw-pay-figure numeric">{formatMoney({ amountMinor: totalPaid, currency })}</span>
              </span>
            </div>
            <div>
              <span className="jw-record-tile jw-record-tile-violet" aria-hidden="true">
                <Icon name="clock" size={1.7} />
              </span>
              <span>
                <span className="jw-summary-label">Pending Payment</span>
                <span className="jw-pay-figure numeric">{formatMoney({ amountMinor: totalPending, currency })}</span>
              </span>
            </div>
          </section>
        ) : null}
        <FilterChips
          label="Filter payments"
          value={filter}
          options={[
            { value: 'all' as const, label: 'All', count: payments.length + pending.length },
            { value: 'paid' as const, label: 'Paid', count: paidEntries.length },
            { value: 'pending' as const, label: 'Pending', count: pending.length },
            { value: 'refunds' as const, label: 'Refunds', count: refundEntries.length },
          ]}
          onChange={setFilter}
        />
        {data && data.unappliedCreditMinor > 0 ? (
          <Callout tone="progress" title={`${formatMoney({ amountMinor: data.unappliedCreditMinor, currency: data.currency })} of your money is unapplied`}>
            You paid more than an invoice asked for. It stays yours: JobWork finance applies it to your next invoice or refunds it on request. <Link href="/help">Ask for a refund</Link>.
          </Callout>
        ) : null}
        {error ? null : data === null ? (
          <Card>
            <LoadingState label="Loading your payments" />
          </Card>
        ) : payments.length === 0 && pending.length === 0 ? (
          <Card>
            <EmptyState
              title="No payments yet"
              detail="You pay JobWork against an invoice, through the payment gateway or by bank transfer with the invoice reference. Nothing is held in a wallet and nothing is paid to a workshop directly."
              action={
                <ButtonLink href="/invoices" variant="secondary">See your invoices</ButtonLink>
              }
            />
          </Card>
        ) : (
          <div className="jw-record-list">
            {showPending ? pending.map((i) => <InvoiceCard key={i.invoiceId} invoice={i} now={now} onPay={pay} />) : null}
            {listed.map((p) => {
              const refund = p.kind !== 'payment';
              return (
                <div key={p.transactionId} className="jw-record jw-record-rich jw-record-static">
                  <span className={`jw-record-tile ${refund ? 'jw-record-tile-violet' : 'jw-record-tile-green'}`} aria-hidden="true">
                    <Icon name={refund ? 'back' : 'checkCircle'} size={1.9} />
                  </span>
                  <span className="jw-record-main">
                    <span className="jw-record-top">
                      <span className="jw-record-title">{p.invoiceNumber ?? p.label}</span>
                      <StatusChip tone={refund ? 'special' : 'positive'}>{p.kind === 'payment' ? 'Paid' : p.kind === 'refund' ? 'Refund' : 'Credit'}</StatusChip>
                    </span>
                    <span className="jw-record-caption">
                      {p.orderNumber ? (
                        <>
                          Order #<span className="mono">{p.orderNumber}</span> •{' '}
                        </>
                      ) : null}
                      <span className="mono">{p.reference.slice(0, 18)}</span>
                    </span>
                    <span className="jw-record-foot">
                      <span className="jw-record-date">
                        <Icon name="calendar" size={1.15} />
                        {fmt(p.occurredAt)}
                      </span>
                      <span className="jw-invoice-amount numeric">{formatMoney({ amountMinor: p.amountMinor, currency: p.currency })}</span>
                    </span>
                  </span>
                </div>
              );
            })}
            {filter === 'pending' && pending.length === 0 ? (
              <Card>
                <EmptyState title="Nothing pending" detail="Every invoice JobWork has issued you is paid." />
              </Card>
            ) : null}
          </div>
        )}
      </Stack>
    </Page>
  );
}
