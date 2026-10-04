'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { CreditProfile, MeResponse, SalesOrder } from '@jobwork/contracts';
import {
  Button,
  ButtonLink,
  Callout,
  Card,
  CommandButton,
  CopyableId,
  DescriptionList,
  ErrorState,
  Inline,
  LoadingState,
  Page,
  ReasonField,
  Stack,
  StatusChip,
  TextInput,
  formatMoney,
} from '@jobwork/ui';
import { api, ApiError } from '../../../lib/api';

/**
 * One sales order (IN-08): the acceptance evidence, the commercial gate and why it says
 * what it says, the instalments and invoices, the purchase orders per awarded supplier,
 * and the customer's credit — each action a named command with a version guard.
 */
export default function SalesOrderPage(): React.JSX.Element {
  const salesOrderId = useParams<{ salesOrderId: string }>().salesOrderId;
  const [order, setOrder] = useState<SalesOrder | null>(null);
  const [credit, setCredit] = useState<CreditProfile | null | undefined>(undefined);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<ApiError | null>(null);
  const [limit, setLimit] = useState('');
  const [terms, setTerms] = useState('30');
  const [holdReason, setHoldReason] = useState('');

  const load = useCallback(async () => {
    try {
      const o = await api<SalesOrder>(`/sales-orders/${salesOrderId}`);
      setOrder(o);
      setError(null);
      api<{ credit: CreditProfile | null }>(`/finance/credit/${o.customerOrganizationId}`)
        .then((res) => setCredit(res.credit))
        .catch(() => setCredit(undefined));
    } catch (err) {
      if (err instanceof ApiError) setError(err);
    }
  }, [salesOrderId]);

  useEffect(() => {
    void load();
    api<MeResponse>('/auth/me').then(setMe).catch(() => setMe(null));
  }, [load]);

  if (!order) {
    return (
      <Page title="Sales order" breadcrumb={<Link href="/sales-orders">← Sales orders</Link>}>
        {error ? <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} /> : <Card><LoadingState label="Loading the order" /></Card>}
      </Page>
    );
  }

  const money = (minor: number): string => formatMoney({ amountMinor: minor, currency: order.currency });
  const isFinance = me?.roles.includes('jobwork_finance') ?? false;
  const isSourcing = me?.roles.includes('jobwork_sourcing') ?? false;

  const run = async (path: string, body: Record<string, unknown>): Promise<void> => {
    setNotice(null);
    try {
      await api(path, { method: 'POST', body, idempotencyKey: `${path}-${order.aggregateVersion}-${JSON.stringify(body).length}` });
      await load();
    } catch (err) {
      if (err instanceof ApiError) setNotice(err);
      throw err;
    }
  };

  return (
    <Page
      title={order.number}
      breadcrumb={<Link href="/sales-orders">← Sales orders</Link>}
      description={`${order.customerDisplayName} · ${order.title} · ${order.quoteReference ?? ''} v${order.acceptedQuoteVersionNo}`}
      width="wide"
      actions={<StatusChip tone={order.status === 'pending_commercial_release' ? 'attention' : 'progress'}>{order.status.replace(/_/g, ' ')}</StatusChip>}
    >
      <Stack gap={4}>
        {notice ? <Callout tone="blocked" assertive title={notice.problem.title}>{notice.problem.detail ?? ''} ({notice.problem.code})</Callout> : null}

        <Card title="Commercial release" description="doc 06 §7 — the advance has arrived, or approved credit covers the exposure; no hold.">
          <Stack gap={3}>
            {order.gate.pass ? (
              <Callout tone="positive" title={order.commercialReleasedAt ? `Released ${order.commercialReleasedAt.slice(0, 10)}` : 'Gate passes'}>
                Basis: {(order.commercialReleaseBasis ?? order.gate.basis ?? '').replace(/_/g, ' ')}.
              </Callout>
            ) : (
              <Callout tone="attention" title="Not released">
                <ul style={{ paddingLeft: 'var(--space-4)' }}>
                  {order.gate.reasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              </Callout>
            )}
            <DescriptionList
              columns={2}
              items={[
                { label: 'Advance due / received', value: `${money(order.gate.advanceDueMinor)} / ${money(order.gate.advancePaidMinor)}`, numeric: true },
                { label: 'Credit limit / exposure', value: order.gate.creditLimitMinor !== null ? `${money(order.gate.creditLimitMinor)} / ${money(order.gate.creditExposureMinor ?? 0)}` : 'No credit terms', numeric: true },
              ]}
            />
            {order.status === 'pending_commercial_release' && isFinance ? (
              <CommandButton receiptLabel="Released" disabled={!order.gate.pass} disabledReason="The gate does not pass yet" onCommand={() => run(`/sales-orders/${salesOrderId}/release-commercial`, { expectedVersion: order.aggregateVersion })}>
                Release commercially
              </CommandButton>
            ) : null}
          </Stack>
        </Card>

        <Card title="Payment schedule and invoices">
          <Stack gap={2}>
            {order.installments.map((i) => {
              const invoice = order.invoices.find((inv) => inv.invoiceId === i.invoiceId);
              return (
                <Inline key={i.installmentId} gap={3}>
                  <span style={{ minWidth: '12rem' }}>{i.label}</span>
                  <span className="numeric">{money(i.amountMinor)}</span>
                  <StatusChip tone={i.status === 'paid' ? 'positive' : i.status === 'invoiced' ? 'attention' : 'neutral'}>{i.status}</StatusChip>
                  {invoice ? <span className="mono">{invoice.number} · paid {money(invoice.paidMinor)} · due {invoice.dueAt.slice(0, 10)}</span> : <span style={{ color: 'var(--color-text-muted)' }}>{i.trigger.replace(/_/g, ' ')}</span>}
                  {i.status === 'pending' && isFinance ? (
                    <CommandButton size="sm" receiptLabel="Issued" onCommand={() => run(`/sales-orders/${salesOrderId}/invoices`, { expectedVersion: order.aggregateVersion, installmentId: i.installmentId })}>
                      Issue invoice
                    </CommandButton>
                  ) : null}
                </Inline>
              );
            })}
          </Stack>
        </Card>

        <Card title="Technical baseline and production" description="Baseline, transmittals, work-package release gates and milestone verification.">
          <ButtonLink
            href={`/sales-orders/${salesOrderId}/production`}
            variant={order.purchaseOrders.length > 0 && order.status === 'pending_technical_release' ? 'primary' : 'secondary'}
          >
            Open production →
          </ButtonLink>
        </Card>

        <Card title="Purchase orders" description="One per awarded supplier, frozen at issue. Work may not start before the technical baseline is released and the work package is released.">
          <Stack gap={3}>
            {order.purchaseOrders.length === 0 ? <p style={{ color: 'var(--color-text-muted)' }}>None issued yet.</p> : null}
            {order.purchaseOrders.map((po) => (
              <div key={po.purchaseOrderId}>
                <Inline gap={3}>
                  <strong className="mono">{po.number}</strong>
                  <span>{po.supplierDisplayName}</span>
                  <span className="numeric">{money(po.totalMinor)}</span>
                  <span>{po.leadTimeDays} days</span>
                  <StatusChip tone={po.status === 'acknowledged' ? 'positive' : 'attention'}>{po.status}</StatusChip>
                  <StatusChip tone="neutral">{po.baselineStatus.replace(/_/g, ' ')}</StatusChip>
                </Inline>
                <ul style={{ listStyle: 'none', font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>
                  {po.lines.map((l) => (
                    <li key={l.lineNo}>{l.lineNo}. {l.description} — {l.quantity} {l.unit} × {money(l.unitPriceMinor)} (bid version {l.bidVersionId.slice(0, 8)})</li>
                  ))}
                </ul>
              </div>
            ))}
            {isSourcing && order.status !== 'cancelled' ? (
              <CommandButton variant={order.purchaseOrders.length === 0 ? 'primary' : 'secondary'} receiptLabel="Issued" onCommand={() => run(`/sales-orders/${salesOrderId}/purchase-orders`, { expectedVersion: order.aggregateVersion })}>
                Issue purchase orders
              </CommandButton>
            ) : null}
          </Stack>
        </Card>

        <Card title="Acceptance evidence">
          <DescriptionList
            columns={2}
            items={[
              { label: 'Accepted by', value: `${order.acceptance.acceptedByName} · ${order.acceptance.acceptedAt.slice(0, 16).replace('T', ' ')}` },
              { label: 'Authority used', value: `${order.acceptance.authoritySnapshot.roles.join(', ')}${order.acceptance.authoritySnapshot.limitMinor !== null ? ` · limit ${money(order.acceptance.authoritySnapshot.limitMinor)}` : ' · no limit set'}` },
              { label: 'Quotation', value: <Link href={`/quotes/${order.quoteId}`}>{order.quoteReference} v{order.acceptance.quoteVersionNo}</Link> },
              { label: 'Terms', value: `v${order.acceptance.termsVersionNo}` },
              { label: 'Total', value: money(order.totalMinor), numeric: true },
              { label: 'Delivery', value: `${order.deliveryLeadDays} days` },
            ]}
          />
          <Stack gap={2}>
            <CopyableId label="Quotation content hash" value={order.acceptance.contentHash} />
            <CopyableId label="Contract snapshot hash" value={order.contractHash} />
          </Stack>
        </Card>

        {isFinance ? (
          <Card title={`Credit — ${order.customerDisplayName}`} description="doc 10 §4: a limit someone approved, and holds someone placed with a reason.">
            <Stack gap={3}>
              {credit === undefined ? null : credit === null ? (
                <p style={{ color: 'var(--color-text-muted)' }}>No approved credit terms. Orders release only on a paid advance.</p>
              ) : (
                <DescriptionList
                  columns={2}
                  items={[
                    { label: 'Limit', value: money(credit.limitMinor), numeric: true },
                    { label: 'Open receivables', value: money(credit.exposureMinor), numeric: true },
                    { label: 'Terms', value: `${credit.termsDays} days` },
                    { label: 'Valid until', value: credit.validUntil ?? 'Open-ended' },
                  ]}
                />
              )}
              {credit?.activeHolds.map((h) => (
                <Callout key={h.holdId} tone="blocked" title="Credit hold">
                  {h.reason} · placed {h.placedAt.slice(0, 10)}{' '}
                  <Button size="sm" variant="secondary" onClick={() => void run(`/finance/credit/${order.customerOrganizationId}/holds/${h.holdId}/release`, { reason: 'Released from the order screen' }).catch(() => undefined)}>
                    Release hold
                  </Button>
                </Callout>
              ))}
              <Inline gap={2}>
                <TextInput label="Credit limit (₹)" type="number" numeric value={limit} onChange={(e) => setLimit(e.target.value)} />
                <TextInput label="Terms (days)" type="number" numeric value={terms} onChange={(e) => setTerms(e.target.value)} />
                <CommandButton
                  variant="secondary"
                  receiptLabel="Saved"
                  disabled={!limit}
                  disabledReason="Enter a limit"
                  onCommand={() => run(`/finance/credit/${order.customerOrganizationId}`, { limitMinor: Math.round(Number(limit) * 100), termsDays: Number(terms || 0), currency: order.currency })}
                >
                  Approve credit terms
                </CommandButton>
              </Inline>
              <ReasonField label="Hold reason" audience="internal" value={holdReason} onChange={setHoldReason} />
              <CommandButton variant="danger" receiptLabel="Hold placed" disabled={holdReason.trim().length < 3} disabledReason="Say why" onCommand={() => run(`/finance/credit/${order.customerOrganizationId}/holds`, { reason: holdReason.trim() })}>
                Place credit hold
              </CommandButton>
            </Stack>
          </Card>
        ) : null}
      </Stack>
    </Page>
  );
}
