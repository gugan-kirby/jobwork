'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { SalesOrder, Shipment, ShipmentStatus } from '@jobwork/contracts';
import { Card, DataTable, ErrorState, Page, Stack, StatusChip, type Column } from '@jobwork/ui';
import { api, ApiError } from '../../lib/api';
import { statusOf, when } from './labels';

const SECTIONS: Array<{ title: string; description: string; statuses: readonly ShipmentStatus[]; toCustomer?: boolean }> = [
  { title: 'Deliveries to release', description: 'Packed for a customer with every guard green or overridden. Release checks them again and moves the stock out.', statuses: ['ready_for_release'], toCustomer: true },
  { title: 'Customer issues', description: 'Refused at the door, or held by what the customer reported. Resolve each exception.', statuses: ['refused', 'discrepancy_hold'], toCustomer: true },
  { title: 'On the way to customers', description: 'A carrier "delivered" is not a proof of delivery: record the POD.', statuses: ['delivered_to_destination', 'in_transit', 'picked_up', 'released'], toCustomer: true },
  { title: 'Awaiting customer acceptance', description: 'Handed over; the customer accepts or reports within the window, after which it is taken as accepted.', statuses: ['receiving_check'], toCustomer: true },
  { title: 'Deliveries being prepared', description: 'Planned; the gate shows what is still red.', statuses: ['planned'], toCustomer: true },
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
  const [ready, setReady] = useState<SalesOrder[]>([]);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    api<Shipment[]>('/shipments')
      .then(setRows)
      .catch((err) => {
        if (err instanceof ApiError) setError(err);
      });
    // Orders with everything received at JobWork: their stock waits for a delivery to be planned.
    api<{ salesOrders: SalesOrder[] }>('/sales-orders?status=received_jobwork')
      .then((r) => setReady(r.salesOrders))
      .catch(() => setReady([]));
  }, []);

  const columns: Column<Shipment>[] = [
    { key: 'number', header: 'Shipment', sticky: true, render: (s) => <span className="mono">{s.number}</span> },
    { key: 'po', header: 'Order', render: (s) => (s.leg === 'jobwork_to_customer' ? `${s.delivery?.orderNumber ?? ''} · to ${s.delivery?.customerDisplayName ?? 'the customer'}` : `${s.purchaseOrderNumber} · ${s.supplierDisplayName}`) },
    { key: 'pieces', header: 'Pieces', numeric: true, render: (s) => s.totalQuantity },
    { key: 'carrier', header: 'Carrier', hideOnStack: true, render: (s) => (s.carrier.trackingReference ? `${s.carrier.name} ${s.carrier.trackingReference}` : '—') },
    { key: 'since', header: 'Since', hideOnStack: true, render: (s) => when(s.carrierDeliveredAt ?? s.pickedUpAt ?? s.releasedAt ?? s.createdAt) },
    { key: 'status', header: 'Status', render: (s) => <StatusChip tone={statusOf(s).tone}>{statusOf(s).label}</StatusChip> },
  ];

  return (
    <Page title="Logistics" description="Both legs: supplier shipments in, deliveries out to customers. Release, follow, receive, deliver, resolve.">
      <Stack gap={4}>
        {error ? <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} /> : null}
        {ready.length > 0 ? (
          <Card title="Ready to plan a delivery" description="Everything ordered is received at JobWork.">
            <ul>
              {ready.map((o) => (
                <li key={o.salesOrderId}>
                  <span className="mono">{o.number}</span> · {o.customerDisplayName} · <Link href={`/logistics/dispatch/new?salesOrderId=${o.salesOrderId}`}>Plan a delivery</Link>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
        {SECTIONS.map((section) => {
          const list = rows === null ? null : rows.filter((s) => section.statuses.includes(s.status) && (s.leg === 'jobwork_to_customer') === Boolean(section.toCustomer)).sort((a, b) => section.statuses.indexOf(a.status) - section.statuses.indexOf(b.status));
          if (list !== null && list.length === 0 && (section.statuses.includes('accepted') || section.toCustomer)) return null;
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
