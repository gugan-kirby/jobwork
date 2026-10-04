'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { SupplierRfqListItem } from '@jobwork/contracts';
import {
  Card,
  DataTable,
  ErrorState,
  Page,
  Stack,
  StatusChip,
  type Column,
  type Tone,
} from '@jobwork/ui';
import { api, ApiError } from '../../lib/api';

/**
 * The supplier's RFQ list (doc 14 §5, UC-12). The countdown is the column that matters:
 * a round is only worth opening while there is time to answer it, and a deadline shown
 * as a date makes every supplier do the arithmetic themselves.
 */

const TONE: Record<string, Tone> = {
  invited: 'attention',
  acknowledged: 'progress',
  clarifying: 'progress',
  responded: 'positive',
  declined: 'neutral',
  no_response: 'blocked',
  revoked: 'neutral',
  prepared: 'neutral',
};

function remaining(deadlineAt: string | null): { text: string; tone: Tone } {
  if (!deadlineAt) return { text: 'no deadline', tone: 'neutral' };
  const ms = new Date(deadlineAt).getTime() - Date.now();
  if (ms <= 0) return { text: 'closed', tone: 'blocked' };
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 48) return { text: `${hours} hours left`, tone: 'attention' };
  return { text: `${Math.floor(hours / 24)} days left`, tone: 'progress' };
}

export default function SupplierRfqsPage(): React.JSX.Element {
  const router = useRouter();
  const [rows, setRows] = useState<SupplierRfqListItem[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api<{ rfqs: SupplierRfqListItem[] }>('/supplier/rfqs');
      setRows(res.rfqs);
    } catch (err) {
      if (err instanceof ApiError) setError(err);
      setRows([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const columns: Array<Column<SupplierRfqListItem>> = [
    {
      key: 'reference',
      header: 'Enquiry',
      render: (row) => (
        <Link href={`/rfqs/${row.rfqId}`} className="mono">
          {row.reference ?? 'pending'}
        </Link>
      ),
    },
    { key: 'lines', header: 'Lines', numeric: true, render: (row) => row.itemCount },
    {
      key: 'deadline',
      header: 'Time left',
      render: (row) => {
        // F-12.5: a round closed for a revision has no time left, whatever its deadline says.
        if (row.status === 'superseded') return <StatusChip tone="neutral">Closed: requirements updated</StatusChip>;
        const left = remaining(row.deadlineAt);
        return <StatusChip tone={left.tone}>{left.text}</StatusChip>;
      },
    },
    {
      key: 'status',
      header: 'You',
      render: (row) => (
        <StatusChip tone={TONE[row.invitationStatus] ?? 'neutral'}>
          {row.invitationStatus === 'invited' ? 'not answered yet' : row.invitationStatus.replace(/_/g, ' ')}
        </StatusChip>
      ),
    },
    {
      key: 'versions',
      header: 'Your bids',
      numeric: true,
      render: (row) => row.bidVersionCount,
    },
  ];

  return (
    <Page
      title="Requests for quotation"
      description="Work JobWork has invited you to quote. You see the requirement and the drawings; the customer's identity stays with JobWork."
      width="wide"
    >
      <Stack gap={4}>
        {error ? (
          <ErrorState
            message={error.problem.detail ?? error.problem.title}
            code={error.problem.code}
          />
        ) : null}
        <Card flush>
          <DataTable
            caption="RFQs you have been invited to"
            columns={columns}
            rows={rows}
            rowKey={(row) => row.rfqId}
            stackTitle={(row) => row.reference ?? 'RFQ'}
            onRowClick={(row) => router.push(`/rfqs/${row.rfqId}`)}
            loadingLabel="Loading your RFQs"
            empty={{
              title: 'Nothing to quote right now',
              detail:
                'Invitations appear here when JobWork matches your published capabilities to a job. Keep your capabilities and evidence current so you are in the running.',
            }}
          />
        </Card>
      </Stack>
    </Page>
  );
}
