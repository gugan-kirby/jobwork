'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { ChangeRequest } from '@jobwork/contracts';
import { Card, DataTable, ErrorState, LoadingState, Page, StatusChip, type Column } from '@jobwork/ui';
import { CHANGE_TONE, ORIGIN } from './labels';
import { api, ApiError } from '../../lib/api';

/**
 * Engineering changes (IN-13; doc 06 §9): every proposal from customer, supplier, JobWork
 * or a new revision of a baselined drawing, newest first, with where it stands.
 */
export default function ChangesPage(): React.JSX.Element {
  const [rows, setRows] = useState<ChangeRequest[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    api<ChangeRequest[]>('/changes')
      .then(setRows)
      .catch((err: unknown) => {
        if (err instanceof ApiError) setError(err);
      });
  }, []);

  const columns: Array<Column<ChangeRequest>> = [
    { key: 'number', header: 'Change', render: (c) => <Link href={`/changes/${c.changeRequestId}`} className="mono">{c.number}</Link> },
    { key: 'order', header: 'Order', render: (c) => <span className="mono">{c.salesOrderNumber}</span> },
    { key: 'title', header: 'What', render: (c) => c.title },
    { key: 'origin', header: 'From', render: (c) => ORIGIN[c.origin] },
    { key: 'status', header: 'Status', render: (c) => <StatusChip tone={CHANGE_TONE[c.status]}>{c.status.replace(/_/g, ' ')}</StatusChip> },
    { key: 'urgency', header: 'Urgency', render: (c) => (c.urgency === 'urgent' ? <StatusChip tone="attention">urgent</StatusChip> : 'normal') },
  ];

  return (
    <Page title="Engineering changes" description="Every change to a released baseline goes through here: triage, impact, approval, the customer's decision, a new baseline and the supplier's acknowledgment." width="wide">
      {error ? (
        <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} />
      ) : !rows ? (
        <Card>
          <LoadingState label="Loading changes" />
        </Card>
      ) : (
        <Card flush>
          <DataTable
            caption="Engineering changes, newest first"
            columns={columns}
            rows={rows}
            rowKey={(c) => c.changeRequestId}
            stackTitle={(c) => `${c.number} — ${c.title}`}
            empty={{ title: 'No changes', detail: 'A change opens when someone proposes one, or when a baselined drawing gets a new revision.' }}
          />
        </Card>
      )}
    </Page>
  );
}
