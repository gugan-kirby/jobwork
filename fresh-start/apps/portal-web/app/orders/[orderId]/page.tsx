'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import type { CustomerOrder, CustomerPaymentIntent } from '@jobwork/contracts';
import {
  ActionNeededCard,
  ButtonLink,
  Callout,
  Card,
  CommandButton,
  CopyableId,
  DescriptionList,
  ErrorState,
  Icon,
  LoadingState,
  Page,
  Stack,
  StatusChip,
  formatMoney,
  type Tone,
} from '@jobwork/ui';
import { api, ApiError } from '../../../lib/api';
import { ThreadPanel } from '../../thread-panel';
import { ChangesPanel } from './changes-panel';

/**
 * Order detail and tracking (prototype tiles 11–12, corrected per doc 06 §13): the next
 * step and whose it is, a curated timeline in the customer's words, what was ordered,
 * and the payment schedule with its invoices. No supplier, no workshop location, no
 * promised date before the order is released.
 */

const TONE: Record<CustomerOrder['status'], Tone> = {
  payment_needed: 'attention',
  technical_confirmation: 'progress',
  manufacturing_in_progress: 'progress',
  quality_review: 'progress',
  final_checks: 'progress',
  on_the_way: 'progress',
  delivery_confirmation_needed: 'attention',
  completed: 'positive',
  cancelled: 'neutral',
};

const STEP_TONE: Record<'done' | 'current' | 'pending', { fg: string; bg: string; border: string }> = {
  done: { fg: 'var(--status-positive-fg)', bg: 'var(--status-positive-bg)', border: 'var(--status-positive-border)' },
  current: { fg: 'var(--status-progress-fg)', bg: 'var(--status-progress-bg)', border: 'var(--status-progress-border)' },
  pending: { fg: 'var(--color-text-muted)', bg: 'var(--color-surface)', border: 'var(--color-border)' },
};

function OrderDetail() {
  const orderId = useParams<{ orderId: string }>().orderId;
  const justAccepted = useSearchParams().get('accepted') === '1';
  const router = useRouter();
  const [order, setOrder] = useState<CustomerOrder | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const load = useCallback(async () => {
    try {
      setOrder(await api<CustomerOrder>(`/orders/${orderId}`));
      setError(null);
    } catch (err) {
      if (err instanceof ApiError) setError(err);
    }
  }, [orderId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!order) {
    return (
      <Page title="Order" back={{ href: '/orders', label: 'Back to orders' }}>
        {error ? <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} /> : <Card><LoadingState label="Loading this order" /></Card>}
      </Page>
    );
  }

  const money = (minor: number): string => formatMoney({ amountMinor: minor, currency: order.currency });
  const openInvoice = order.invoices.find((i) => i.status === 'unpaid' || i.status === 'partially_paid');

  async function pay(invoiceId: string): Promise<void> {
    const intent = await api<CustomerPaymentIntent>(`/invoices/${invoiceId}/pay`, { method: 'POST', idempotencyKey: `pay-${invoiceId}-${Date.now()}` });
    router.push(`/pay/${intent.paymentIntentId}`);
  }

  return (
    <Page
      title="Order details"
      back={{ href: '/orders', label: 'Back to orders' }}
      meta={
        <>
          <span className="mono">{order.number}</span>
          <StatusChip tone={TONE[order.status]}>{order.statusLabel}</StatusChip>
        </>
      }
    >
      <Stack gap={4}>
        {justAccepted ? (
          <Callout tone="positive" title="Order placed">
            You accepted {order.quotation.reference} revision {order.quotation.versionNo}. This order is bound to exactly that revision and its terms.
          </Callout>
        ) : null}

        <ActionNeededCard
          title={order.nextStep.label}
          detail={order.nextStep.detail}
          owner={order.nextStep.owner === 'you' ? 'You' : 'JobWork'}
          action={
            order.nextStep.owner === 'you' && openInvoice ? (
              <CommandButton size="sm" receiptLabel="Opening payment" onCommand={() => pay(openInvoice.invoiceId)}>
                Pay {money(openInvoice.openMinor)}
              </CommandButton>
            ) : undefined
          }
        />

        <Card title="Progress">
          <ol aria-label="Order progress" style={{ listStyle: 'none', display: 'grid', gap: 'var(--space-3)' }}>
            {order.timeline.map((step) => {
              const tone = STEP_TONE[step.state];
              return (
                <li key={step.key} aria-current={step.state === 'current' ? 'step' : undefined} style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'flex-start' }}>
                  <span
                    aria-hidden="true"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: 'var(--space-6)',
                      height: 'var(--space-6)',
                      flex: 'none',
                      borderRadius: 'var(--radius-pill)',
                      border: `var(--hairline) solid ${tone.border}`,
                      background: tone.bg,
                      color: tone.fg,
                    }}
                  >
                    <Icon name={step.state === 'done' ? 'check' : step.state === 'current' ? 'clock' : 'info'} size={0.9} />
                  </span>
                  <span style={{ flex: 1 }}>
                    <span style={{ display: 'block', font: step.state === 'current' ? 'var(--text-body-strong)' : 'var(--text-body)', color: step.state === 'pending' ? 'var(--color-text-muted)' : 'var(--color-text)' }}>
                      {step.label}
                      <span className="jw-visually-hidden"> — {step.state === 'done' ? 'done' : step.state === 'current' ? 'in progress' : 'not started'}</span>
                    </span>
                    {step.at ? <span style={{ display: 'block', font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>{step.at.slice(0, 10)}</span> : null}
                    {step.detail ? <span style={{ display: 'block', font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>{step.detail}</span> : null}
                  </span>
                </li>
              );
            })}
          </ol>
        </Card>

        {order.scheduleUnderReview ? (
          <Callout tone="attention" title="Schedule under review">
            JobWork is reviewing the production schedule. We will confirm with you before any change to your delivery date.
          </Callout>
        ) : null}

        {order.progress.length > 0 ? (
          <Card title="Verified checkpoints" description="Each one checked by JobWork quality before it appears here.">
            <ul style={{ listStyle: 'none', display: 'grid', gap: 'var(--space-2)' }}>
              {order.progress.map((p) => (
                <li key={`${p.label}-${p.at}`} style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-3)' }}>
                  <span style={{ display: 'inline-flex', gap: 'var(--space-2)', alignItems: 'center' }}>
                    <span aria-hidden="true" style={{ color: 'var(--status-positive-fg)' }}>
                      <Icon name="check" size={0.9} />
                    </span>
                    {p.label}
                  </span>
                  <span style={{ font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>{p.at.slice(0, 10)}</span>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        <Card title="What you ordered">
          <Stack gap={2}>
            {order.lines.map((line) => (
              <div key={line.lineNo} style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-3)' }}>
                <span>
                  {line.description}
                  <span style={{ display: 'block', font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>
                    {line.quantity} {line.unit === 'piece' ? 'Nos' : line.unit} × {money(line.unitPriceMinor)}
                  </span>
                </span>
                <span className="numeric">{money(line.amountMinor)}</span>
              </div>
            ))}
          </Stack>
          <div style={{ marginTop: 'var(--space-3)' }}>
            <DescriptionList
              columns={1}
              items={[
                { label: 'Order total (incl. GST)', value: <strong>{money(order.totalMinor)}</strong>, numeric: true },
                { label: 'Delivery', value: order.expectedDeliveryAt ? `Expected by ${order.expectedDeliveryAt}` : `${order.deliveryLeadDays} days from release` },
                { label: 'Quotation', value: <Link href={`/quotations/${order.quotation.quotationId}`}>{order.quotation.reference} v{order.quotation.versionNo}</Link> },
                ...(order.enquiry.reference ? [{ label: 'Enquiry', value: <Link href={`/enquiries/${order.enquiry.enquiryId}`}>{order.enquiry.reference}</Link> }] : []),
                { label: 'Accepted', value: `${order.acceptedAt.slice(0, 10)} by ${order.acceptedBy}` },
              ]}
            />
          </div>
        </Card>

        <Card title="Payment schedule" description="Paid to JobWork only. Each invoice is issued once and never changes.">
          <Stack gap={3}>
            {order.installments.map((installment) => {
              const invoice = order.invoices.find((i) => i.invoiceId === installment.invoiceId);
              return (
                <div key={installment.installmentId} style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap' }}>
                  <span>
                    <span style={{ display: 'block', font: 'var(--text-body-strong)' }}>{installment.label}</span>
                    <span style={{ font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>
                      {invoice ? (
                        <>
                          <Link href={`/invoices/${invoice.invoiceId}`}>{invoice.number}</Link> · {invoice.statusLabel}
                          {invoice.status !== 'paid' ? ` · due ${invoice.dueAt.slice(0, 10)}` : ''}
                        </>
                      ) : (
                        `Invoiced ${installment.trigger === 'before_dispatch' ? 'before dispatch' : installment.trigger === 'on_delivery' ? 'on delivery' : installment.trigger === 'net_30' ? 'with 30 days to pay' : 'on acceptance'}`
                      )}
                    </span>
                  </span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                    <span className="numeric">{money(installment.amountMinor)}</span>
                    {invoice && (invoice.status === 'unpaid' || invoice.status === 'partially_paid') ? (
                      <CommandButton size="sm" receiptLabel="Opening" onCommand={() => pay(invoice.invoiceId)}>
                        Pay
                      </CommandButton>
                    ) : invoice?.status === 'paid' ? (
                      <StatusChip tone="positive">Paid</StatusChip>
                    ) : null}
                  </span>
                </div>
              );
            })}
          </Stack>
        </Card>

        <ChangesPanel orderId={order.orderId} currency={order.currency} open={order.status !== 'completed' && order.status !== 'cancelled' && order.status !== 'payment_needed'} />

        <Card title="Contract record">
          <p style={{ font: 'var(--text-caption)', color: 'var(--color-text-muted)', marginBottom: 'var(--space-2)' }}>
            The frozen record of what was agreed. Quote this if you ever need to refer to the terms of this order.
          </p>
          <CopyableId label="Contract hash" value={order.contractHash} />
        </Card>

        <ThreadPanel contextType="sales_order" contextId={orderId} description="Anything about this order, between you and JobWork." />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)' }}>
          <ButtonLink href="/help" variant="secondary" fullWidth>Contact JobWork</ButtonLink>
          <ButtonLink href="/invoices" variant="secondary" fullWidth>All invoices</ButtonLink>
        </div>
      </Stack>
    </Page>
  );
}

/** Search params are read on the client only, so the page renders inside a Suspense boundary. */
export default function PageOrderDetail(): React.JSX.Element {
  return (
    <Suspense fallback={null}>
      <OrderDetail />
    </Suspense>
  );
}
