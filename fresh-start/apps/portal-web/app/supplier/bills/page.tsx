'use client';

import { useCallback, useEffect, useState } from 'react';
import type { SupplierBill, SupplierPurchaseOrder } from '@jobwork/contracts';
import {
  Callout,
  Card,
  CommandButton,
  EmptyState,
  ErrorState,
  Inline,
  LoadingState,
  Page,
  RecordCard,
  RecordList,
  Select,
  Stack,
  StatusChip,
  TextInput,
  formatMoney,
  type Tone,
} from '@jobwork/ui';
import { api, ApiError } from '../../../lib/api';

const BILL_STATUS: Record<SupplierBill['status'], { label: string; tone: Tone }> = {
  submitted: { label: 'Submitted', tone: 'progress' },
  matched: { label: 'Matched', tone: 'positive' },
  match_exception: { label: 'Under review', tone: 'attention' },
  exception_approved: { label: 'Accepted', tone: 'positive' },
  rejected: { label: 'Rejected', tone: 'blocked' },
};
const SETTLEMENT_STATUS: Record<NonNullable<SupplierBill['settlement']>['status'], { label: string; tone: Tone }> = {
  held: { label: 'Payment on hold', tone: 'attention' },
  eligible: { label: 'Ready for payment', tone: 'progress' },
  scheduled: { label: 'Payment scheduled', tone: 'progress' },
  paid: { label: 'Paid', tone: 'positive' },
};

/**
 * Bills (supplier; IN-18 F-18.4; UC-31). The supplier bills JobWork against its purchase order;
 * JobWork matches the bill to the order and to what it accepted, then pays it once the work is
 * released and nothing holds it (doc 10 §5). The supplier sees why a bill or payment waits.
 */
export default function SupplierBillsPage(): React.JSX.Element {
  const [bills, setBills] = useState<SupplierBill[] | null>(null);
  const [orders, setOrders] = useState<SupplierPurchaseOrder[]>([]);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<ApiError | null>(null);
  const [form, setForm] = useState({ purchaseOrderId: '', supplierReference: '', billDate: new Date().toISOString().slice(0, 10), quantity: '', taxable: '', tax: '' });

  const load = useCallback(async () => {
    try {
      const [b, po] = await Promise.all([api<SupplierBill[]>('/supplier/bills'), api<{ purchaseOrders: SupplierPurchaseOrder[] }>('/supplier/purchase-orders')]);
      setBills(b);
      setOrders(po.purchaseOrders.filter((p) => p.status === 'acknowledged'));
      setError(null);
    } catch (err) {
      if (err instanceof ApiError) setError(err);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const ready = form.purchaseOrderId && form.supplierReference && form.quantity && form.taxable && form.tax !== '';

  return (
    <Page title="Bills" back={{ href: '/supplier', label: 'Back to home' }} description="Bill JobWork for accepted work and follow each bill to payment.">
      <Stack gap={4}>
        {error ? <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} /> : null}
        {notice ? <Callout tone="blocked" assertive title={notice.problem.title}>{notice.problem.detail ?? ''}</Callout> : null}

        <Card title="Submit a bill" description="One bill per invoice of yours. Bill only what JobWork has accepted; the amounts are before and after GST as on your invoice.">
          {orders.length === 0 ? (
            <p style={{ color: 'var(--color-text-muted)' }}>No acknowledged purchase order to bill against.</p>
          ) : (
            <Stack gap={2}>
              <Select
                label="Purchase order"
                value={form.purchaseOrderId}
                options={[{ value: '', label: 'Choose…' }, ...orders.map((p) => ({ value: p.purchaseOrderId, label: `${p.number} · ${formatMoney({ amountMinor: p.totalMinor, currency: p.currency })}` }))]}
                onChange={(e) => setForm({ ...form, purchaseOrderId: e.target.value })}
              />
              <Inline gap={2}>
                <TextInput label="Your invoice number" value={form.supplierReference} onChange={(e) => setForm({ ...form, supplierReference: e.target.value })} />
                <TextInput label="Invoice date" type="date" value={form.billDate} onChange={(e) => setForm({ ...form, billDate: e.target.value })} />
              </Inline>
              <Inline gap={2}>
                <TextInput label="Quantity" numeric value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} />
                <TextInput label="Taxable value (₹)" type="number" numeric value={form.taxable} onChange={(e) => setForm({ ...form, taxable: e.target.value })} />
                <TextInput label="GST (₹)" type="number" numeric value={form.tax} onChange={(e) => setForm({ ...form, tax: e.target.value })} />
              </Inline>
              <div>
                <CommandButton
                  receiptLabel="Submitted"
                  disabled={!ready}
                  disabledReason="Fill in every field"
                  onCommand={async () => {
                    setNotice(null);
                    const body = { purchaseOrderId: form.purchaseOrderId, supplierReference: form.supplierReference, billDate: form.billDate, quantity: form.quantity, taxableMinor: Math.round(Number(form.taxable) * 100), taxMinor: Math.round(Number(form.tax) * 100) };
                    try {
                      await api('/supplier/bills', { method: 'POST', body, idempotencyKey: `bill-${form.purchaseOrderId}-${form.supplierReference}` });
                      setForm({ ...form, supplierReference: '', quantity: '', taxable: '', tax: '' });
                      await load();
                    } catch (err) {
                      if (err instanceof ApiError) setNotice(err);
                      throw err;
                    }
                  }}
                >
                  Submit bill
                </CommandButton>
              </div>
            </Stack>
          )}
        </Card>

        {error ? null : bills === null ? (
          <Card>
            <LoadingState label="Loading your bills" />
          </Card>
        ) : bills.length === 0 ? (
          <Card>
            <EmptyState title="No bills yet" detail="Once JobWork accepts goods from a purchase order, bill it here." />
          </Card>
        ) : (
          <RecordList>
            {bills.map((b) => {
              const why = b.status === 'match_exception' || b.status === 'rejected' ? (b.decisionNote || b.match?.reasons.join(' ')) : b.settlement?.status === 'held' ? b.settlement.eligibility.reasons.join(' ') : '';
              return (
                <RecordCard
                  key={b.billId}
                  href={`/supplier/orders/${b.purchaseOrderId}`}
                  reference={b.number}
                  title={`${b.supplierReference} on ${b.purchaseOrderNumber}`}
                  caption={`${b.quantity} pieces · dated ${b.billDate}${b.settlement?.scheduledFor ? ` · payment due ${b.settlement.scheduledFor}` : ''}${b.settlement?.paymentReference ? ` · paid, ref ${b.settlement.paymentReference}` : ''}${why ? ` · ${why}` : ''}`}
                  figure={formatMoney({ amountMinor: b.totalMinor, currency: b.currency })}
                  status={
                    b.settlement ? (
                      <StatusChip tone={SETTLEMENT_STATUS[b.settlement.status].tone}>{SETTLEMENT_STATUS[b.settlement.status].label}</StatusChip>
                    ) : (
                      <StatusChip tone={BILL_STATUS[b.status].tone}>{BILL_STATUS[b.status].label}</StatusChip>
                    )
                  }
                />
              );
            })}
          </RecordList>
        )}
      </Stack>
    </Page>
  );
}
