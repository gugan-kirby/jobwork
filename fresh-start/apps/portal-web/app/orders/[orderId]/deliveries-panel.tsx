'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { CustomerDelivery, CustomerDeliveryStatus } from '@jobwork/contracts';
import { ButtonLink, Card, Inline, Stack, StatusChip, type Tone } from '@jobwork/ui';
import { api } from '../../../lib/api';

export const DELIVERY_TONE: Record<CustomerDeliveryStatus, Tone> = {
  preparing: 'neutral',
  ready_to_leave: 'progress',
  on_the_way: 'progress',
  carrier_reports_delivered: 'attention',
  awaiting_your_confirmation: 'attention',
  issue_reported: 'blocked',
  accepted: 'positive',
  refused: 'blocked',
};

/** What a delivery needs from the customer, if anything. */
export function deliveryAsk(d: CustomerDelivery): string | null {
  if (d.addressConfirmation.needed) return 'Confirm the address';
  if (d.actions.accept) return d.acceptanceDueAt ? `Confirm by ${new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' }).format(new Date(d.acceptanceDueAt))}` : 'Confirm receipt';
  if (d.actions.reportNotReceived) return 'Received it?';
  return null;
}

/** The order's deliveries (IN-17 F-17.5; doc 06 §13): each one, where it stands, and what it needs from you. */
export function DeliveriesPanel({ orderId }: { orderId: string }): React.JSX.Element | null {
  const [rows, setRows] = useState<CustomerDelivery[] | null>(null);

  useEffect(() => {
    api<CustomerDelivery[]>(`/orders/${orderId}/deliveries`)
      .then(setRows)
      .catch(() => setRows(null));
  }, [orderId]);

  if (!rows || rows.length === 0) return null;
  return (
    <Card title="Deliveries" description="From JobWork to your site. Each is tracked, handed over, and then yours to accept or report.">
      <Stack gap={3}>
        {rows.map((d) => {
          const ask = deliveryAsk(d);
          return (
            <Inline key={d.shipmentId} gap={3} justify="space-between">
              <span>
                <Link href={`/orders/${orderId}/deliveries/${d.shipmentId}`} className="mono">
                  {d.number}
                </Link>
                <span style={{ display: 'block', font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>
                  {d.totalQuantity} pieces in {d.packages.length} package{d.packages.length === 1 ? '' : 's'}
                  {d.carrier.name ? ` · ${d.carrier.name} ${d.carrier.trackingReference}` : ''}
                </span>
              </span>
              <Inline gap={2}>
                <StatusChip tone={DELIVERY_TONE[d.status]}>{d.statusLabel}</StatusChip>
                {ask ? (
                  <ButtonLink href={`/orders/${orderId}/deliveries/${d.shipmentId}`} size="sm">
                    {ask}
                  </ButtonLink>
                ) : null}
              </Inline>
            </Inline>
          );
        })}
      </Stack>
    </Card>
  );
}
