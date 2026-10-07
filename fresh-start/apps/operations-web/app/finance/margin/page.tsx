'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { JobMargin } from '@jobwork/contracts';
import { Card, DataTable, ErrorState, Page, Stack, StatusChip, formatMoney, type Column } from '@jobwork/ui';
import { api, ApiError } from '../../../lib/api';

const pct = (bp: number | null): string => (bp === null ? '—' : `${(bp / 100).toFixed(1)} %`);

/**
 * Margin per order (IN-18 F-18.4; F-18.3): the approved cost sheet against what the order's
 * postings say happened — revenue less credit notes, supplier cost less recoveries, change and
 * warranty cost. The variance is final once every supplier bill is in. Internal only.
 */
export default function MarginPage(): React.JSX.Element {
  const [rows, setRows] = useState<JobMargin[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    api<JobMargin[]>('/finance/margin')
      .then(setRows)
      .catch((err) => {
        if (err instanceof ApiError) setError(err);
      });
  }, []);

  const money = (minor: number, currency: string): string => formatMoney({ amountMinor: minor, currency });
  const columns: Array<Column<JobMargin>> = [
    { key: 'o', header: 'Order', render: (r) => <Link href={`/sales-orders/${r.salesOrderId}`} className="mono">{r.orderNumber}</Link> },
    { key: 'c', header: 'Customer', render: (r) => r.customerDisplayName },
    { key: 'pm', header: 'Planned margin', numeric: true, render: (r) => (r.planned ? `${money(r.planned.marginMinor, r.currency)} · ${pct(r.planned.marginBp)}` : '—') },
    { key: 'rev', header: 'Net revenue', numeric: true, render: (r) => money(r.actual.revenueMinor - r.actual.creditNotesMinor, r.currency) },
    { key: 'cost', header: 'Cost', numeric: true, render: (r) => money(r.actual.costOfGoodsMinor - r.actual.recoveriesMinor + r.actual.changeCostMinor + r.actual.warrantyCostMinor, r.currency) },
    { key: 'am', header: 'Realized margin', numeric: true, render: (r) => `${money(r.actual.marginMinor, r.currency)} · ${pct(r.actual.marginBp)}` },
    {
      key: 'v',
      header: 'Variance',
      numeric: true,
      render: (r) =>
        r.varianceMinor === null ? (
          <StatusChip tone="neutral">{r.billsComplete ? 'No plan' : 'Bills pending'}</StatusChip>
        ) : (
          <StatusChip tone={r.varianceMinor < 0 ? 'blocked' : 'positive'}>{money(r.varianceMinor, r.currency)}</StatusChip>
        ),
    },
  ];

  return (
    <Page title="Margin" back={{ href: '/finance', label: 'Finance' }} description="Planned against realized margin per order." width="wide">
      <Stack gap={4}>
        {error ? <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} /> : null}
        <Card>
          <DataTable caption="Margin per order" columns={columns} rows={rows} rowKey={(r) => r.salesOrderId} loadingLabel="Loading margin" empty={{ title: 'No orders yet', detail: 'Released orders appear here.' }} />
        </Card>
      </Stack>
    </Page>
  );
}
