'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { VerificationQueueItem } from '@jobwork/contracts';
import { DataTable, ErrorState, Page, Stack, StatusChip, type Column } from '@jobwork/ui';
import { api, ApiError } from '../../lib/api';

/**
 * Milestone evidence waiting for a verifier (F-09.4). Submitted is not verified; the
 * decision happens on the order's production page, where the evidence and the baseline sit.
 */
export default function VerificationQueuePage(): React.JSX.Element {
  const [rows, setRows] = useState<VerificationQueueItem[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    api<{ milestones: VerificationQueueItem[] }>('/production/verification-queue')
      .then((res) => setRows(res.milestones))
      .catch((err) => {
        if (err instanceof ApiError) setError(err);
        setRows([]);
      });
  }, []);

  const columns: Array<Column<VerificationQueueItem>> = [
    { key: 'milestone', header: 'Milestone', render: (row) => <Link href={`/sales-orders/${row.salesOrderId}/production`}>{row.seq}. {row.title}</Link> },
    { key: 'wp', header: 'Work package', render: (row) => <span className="mono">{row.workPackageNumber}</span> },
    { key: 'order', header: 'Order', render: (row) => <span className="mono">{row.salesOrderNumber}</span> },
    { key: 'supplier', header: 'Supplier', render: (row) => row.supplierDisplayName },
    { key: 'evidence', header: 'Evidence', numeric: true, render: (row) => row.evidenceCount },
    { key: 'flag', header: '', render: (row) => (row.flagged ? <StatusChip tone="attention">flagged for review</StatusChip> : null) },
    { key: 'submitted', header: 'Submitted', render: (row) => row.submittedAt.slice(0, 16).replace('T', ' ') },
  ];

  return (
    <Page title="Production verification" description="Milestone evidence suppliers have submitted. The submitter never verifies." width="wide">
      <Stack gap={4}>
        {error ? <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} /> : null}
        <DataTable
          caption="Milestones awaiting verification"
          columns={columns}
          rows={rows}
          rowKey={(row) => row.milestoneId}
          loadingLabel="Loading the queue"
          empty={{ title: 'Nothing to verify', detail: 'When a supplier submits milestone evidence it appears here.' }}
        />
      </Stack>
    </Page>
  );
}
