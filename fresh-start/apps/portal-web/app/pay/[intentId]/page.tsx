'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { CustomerPaymentIntent } from '@jobwork/contracts';
import { Button, Callout, Card, CommandButton, DescriptionList, ErrorState, LoadingState, Page, Stack, StatusChip, formatMoney } from '@jobwork/ui';
import { api, ApiError } from '../../../lib/api';

/**
 * Checkout. With a real provider this page hands over to the provider's hosted page
 * (no card data ever touches JobWork, doc 10 §7). With the development gateway it is a
 * stand-in for that page: its buttons ask the API to send the signed callback a provider
 * would send, through the same verified path — the browser itself never marks anything paid.
 */
const STATUS_WORDS: Record<CustomerPaymentIntent['status'], string> = {
  created: 'Waiting for payment',
  pending_customer: 'Waiting for payment',
  authorized: 'Being confirmed',
  captured: 'Paid',
  failed: 'Declined',
  cancelled: 'Cancelled',
  expired: 'Expired',
};

export default function CheckoutPage() {
  const intentId = useParams<{ intentId: string }>().intentId;
  const [intent, setIntent] = useState<CustomerPaymentIntent | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const load = useCallback(async () => {
    try {
      setIntent(await api<CustomerPaymentIntent>(`/payments/intents/${intentId}`));
    } catch (err) {
      if (err instanceof ApiError) setError(err);
    }
  }, [intentId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (intent && !intent.simulated && intent.status === 'pending_customer' && intent.checkoutUrl.startsWith('http')) {
      window.location.assign(intent.checkoutUrl);
    }
  }, [intent]);

  if (!intent) {
    return (
      <Page title="Payment" back={{ href: '/invoices', label: 'Back to invoices' }} width="narrow">
        {error ? <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} /> : <Card><LoadingState label="Preparing your payment" /></Card>}
      </Page>
    );
  }

  const amount = formatMoney({ amountMinor: intent.amountMinor, currency: intent.currency });
  const open = intent.status === 'pending_customer' || intent.status === 'created';

  async function simulate(outcome: 'success' | 'failure'): Promise<void> {
    setIntent(await api<CustomerPaymentIntent>(`/payments/intents/${intentId}/simulate`, { method: 'POST', body: { outcome } }));
  }

  return (
    <Page title="Payment" back={{ href: `/invoices/${intent.invoiceId}`, label: 'Back to the invoice' }} width="narrow">
      <Stack gap={4}>
        <Card title={`Pay ${amount}`}>
          <DescriptionList
            columns={1}
            items={[
              { label: 'To', value: 'JobWork' },
              { label: 'Invoice', value: intent.invoiceNumber, mono: true },
              { label: 'Order', value: intent.orderNumber, mono: true },
              { label: 'Amount', value: <strong>{amount}</strong>, numeric: true },
              { label: 'Status', value: <StatusChip tone={intent.status === 'captured' ? 'positive' : intent.status === 'failed' ? 'blocked' : 'progress'}>{STATUS_WORDS[intent.status]}</StatusChip> },
            ]}
          />
        </Card>

        {intent.status === 'captured' ? (
          <Callout tone="positive" title="Payment received">
            The payment provider confirmed it and the invoice is updated. <Link href={`/invoices/${intent.invoiceId}`}>See the invoice</Link>.
          </Callout>
        ) : intent.status === 'failed' ? (
          <Callout tone="blocked" title="The payment did not go through">
            Nothing was taken. <Link href={`/invoices/${intent.invoiceId}`}>Try again from the invoice</Link>.
          </Callout>
        ) : null}

        {open && intent.simulated ? (
          <Card title="Development payment gateway" description="No real money moves here. These buttons stand in for the provider's hosted page.">
            <Stack gap={3}>
              <CommandButton fullWidth receiptLabel="Paid" onCommand={() => simulate('success')}>
                Pay {amount}
              </CommandButton>
              <Button variant="ghost" fullWidth onClick={() => void simulate('failure')}>
                Simulate a declined payment
              </Button>
            </Stack>
          </Card>
        ) : null}

        {open && !intent.simulated ? (
          <Callout tone="progress" title="Taking you to the payment provider">
            If nothing happens, <a href={intent.checkoutUrl}>continue to payment</a>.
          </Callout>
        ) : null}
      </Stack>
    </Page>
  );
}
