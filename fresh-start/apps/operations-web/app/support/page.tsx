'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { SupportCase } from '@jobwork/contracts';
import { Card, DataTable, ErrorState, FilterChips, Page, Stack, StatusChip, type Column } from '@jobwork/ui';
import { api, ApiError } from '../../lib/api';
import { CASE_KIND, CASE_TONE } from './labels';

/**
 * Case center (IN-18 F-18.4; doc 06 §15): every support case, open ones first. A case opened
 * from a delivery exception holds that delivery until it closes.
 */
export default function CasesPage(): React.JSX.Element {
  const [cases, setCases] = useState<SupportCase[] | null>(null);
  const [open, setOpen] = useState<'true' | 'false'>('true');
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    setCases(null);
    api<SupportCase[]>(`/cases?open=${open}`)
      .then(setCases)
      .catch((err) => {
        if (err instanceof ApiError) setError(err);
      });
  }, [open]);

  const columns: Array<Column<SupportCase>> = [
    { key: 'n', header: 'Case', render: (c) => <Link href={`/support/${c.caseId}`} className="mono">{c.number}</Link> },
    { key: 'k', header: 'Kind', render: (c) => CASE_KIND[c.kind] },
    { key: 't', header: 'Title', render: (c) => c.title },
    { key: 'o', header: 'Order', render: (c) => <span className="mono">{c.orderNumber}</span> },
    { key: 'c', header: 'Customer', render: (c) => c.customerDisplayName },
    { key: 'by', header: 'Opened by', render: (c) => (c.openedByParty === 'customer' ? 'Customer' : 'JobWork') },
    { key: 's', header: 'Status', render: (c) => <StatusChip tone={CASE_TONE[c.status]}>{c.statusLabel}</StatusChip> },
    { key: 'd', header: 'Opened', render: (c) => c.createdAt.slice(0, 10) },
  ];

  return (
    <Page title="Support cases" description="Delivery issues, warranty claims and disputes, from opening to verified closure." width="wide">
      <Stack gap={4}>
        {error ? <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} /> : null}
        <FilterChips label="Show cases" value={open} options={[{ value: 'true', label: 'Open' }, { value: 'false', label: 'Closed' }]} onChange={setOpen} />
        <Card>
          <DataTable caption="Support cases" columns={columns} rows={cases} rowKey={(c) => c.caseId} loadingLabel="Loading cases" empty={{ title: 'No cases', detail: 'Customers open cases from their portal; JobWork opens them from a delivery exception.' }} />
        </Card>
      </Stack>
    </Page>
  );
}
