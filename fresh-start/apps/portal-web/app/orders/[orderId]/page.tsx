'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import type { CustomerOrder, CustomerPaymentIntent } from '@jobwork/contracts';
import {
  ActionNeededCard,
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
import { loadEnquiryFacts, type EnquiryFacts } from '../../../lib/enquiry-facts';
import { milestones, ORDER_PROGRESS } from '../../../lib/order-progress';
import { ThreadPanel } from '../../thread-panel';
import { ChangesPanel } from './changes-panel';
import { DeliveriesPanel } from './deliveries-panel';
import { DeviationsPanel } from './deviations-panel';

/**
 * Order detail and tracking (prototype tiles 11–12, corrected per doc 06 §13): the next
 * step and whose it is, a curated timeline in the customer's words, what was ordered,
 * and the payment schedule with its invoices. No supplier, no workshop location, no
 * promised date before the order is released.
 *
 * VF-12, VF-18 (reference screen 12, ADR-0007): the summary card names the supplier, then
 * four milestones, current status, the timeline, Contact Vendor and Order Details. Order
 * Details opens everything else in place: deliveries, payments, changes, documents and
 * messages. Contact Vendor reaches the order's thread with JobWork until shared threads
 * land (ADR-0007 P5). The next-step card shows only when the step is the customer's.
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

const MILESTONE_DETAIL = {
  confirmed: 'Your order has been received.',
  production: 'Manufacturing is in progress.',
  delivery: 'Your order will be dispatched soon.',
  delivered: 'Order will be delivered to your location.',
} as const;

const SHORT_STATUS = (status: CustomerOrder['status']): string =>
  status === 'completed' ? 'Completed' : status === 'cancelled' ? 'Cancelled' : 'In Progress';

const dayMonth = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', timeZone: 'Asia/Kolkata' });
const longDate = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

function OrderDetail() {
  const orderId = useParams<{ orderId: string }>().orderId;
  const justAccepted = useSearchParams().get('accepted') === '1';
  const router = useRouter();
  const [order, setOrder] = useState<CustomerOrder | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [facts, setFacts] = useState<EnquiryFacts | null>(null);
  const [details, setDetails] = useState(false);

  const load = useCallback(async () => {
    try {
      const loaded = await api<CustomerOrder>(`/orders/${orderId}`);
      setOrder(loaded);
      setError(null);
      setFacts(await loadEnquiryFacts(loaded.enquiry.enquiryId).catch(() => null));
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
    <Page title="Order Tracking" back={{ href: '/orders', label: 'Back to orders' }}>
      <Stack gap={5}>
        <section className="jw-tinted-card" aria-label="Order summary">
          <div className="jw-counterpart">
            <span className="jw-counterpart-tile" aria-hidden="true">
              <Icon name="factory" size={2} />
            </span>
            <div style={{ display: 'grid', gap: 'var(--space-1)', minWidth: 0 }}>
              <div className="jw-counterpart-top">
                <p className="jw-counterpart-name">{order.title || order.number}</p>
                <StatusChip tone={TONE[order.status]}>{SHORT_STATUS(order.status)}</StatusChip>
              </div>
              <p className="jw-counterpart-line">
                Order #<span className="mono">{order.number}</span>
              </p>
              {order.supplier ? <p className="jw-counterpart-line">{order.supplier.name}</p> : null}
              {facts && (facts.category !== '—' || facts.material !== '—') ? (
                <p className="jw-counterpart-line">
                  <Icon name="location" size={1.1} /> {facts.category} | {facts.material}
                </p>
              ) : null}
              <p className="jw-summary-fact">
                <Icon name="calendar" size={1.15} />
                {longDate(order.acceptedAt)}
                {facts && facts.quantity !== '—' ? (
                  <>
                    <span aria-hidden="true"> | </span>
                    <Icon name="layers" size={1.15} />
                    {facts.quantity}
                  </>
                ) : null}
              </p>
            </div>
          </div>
        </section>
        {justAccepted ? (
          <Callout tone="positive" title="Order placed">
            You accepted {order.quotation.reference} revision {order.quotation.versionNo}. This order is bound to exactly that revision and its terms.
          </Callout>
        ) : null}

        {/* VF-12: JobWork's own next step is the Current Status panel; this card is for yours. */}
        {order.nextStep.owner === 'you' ? (
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
        ) : null}

        <section aria-labelledby="order-progress">
          <h2 id="order-progress" className="jw-section-heading">
            Order Progress
          </h2>
          <ol className="jw-milestones">
            {milestones(order.timeline).map((m) => (
              <li key={m.key} className={`jw-milestone jw-milestone-${m.state}`} aria-current={m.state === 'current' ? 'step' : undefined}>
                <span className="jw-milestone-disc" aria-hidden="true">
                  <Icon name={m.icon} size={1.3} />
                </span>
                <span className="jw-milestone-label">
                  {m.label}
                  <span className="jw-visually-hidden"> — {m.state === 'done' ? 'done' : m.state === 'current' ? 'in progress' : 'not started'}</span>
                </span>
                <span className="jw-milestone-date">{m.at ? dayMonth(m.at) : '—'}</span>
              </li>
            ))}
          </ol>
        </section>

        {order.status !== 'cancelled' ? (
          <section className="jw-panel jw-status-panel" aria-label="Current status">
            <div className="jw-status-head">
              <span className="jw-record-tile jw-record-tile-blue" aria-hidden="true">
                <Icon name="factory" size={1.7} />
              </span>
              <span style={{ display: 'grid', gap: 'var(--space-1)', minWidth: 0 }}>
                <span className="jw-offer-title">Current Status</span>
                <span className="jw-record-caption">{order.nextStep.detail || order.statusLabel}</span>
              </span>
              <span className="jw-count-badge">{ORDER_PROGRESS[order.status]}%</span>
            </div>
            <span
              className="jw-progress jw-progress-lg"
              role="progressbar"
              aria-label="Order progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={ORDER_PROGRESS[order.status]}
            >
              <span style={{ width: `${ORDER_PROGRESS[order.status]}%` }} />
            </span>
          </section>
        ) : null}

        <section aria-labelledby="order-timeline">
          <h2 id="order-timeline" className="jw-section-heading">
            Production Timeline
          </h2>
          <ol className="jw-timeline" aria-label="Order timeline">
            {milestones(order.timeline).map((m) => (
              <li key={m.key} className={`jw-timeline-step jw-timeline-${m.state}`} aria-current={m.state === 'current' ? 'step' : undefined}>
                <span className="jw-timeline-disc" aria-hidden="true">
                  <Icon name={m.icon} size={1.2} />
                </span>
                <span className="jw-timeline-body">
                  <span className="jw-timeline-title">
                    {m.label}
                    <span className="jw-visually-hidden"> — {m.state === 'done' ? 'done' : m.state === 'current' ? 'in progress' : 'not started'}</span>
                  </span>
                  <span className="jw-timeline-detail">{MILESTONE_DETAIL[m.key]}</span>
                </span>
                <span className="jw-timeline-at">{m.at ? dayMonth(m.at) : ''}</span>
              </li>
            ))}
          </ol>
        </section>

        <div className="jw-action-pair">
          <button type="button" className="jw-cta-outline jw-cta-sm jw-cta-icon" onClick={() => { setDetails(true); requestAnimationFrame(() => document.getElementById('messages')?.scrollIntoView()); }}>
            <Icon name="message" size={1.2} />
            Contact Vendor
          </button>
          <button type="button" className="jw-cta jw-cta-sm jw-cta-icon" aria-expanded={details} onClick={() => setDetails((v) => !v)}>
            <Icon name="document" size={1.2} />
            Order Details
          </button>
        </div>

        {details ? (
          <Stack gap={5}>
        <DeliveriesPanel orderId={order.orderId} />

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
                { label: 'Documents', value: <Link href={`/orders/${order.orderId}/documents`}>Drawings, certificates and delivery papers</Link> },
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

        <DeviationsPanel orderId={order.orderId} />

        <ChangesPanel orderId={order.orderId} currency={order.currency} open={order.status !== 'completed' && order.status !== 'cancelled' && order.status !== 'payment_needed'} />

        <Card title="Contract record">
          <p style={{ font: 'var(--text-caption)', color: 'var(--color-text-muted)', marginBottom: 'var(--space-2)' }}>
            The frozen record of what was agreed. Quote this if you ever need to refer to the terms of this order.
          </p>
          <CopyableId label="Contract hash" value={order.contractHash} />
        </Card>

        <div id="messages" />
        <ThreadPanel contextType="sales_order" contextId={orderId} description="Anything about this order, between you and JobWork." />
          </Stack>
        ) : null}
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
