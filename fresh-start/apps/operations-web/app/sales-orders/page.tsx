'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import type { SalesOrder } from '@jobwork/contracts';
import { DataTable, ErrorState, Page, Select, Stack, StatusChip, formatMoney, type Column, type Tone } from '@jobwork/ui';
import { api, ApiError } from '../../lib/api';

/**
 * Sales orders (IN-08): every accepted quotation, with what it is waiting on — the
 * advance, a credit decision, purchase orders to issue — so nothing accepted goes quiet.
 */

const STATUS_TONE: Partial<Record<SalesOrder['status'], Tone>> = {
  pending_commercial_release: 'attention',
  pending_technical_release: 'progress',
  cancelled: 'neutral',
  closed: 'positive',
};

const FILTERS = [
  { value: '', label: 'All' },
  { value: 'pending_commercial_release', label: 'Waiting on payment / credit' },
  { value: 'pending_technical_release', label: 'Released, awaiting baseline' },
];

function SalesOrdersList(): React.JSX.Element {
  const router = useRouter();
  const params = useSearchParams();
  const [status, setStatus] = useState(params.get('status') ?? '');
  const [rows, setRows] = useState<SalesOrder[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api<{ salesOrders: SalesOrder[] }>(`/sales-orders${status ? `?status=${status}` : ''}`);
      setRows(res.salesOrders);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError) setError(err);
      setRows([]);
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  const columns: Array<Column<SalesOrder>> = [
    {
      key: 'number',
      header: 'Order',
      render: (row) => (
        <>
          <Link href={`/sales-orders/${row.salesOrderId}`} className="mono">{row.number}</Link>
          <br />
          <span style={{ font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>{row.title}</span>
        </>
      ),
    },
    { key: 'customer', header: 'Customer', render: (row) => row.customerDisplayName },
    { key: 'total', header: 'Total', numeric: true, render: (row) => formatMoney({ amountMinor: row.totalMinor, currency: row.currency }) },
    {
      key: 'waiting',
      header: 'Waiting on',
      render: (row) =>
        row.status === 'pending_commercial_release'
          ? row.gate.reasons[0] ?? 'Commercial release'
          : row.purchaseOrders.length === 0
            ? 'Purchase orders to issue'
            : row.purchaseOrders.some((p) => p.status === 'issued')
              ? 'Supplier acknowledgment'
              : 'Technical baseline (IN-09)',
    },
    { key: 'status', header: 'Status', render: (row) => <StatusChip tone={STATUS_TONE[row.status] ?? 'progress'}>{row.status.replace(/_/g, ' ')}</StatusChip> },
    { key: 'accepted', header: 'Accepted', render: (row) => row.acceptance.acceptedAt.slice(0, 10) },
  ];

  return (
    <Page
      title="Sales orders"
      description="Accepted quotations and what each one is waiting on."
      width="wide"
      actions={<Select label="Show" value={status} options={FILTERS} onChange={(event) => setStatus(event.target.value)} />}
    >
      <Stack gap={4}>
        {error ? <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} /> : null}
        <DataTable
          caption="Sales orders"
          columns={columns}
          rows={rows}
          rowKey={(row) => row.salesOrderId}
          onRowClick={(row) => router.push(`/sales-orders/${row.salesOrderId}`)}
          loadingLabel="Loading sales orders"
          empty={{ title: 'No sales orders', detail: 'An order is created when a customer accepts a quotation in the portal.' }}
        />
      </Stack>
    </Page>
  );
}

/** Search params are read on the client only, so the page renders inside a Suspense boundary. */
export default function PageSalesOrdersList(): React.JSX.Element {
  return (
    <Suspense fallback={null}>
      <SalesOrdersList />
    </Suspense>
  );
}
