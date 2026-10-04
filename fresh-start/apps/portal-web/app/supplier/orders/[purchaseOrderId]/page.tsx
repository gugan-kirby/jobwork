'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import type { SupplierPurchaseOrder } from '@jobwork/contracts';
import {
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
  TextArea,
  formatMoney,
} from '@jobwork/ui';
import { api, ApiError } from '../../../../lib/api';
import { ProductionPanel } from './production-panel';

/**
 * One purchase order, supplier view (`FR-502`): the frozen lines and the bid versions
 * they came from, what must happen before work may start, and the acknowledgment.
 */
export default function SupplierPurchaseOrderPage() {
  const purchaseOrderId = useParams<{ purchaseOrderId: string }>().purchaseOrderId;
  const [po, setPo] = useState<SupplierPurchaseOrder | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    try {
      setPo(await api<SupplierPurchaseOrder>(`/supplier/purchase-orders/${purchaseOrderId}`));
    } catch (err) {
      if (err instanceof ApiError) setError(err);
    }
  }, [purchaseOrderId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!po) {
    return (
      <Page title="Purchase order" back={{ href: '/supplier/orders', label: 'Back to purchase orders' }}>
        {error ? <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} /> : <Card><LoadingState label="Loading the purchase order" /></Card>}
      </Page>
    );
  }

  const money = (minor: number): string => formatMoney({ amountMinor: minor, currency: po.currency });

  async function acknowledge(): Promise<void> {
    if (!po) return;
    setPo(
      await api<SupplierPurchaseOrder>(`/supplier/purchase-orders/${purchaseOrderId}/acknowledge`, {
        method: 'POST',
        body: { expectedVersion: po.aggregateVersion, note: note.trim() },
        idempotencyKey: `ack-${purchaseOrderId}-${po.aggregateVersion}`,
      }),
    );
  }

  return (
    <Page
      title="Purchase order"
      back={{ href: '/supplier/orders', label: 'Back to purchase orders' }}
      meta={
        <>
          <span className="mono">{po.number}</span>
          <StatusChip tone={po.status === 'issued' ? 'attention' : 'progress'}>{po.status === 'issued' ? 'To acknowledge' : 'Acknowledged'}</StatusChip>
        </>
      }
    >
      <Stack gap={4}>
        {po.beforeWork.length === 0 ? (
          <Callout tone="positive" title="Released to production">
            JobWork has released this work. Follow the checkpoints below and upload evidence as you go.
          </Callout>
        ) : null}
        {po.beforeWork.length > 0 ? (
        <Callout tone={po.baselineStatus === 'pending_baseline' ? 'attention' : 'progress'} title="Before work starts">
          <ul style={{ paddingLeft: 'var(--space-4)' }}>
            {po.beforeWork.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </Callout>
        ) : null}

        <Card title="Lines">
          <Stack gap={2}>
            {po.lines.map((line) => (
              <div key={line.lineNo} style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-3)' }}>
                <span>
                  {line.lineNo}. {line.description}
                  <span style={{ display: 'block', font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>
                    {line.quantity} {line.unit} × {money(line.unitPriceMinor)}
                    {line.setupAmountMinor > 0 ? ` + setup ${money(line.setupAmountMinor)}` : ''}
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
                { label: 'Total (ex GST)', value: <strong>{money(po.totalMinor)}</strong>, numeric: true },
                { label: 'Lead time', value: `${po.leadTimeDays} days from work-package release` },
                { label: 'Payment terms', value: po.paymentTerms || 'As agreed in your bid' },
                { label: 'RFQ', value: po.rfqReference ?? '—', mono: true },
                { label: 'Issued', value: po.issuedAt.slice(0, 10) },
                ...(po.acknowledgedAt ? [{ label: 'Acknowledged', value: `${po.acknowledgedAt.slice(0, 10)}${po.acknowledgmentNote ? ` — ${po.acknowledgmentNote}` : ''}` }] : []),
              ]}
            />
          </div>
          <p style={{ marginTop: 'var(--space-3)', font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>{po.instructions}</p>
          <div style={{ marginTop: 'var(--space-2)' }}>
            <CopyableId label="Content hash" value={po.contentHash} />
          </div>
        </Card>

        {po.status === 'issued' ? (
          <Card title="Acknowledge" description="Confirms you accept these lines, this price and this lead time. It does not start work.">
            <Stack gap={3}>
              <TextArea label="Note to JobWork (optional)" value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
              <CommandButton receiptLabel="Acknowledged" onCommand={acknowledge}>
                Acknowledge purchase order
              </CommandButton>
            </Stack>
          </Card>
        ) : null}
        <ProductionPanel purchaseOrderId={purchaseOrderId} />
      </Stack>
    </Page>
  );
}
