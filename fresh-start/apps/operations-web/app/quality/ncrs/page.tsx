'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { Ncr } from '@jobwork/contracts';
import { Card, DataTable, ErrorState, FilterChips, Page, Stack, StatusChip, type Column } from '@jobwork/ui';
import { api, ApiError } from '../../../lib/api';
import { NCR_TONE, STAGE } from '../labels';

/** Nonconformances (IN-15 F-15.5; UC-29): open ones first, each to its desk. */
export default function NcrsPage(): React.JSX.Element {
  const [view, setView] = useState<'open' | 'all'>('open');
  const [rows, setRows] = useState<Ncr[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    setRows(null);
    api<Ncr[]>(`/ncrs${view === 'open' ? '?open=true' : ''}`)
      .then(setRows)
      .catch((err: unknown) => {
        if (err instanceof ApiError) setError(err);
      });
  }, [view]);

  const columns: Array<Column<Ncr>> = [
    { key: 'number', header: 'NCR', render: (n) => <Link href={`/quality/ncrs/${n.ncrId}`} className="mono">{n.number}</Link> },
    { key: 'title', header: 'What', render: (n) => n.title },
    { key: 'po', header: 'Purchase order', render: (n) => <span className="mono">{n.purchaseOrderNumber}</span> },
    { key: 'supplier', header: 'Supplier', render: (n) => n.supplierDisplayName },
    { key: 'stage', header: 'Found at', render: (n) => STAGE[n.stage as keyof typeof STAGE] ?? n.stage },
    { key: 'severity', header: 'Severity', render: (n) => <StatusChip tone={n.severity === 'critical' ? 'blocked' : n.severity === 'major' ? 'attention' : 'neutral'}>{n.severity}</StatusChip> },
    { key: 'status', header: 'Status', render: (n) => <StatusChip tone={NCR_TONE[n.status] ?? 'neutral'}>{n.status.replace(/_/g, ' ')}</StatusChip> },
  ];

  return (
    <Page title="NCRs" breadcrumb={<Link href="/quality">← Quality</Link>} description="Each nonconformance from opening to an independent closure: containment, a disposition, rework judged by reinspection or a deviation, and the corrective action." width="wide">
      <Stack gap={4}>
        <FilterChips label="Show NCRs" value={view} options={[{ value: 'open', label: 'Open' }, { value: 'all', label: 'All' }]} onChange={setView} />
        {error ? <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} /> : null}
        <Card flush>
          <DataTable caption="NCRs" columns={columns} rows={rows ?? []} rowKey={(n) => n.ncrId} stackTitle={(n) => `${n.number} — ${n.title}`} empty={{ title: view === 'open' ? 'No open NCRs' : 'No NCRs yet', detail: 'Open one from a failed inspection.' }} />
        </Card>
      </Stack>
    </Page>
  );
}
