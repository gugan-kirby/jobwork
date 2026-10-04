'use client';

import { useEffect, useState } from 'react';
import type { SupplierPurchaseOrder } from '@jobwork/contracts';
import {
  ButtonLink,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  Page,
  RecordCard,
  RecordList,
  Stack,
  StatusChip,
  formatMoney,
} from '@jobwork/ui';
import { api, ApiError } from '../../../lib/api';

/**
 * Purchase orders (supplier). Work JobWork has ordered from you: your lines, your price,
 * your lead time — the customer and JobWork's sell price are not part of this record.
 */
export default function SupplierPurchaseOrdersPage() {
  const [orders, setOrders] = useState<SupplierPurchaseOrder[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    api<{ purchaseOrders: SupplierPurchaseOrder[] }>('/supplier/purchase-orders')
      .then((res) => setOrders(res.purchaseOrders))
      .catch((err) => {
        if (err instanceof ApiError) setError(err);
      });
  }, []);

  return (
    <Page title="Purchase orders" back={{ href: '/supplier', label: 'Back to home' }} description="Work JobWork has ordered from you, from acknowledgement to settlement.">
      <Stack gap={4}>
        {error ? <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} /> : null}
        {error ? null : orders === null ? (
          <Card>
            <LoadingState label="Loading your purchase orders" />
          </Card>
        ) : orders.length === 0 ? (
          <Card>
            <EmptyState
              title="No purchase orders yet"
              detail="A purchase order from JobWork follows an awarded bid. When one is issued it appears here for acknowledgement, with the exact bid version it refers to."
              action={
                <ButtonLink href="/rfqs" variant="secondary">See open RFQs</ButtonLink>
              }
            />
          </Card>
        ) : (
          <RecordList>
            {orders.map((po) => (
              <RecordCard
                key={po.purchaseOrderId}
                href={`/supplier/orders/${po.purchaseOrderId}`}
                reference={po.number}
                title={po.lines.map((l) => l.description.split(' — ')[0]).join(', ')}
                caption={`${po.rfqReference ?? ''} · ${po.leadTimeDays} days · issued ${po.issuedAt.slice(0, 10)}`}
                figure={formatMoney({ amountMinor: po.totalMinor, currency: po.currency })}
                status={
                  <StatusChip tone={po.status === 'issued' ? 'attention' : po.status === 'acknowledged' ? 'progress' : 'neutral'}>
                    {po.status === 'issued' ? 'To acknowledge' : po.status === 'acknowledged' ? 'Acknowledged' : 'Cancelled'}
                  </StatusChip>
                }
              />
            ))}
          </RecordList>
        )}
      </Stack>
    </Page>
  );
}
