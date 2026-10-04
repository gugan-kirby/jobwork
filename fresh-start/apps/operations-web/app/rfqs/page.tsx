'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { Rfq } from '@jobwork/contracts';
import {
  Card,
  DataTable,
  ErrorState,
  Page,
  Select,
  Stack,
  StatusChip,
  type Column,
  type Tone,
} from '@jobwork/ui';
import { api, ApiError } from '../../lib/api';

/**
 * The RFQ control room (doc 14 §6, F-06.6). Sourcing's question is never "what rounds
 * exist" but "which round needs me today", so the table leads with the deadline and the
 * two facts that demand action: who has not answered, and whether a round is heading for
 * an award with only one bid on it.
 */

type Row = Rfq & { singleSourceRisk: boolean };

const STATUS_TONE: Record<string, Tone> = {
  draft: 'neutral',
  internal_review: 'progress',
  open: 'progress',
  responses_received: 'progress',
  evaluation: 'attention',
  awarded: 'positive',
  no_bid: 'blocked',
  expired: 'blocked',
  cancelled: 'neutral',
  // F-12.5: the requirement was revised; its bids stand as history.
  superseded: 'neutral',
};

const FILTERS = [
  { value: '', label: 'Every round' },
  { value: 'open', label: 'Open for bids' },
  { value: 'evaluation', label: 'Ready to evaluate' },
  { value: 'draft', label: 'Being prepared' },
  { value: 'no_bid', label: 'Closed with no bid' },
];

function countdown(deadlineAt: string | null): string {
  if (!deadlineAt) return '—';
  const ms = new Date(deadlineAt).getTime() - Date.now();
  if (ms <= 0) return 'passed';
  const hours = Math.floor(ms / 3_600_000);
  return hours >= 48 ? `${Math.floor(hours / 24)} days` : `${hours} hours`;
}

export default function RfqControlRoomPage(): React.JSX.Element {
  const router = useRouter();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [status, setStatus] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api<{ rfqs: Row[] }>(`/rfqs${status ? `?status=${status}` : ''}`);
      setRows(res.rfqs);
    } catch (err) {
      if (err instanceof ApiError) setError(err);
      setRows([]);
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  const columns: Array<Column<Row>> = [
    {
      key: 'reference',
      header: 'Round',
      render: (row) => (
        <Link href={`/rfqs/${row.rfqId}`} className="mono">
          {row.reference ?? `draft · round ${row.roundNo}`}
        </Link>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) => (
        <StatusChip tone={STATUS_TONE[row.status] ?? 'neutral'}>
          {row.status.replace(/_/g, ' ')}
        </StatusChip>
      ),
    },
    {
      key: 'deadline',
      header: 'Deadline',
      // A countdown only while the round takes bids; after that the date is enough.
      render: (row) =>
        !row.deadlineAt
          ? '—'
          : row.status === 'open' || row.status === 'responses_received'
            ? `${row.deadlineAt.slice(0, 10)} · ${countdown(row.deadlineAt)}`
            : row.deadlineAt.slice(0, 10),
    },
    {
      key: 'invited',
      header: 'Invited',
      numeric: true,
      render: (row) => row.invitations.length,
    },
    {
      key: 'responded',
      header: 'Bids',
      numeric: true,
      render: (row) => row.invitations.filter((i) => i.status === 'responded').length,
    },
    {
      key: 'waiting',
      header: 'Waiting on',
      numeric: true,
      render: (row) =>
        row.invitations.filter((i) => ['invited', 'acknowledged', 'clarifying'].includes(i.status))
          .length,
    },
    {
      key: 'risk',
      header: 'Risk',
      render: (row) =>
        row.singleSourceRisk ? (
          <StatusChip tone="attention">single source</StatusChip>
        ) : (
          <span style={{ color: 'var(--color-text-muted)' }}>—</span>
        ),
    },
  ];

  return (
    <Page
      title="RFQ control room"
      description="Sourcing rounds, who is still to answer, and where a decision is waiting."
      width="wide"
    >
      <Stack gap={4}>
        {error ? (
          <ErrorState
            message={error.problem.detail ?? error.problem.title}
            code={error.problem.code}
          />
        ) : null}

        <Card title="Filter">
          <Select
            label="Status"
            value={status}
            options={FILTERS}
            onChange={(event) => setStatus(event.target.value)}
          />
        </Card>

        <Card flush>
          <DataTable
            caption="Sourcing rounds with their deadlines and responses"
            columns={columns}
            rows={rows}
            rowKey={(row) => row.rfqId}
            stackTitle={(row) => row.reference ?? `Round ${row.roundNo}`}
            onRowClick={(row) => router.push(`/rfqs/${row.rfqId}`)}
            loadingLabel="Loading sourcing rounds"
            empty={{
              title: 'No rounds yet',
              detail:
                'A round starts from an approved enquiry in Intake — open one and choose “Source this”.',
            }}
          />
        </Card>
      </Stack>
    </Page>
  );
}
