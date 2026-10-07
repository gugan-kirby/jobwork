'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { Shipment, ShipmentLeg } from '@jobwork/contracts';
import { Card, Inline, Stack, StatusChip } from '@jobwork/ui';
import { api } from '../../../lib/api';
import { statusOf } from '../../logistics/labels';

const LEG: Record<ShipmentLeg, string> = {
  supplier_to_jobwork: 'Supplier to JobWork',
  jobwork_to_customer: 'JobWork to the customer',
  customer_to_jobwork: 'Customer material to JobWork',
  jobwork_to_supplier: 'JobWork to a supplier',
};

/** Both legs of the order's goods (IN-16 F-16.4; doc 06 §11). Hidden from roles that cannot read logistics. */
export function ShipmentsCard({ salesOrderId }: { salesOrderId: string }): React.JSX.Element | null {
  const [rows, setRows] = useState<Shipment[] | null>(null);

  useEffect(() => {
    api<Shipment[]>(`/shipments?salesOrderId=${salesOrderId}`)
      .then(setRows)
      .catch(() => setRows(null));
  }, [salesOrderId]);

  if (rows === null) return null;
  const legs = (Object.keys(LEG) as ShipmentLeg[]).filter((leg) => rows.some((s) => s.leg === leg));
  return (
    <Card
      title="Shipments"
      description="Each leg of the goods: supplier to JobWork, then JobWork to the customer."
      actions={<Link href={`/logistics/dispatch/new?salesOrderId=${salesOrderId}`}>Plan a delivery</Link>}
    >
      {rows.length === 0 ? (
        <p style={{ color: 'var(--color-text-muted)' }}>No shipments yet.</p>
      ) : (
        <Stack gap={3}>
          {legs.map((leg) => (
            <Stack key={leg} gap={1}>
              <strong>{LEG[leg]}</strong>
              {rows
                .filter((s) => s.leg === leg)
                .map((s) => (
                  <Inline key={s.shipmentId} gap={3}>
                    <Link href={`/logistics/shipments/${s.shipmentId}`} className="mono">
                      {s.number}
                    </Link>
                    {s.purchaseOrderNumber ? <span>{s.purchaseOrderNumber}</span> : null}
                    <span className="numeric">{s.totalQuantity} pcs</span>
                    <StatusChip tone={statusOf(s).tone}>{statusOf(s).label}</StatusChip>
                  </Inline>
                ))}
            </Stack>
          ))}
        </Stack>
      )}
    </Card>
  );
}
