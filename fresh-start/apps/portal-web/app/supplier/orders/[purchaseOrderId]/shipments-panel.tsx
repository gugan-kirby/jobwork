'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { Shipment } from '@jobwork/contracts';
import { ButtonLink, Card, Inline, Stack, StatusChip, useCommandTick } from '@jobwork/ui';
import { api } from '../../../../lib/api';
import { amount, statusOf } from '../../shipments/labels';

/** Shipments to JobWork on this purchase order (IN-16 F-16.4), and where to plan the next one. */
export function ShipmentsPanel({ purchaseOrderId, acknowledged }: { purchaseOrderId: string; acknowledged: boolean }): React.JSX.Element | null {
  const [rows, setRows] = useState<Shipment[]>([]);
  const tick = useCommandTick();

  const load = useCallback(async () => {
    const all = await api<Shipment[]>('/supplier/shipments').catch(() => []);
    setRows(all.filter((s) => s.purchaseOrderId === purchaseOrderId));
  }, [purchaseOrderId]);

  useEffect(() => {
    void load();
  }, [load, tick]);

  if (!acknowledged) return null;
  return (
    <Card title="Shipments to JobWork" description="Ship what JobWork quality released, packed and documented. JobWork releases each shipment before pickup.">
      <Stack gap={2}>
        {rows.map((s) => (
          <Inline key={s.shipmentId} gap={3}>
            <Link href={`/supplier/shipments/${s.shipmentId}`} className="mono">
              {s.number}
            </Link>
            <span className="numeric">{amount(s)}</span>
            {s.leg === 'jobwork_to_supplier' ? <span>material from JobWork</span> : null}
            <StatusChip tone={statusOf(s).tone}>{statusOf(s).label}</StatusChip>
          </Inline>
        ))}
        <div>
          <ButtonLink href={`/supplier/shipments/new?purchaseOrderId=${purchaseOrderId}`} variant="secondary">
            Plan a shipment
          </ButtonLink>
        </div>
      </Stack>
    </Card>
  );
}
