'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { Inspection } from '@jobwork/contracts';
import { ButtonLink, Card, DataTable, ErrorState, FilterChips, Page, Stack, StatusChip, type Column } from '@jobwork/ui';
import { api, ApiError } from '../../lib/api';
import { INSPECTION_TONE, STAGE } from './labels';

type View = 'review' | 'all';

/**
 * JobWork quality's inspections (IN-14 F-14.4; UC-28): those waiting for an independent
 * decision first, then every inspection planned on every work package.
 */
export default function QualityPage(): React.JSX.Element {
  const [view, setView] = useState<View>('review');
  const [rows, setRows] = useState<Inspection[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    setRows(null);
    api<Inspection[]>(`/inspections${view === 'review' ? '?awaitingReview=true' : ''}`)
      .then(setRows)
      .catch((err: unknown) => {
        if (err instanceof ApiError) setError(err);
      });
  }, [view]);

  const columns: Array<Column<Inspection>> = [
    { key: 'number', header: 'Inspection', render: (i) => <Link href={`/quality/inspections/${i.inspectionId}`} className="mono">{i.number}</Link> },
    { key: 'po', header: 'Purchase order', render: (i) => <span className="mono">{i.purchaseOrderNumber}</span> },
    { key: 'supplier', header: 'Supplier', render: (i) => i.supplierDisplayName },
    { key: 'stage', header: 'Stage', render: (i) => STAGE[i.stage] },
    { key: 'pieces', header: 'Pieces', numeric: true, render: (i) => String(i.sampleSize) },
    { key: 'status', header: 'Status', render: (i) => <StatusChip tone={INSPECTION_TONE[i.status]}>{i.status.replace(/_/g, ' ')}</StatusChip> },
  ];

  return (
    <Page
      title="Quality"
      description="Inspections are planned from each work package's approved quality plan. Submitted is not passed: someone other than the inspector decides."
      width="wide"
      actions={
        <ButtonLink href="/quality/instruments" variant="secondary">
          Instruments
        </ButtonLink>
      }
    >
      <Stack gap={4}>
        <FilterChips
          label="Show inspections"
          value={view}
          options={[
            { value: 'review', label: 'Awaiting review' },
            { value: 'all', label: 'All' },
          ]}
          onChange={setView}
        />
        {error ? <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} /> : null}
        <Card flush>
          <DataTable
            caption="Inspections"
            columns={columns}
            rows={rows ?? []}
            rowKey={(i) => i.inspectionId}
            stackTitle={(i) => `${i.number} — ${STAGE[i.stage]}`}
            empty={{ title: view === 'review' ? 'Nothing waiting for review' : 'No inspections yet', detail: 'Plan one from a work package on its production page.' }}
          />
        </Card>
      </Stack>
    </Page>
  );
}
