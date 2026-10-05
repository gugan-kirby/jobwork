'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { WorkPackageLogistics } from '@jobwork/contracts';
import { Card, DataTable, DescriptionList, ErrorState, LoadingState, Page, Stack } from '@jobwork/ui';
import { api, ApiError } from '../../../../lib/api';

/**
 * One work package's quantities end to end, and its stock by location (IN-16 F-16.4; doc 19 §8:
 * remaining commitment visible). Outstanding is ordered less accepted: what the supplier still owes.
 */
export default function WorkPackageLogisticsPage(): React.JSX.Element {
  const workPackageId = useParams<{ workPackageId: string }>().workPackageId;
  const [v, setV] = useState<WorkPackageLogistics | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    api<WorkPackageLogistics>(`/logistics/work-packages/${workPackageId}`)
      .then(setV)
      .catch((err) => {
        if (err instanceof ApiError) setError(err);
      });
  }, [workPackageId]);

  if (!v) {
    return (
      <Page title="Quantities and stock" breadcrumb={<Link href="/logistics">← Logistics</Link>}>
        {error ? <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} /> : <Card><LoadingState label="Loading" /></Card>}
      </Page>
    );
  }

  const figure = (q: string): React.JSX.Element => <span className="numeric">{q}</span>;
  return (
    <Page title={`${v.workPackageNumber} — quantities and stock`} breadcrumb={<Link href="/logistics">← Logistics</Link>}>
      <Stack gap={4}>
        <Card title="From order to stock">
          <DescriptionList
            columns={2}
            items={[
              { label: 'Ordered', value: figure(v.ordered) },
              { label: 'Quality released', value: figure(v.released) },
              { label: 'Shipped', value: figure(v.shipped) },
              { label: 'Counted at receiving', value: figure(v.received) },
              { label: 'Accepted to stock', value: figure(v.accepted) },
              { label: 'In quarantine', value: figure(v.quarantined) },
              { label: 'Scrapped', value: figure(v.scrapped) },
              { label: 'Returned', value: figure(v.returned) },
              { label: 'Outstanding (still owed)', value: figure(v.outstanding) },
            ]}
          />
        </Card>
        <Card title="Stock lots" description="Every piece that entered JobWork’s custody, and where it is now.">
          <DataTable
            caption="Stock lots"
            rows={v.lots.flatMap((l) => (l.balances.length ? l.balances : [{ locationCode: '—', label: '—', onHand: false, quantity: '0' }]).map((b) => ({ ...l, b })))}
            rowKey={(r) => `${r.lotId}-${r.b.locationCode}`}
            columns={[
              { key: 'lot', header: 'Lot', sticky: true, render: (r) => <span className="mono">{r.lotCode || '—'}</span> },
              { key: 'from', header: 'Received on', render: (r) => <span className="mono">{r.sourceShipmentNumber}</span> },
              { key: 'received', header: 'Received', numeric: true, render: (r) => r.receivedQuantity },
              { key: 'where', header: 'Where', render: (r) => r.b.label },
              { key: 'qty', header: 'Quantity', numeric: true, render: (r) => r.b.quantity },
            ]}
            empty={{ title: 'Nothing received yet', detail: 'Lots appear here once a shipment is received.' }}
          />
        </Card>
      </Stack>
    </Page>
  );
}
