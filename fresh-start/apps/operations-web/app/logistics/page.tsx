'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Shipment, ShipmentStatus } from '@jobwork/contracts';
import { Card, DataTable, ErrorState, Page, Stack, StatusChip, type Column } from '@jobwork/ui';
import { api, ApiError } from '../../lib/api';
import { SHIPMENT_STATUS, when } from './labels';

const SECTIONS: Array<{ title: string; description: string; statuses: readonly ShipmentStatus[] }> = [
  { title: 'To release', description: 'Submitted by the supplier with every guard green. Release checks them again and freezes the addresses.', statuses: ['ready_for_release'] },
  { title: 'Coming in', description: 'Released and on the way. A carrier "delivered" is not a receipt: count it in.', statuses: ['delivered_to_destination', 'in_transit', 'picked_up', 'released'] },
  { title: 'Discrepancy hold', description: 'Short, damaged, wrong or mis-documented at receiving. Resolve each one.', statuses: ['discrepancy_hold', 'receiving_check'] },
  { title: 'Being prepared by suppliers', description: 'Planned, not yet submitted.', statuses: ['planned'] },
  { title: 'Received', description: 'Counted and accepted.', statuses: ['accepted'] },
];

/** JobWork logistics (IN-16 F-16.4): leg-1 shipments by what they need next. */
export default function LogisticsPage(): React.JSX.Element {
  const router = useRouter();
  const [rows, setRows] = useState<Shipment[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    api<Shipment[]>('/shipments')
      .then(setRows)
      .catch((err) => {
        if (err instanceof ApiError) setError(err);
      });
  }, []);

  const columns: Column<Shipment>[] = [
    { key: 'number', header: 'Shipment', sticky: true, render: (s) => <span className="mono">{s.number}</span> },
    { key: 'po', header: 'Purchase order', render: (s) => `${s.purchaseOrderNumber} · ${s.supplierDisplayName}` },
    { key: 'pieces', header: 'Pieces', numeric: true, render: (s) => s.totalQuantity },
    { key: 'carrier', header: 'Carrier', hideOnStack: true, render: (s) => (s.carrier.trackingReference ? `${s.carrier.name} ${s.carrier.trackingReference}` : '—') },
    { key: 'since', header: 'Since', hideOnStack: true, render: (s) => when(s.carrierDeliveredAt ?? s.pickedUpAt ?? s.releasedAt ?? s.createdAt) },
    { key: 'status', header: 'Status', render: (s) => <StatusChip tone={SHIPMENT_STATUS[s.status].tone}>{SHIPMENT_STATUS[s.status].label}</StatusChip> },
  ];

  return (
    <Page title="Logistics" description="Supplier shipments to JobWork: release, follow, receive, resolve.">
      <Stack gap={4}>
        {error ? <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} /> : null}
        {SECTIONS.map((section) => {
          const list = rows === null ? null : rows.filter((s) => section.statuses.includes(s.status)).sort((a, b) => section.statuses.indexOf(a.status) - section.statuses.indexOf(b.status));
          if (list !== null && list.length === 0 && section.statuses.includes('accepted')) return null;
          return (
            <Card key={section.title} title={section.title} description={section.description}>
              <DataTable
                caption={section.title}
                columns={columns}
                rows={list}
                rowKey={(s) => s.shipmentId}
                onRowClick={(s) => router.push(`/logistics/shipments/${s.shipmentId}`)}
                loadingLabel="Loading shipments"
                empty={{ title: 'Nothing here', detail: 'Shipments appear here as they reach this step.' }}
              />
            </Card>
          );
        })}
      </Stack>
    </Page>
  );
}
