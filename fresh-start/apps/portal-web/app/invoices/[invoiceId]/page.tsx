'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import type { CustomerInvoice, CustomerPaymentIntent } from '@jobwork/contracts';
import {
  Button,
  ButtonLink,
  Callout,
  Card,
  CommandButton,
  CopyableId,
  DescriptionList,
  ErrorState,
  LoadingState,
  Page,
  Stack,
  StatusChip,
  formatMoney,
  type Tone,
} from '@jobwork/ui';
import { api, ApiError } from '../../../lib/api';

/** One invoice: the frozen document, what is still open, and the one way to pay it. */

const TONE: Record<CustomerInvoice['status'], Tone> = {
  unpaid: 'attention',
  partially_paid: 'attention',
  paid: 'positive',
  void: 'neutral',
};

export default function InvoiceDetailPage() {
  const invoiceId = useParams<{ invoiceId: string }>().invoiceId;
  const router = useRouter();
  const [invoice, setInvoice] = useState<CustomerInvoice | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const load = useCallback(async () => {
    try {
      setInvoice(await api<CustomerInvoice>(`/invoices/${invoiceId}`));
    } catch (err) {
      if (err instanceof ApiError) setError(err);
    }
  }, [invoiceId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!invoice) {
    return (
      <Page title="Invoice" back={{ href: '/invoices', label: 'Back to invoices' }}>
        {error ? <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} /> : <Card><LoadingState label="Loading this invoice" /></Card>}
      </Page>
    );
  }

  const money = (minor: number): string => formatMoney({ amountMinor: minor, currency: invoice.currency });
  const payable = invoice.status === 'unpaid' || invoice.status === 'partially_paid';

  async function pay(): Promise<void> {
    const intent = await api<CustomerPaymentIntent>(`/invoices/${invoiceId}/pay`, { method: 'POST', idempotencyKey: `pay-${invoiceId}-${Date.now()}` });
    router.push(`/pay/${intent.paymentIntentId}`);
  }

  async function download(): Promise<void> {
    const doc = await api<{ html: string }>(`/invoices/${invoiceId}/document`);
    const url = URL.createObjectURL(new Blob([doc.html], { type: 'text/html' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${invoice?.number ?? 'invoice'}.html`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Page
      title="Invoice"
      back={{ href: '/invoices', label: 'Back to invoices' }}
      meta={
        <>
          <span className="mono">{invoice.number}</span>
          <StatusChip tone={TONE[invoice.status]}>{invoice.statusLabel}</StatusChip>
        </>
      }
    >
      <Stack gap={4}>
        {invoice.pendingPayment && payable ? (
          <Callout tone="progress" title="A payment is in progress">
            We are waiting for the payment provider to confirm. The invoice updates as soon as it does — you do not need to pay again.
          </Callout>
        ) : null}

        <Card title={`${invoice.kind === 'advance' ? 'Advance' : invoice.kind === 'balance' ? 'Balance' : 'Final'} invoice from JobWork`}>
          <DescriptionList
            columns={1}
            items={[
              { label: 'Order', value: <Link href={`/orders/${invoice.orderId}`}>{invoice.orderNumber} · {invoice.orderTitle}</Link> },
              ...invoice.lines.map((l) => ({ label: l.description, value: money(l.amountMinor), numeric: true })),
              { label: 'Taxable value', value: money(invoice.subtotalMinor), numeric: true },
              { label: `GST (${(invoice.taxRateBp / 100).toFixed(0)}%)`, value: money(invoice.taxMinor), numeric: true },
              { label: 'Total', value: <strong>{money(invoice.totalMinor)}</strong>, numeric: true },
              { label: 'Received', value: money(invoice.paidMinor), numeric: true },
              { label: 'Still to pay', value: <strong>{money(invoice.openMinor)}</strong>, numeric: true },
              { label: 'Issued', value: invoice.issuedAt.slice(0, 10) },
              { label: 'Due', value: invoice.dueAt.slice(0, 10) },
            ]}
          />
          <div style={{ marginTop: 'var(--space-3)' }}>
            <CopyableId label="Content hash" value={invoice.contentHash} />
          </div>
        </Card>

        {payable ? (
          <Card>
            <Stack gap={3}>
              <CommandButton fullWidth receiptLabel="Opening payment" onCommand={pay}>
                Pay {money(invoice.openMinor)}
              </CommandButton>
              <p style={{ font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>
                Or pay by bank transfer quoting <span className="mono">{invoice.number}</span>. Payments go to JobWork only — never to a workshop.
              </p>
            </Stack>
          </Card>
        ) : null}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)' }}>
          <Button variant="secondary" fullWidth onClick={() => void download()}>
            Download
          </Button>
          <ButtonLink href="/payments" variant="secondary" fullWidth>Payment history</ButtonLink>
        </div>
      </Stack>
    </Page>
  );
}
