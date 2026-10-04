'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { SupplierDirectoryRow } from '@jobwork/contracts';
import {
  Button,
  ButtonLink,
  Card,
  DataTable,
  ErrorState,
  Inline,
  Page,
  Select,
  Stack,
  StatusChip,
  type Column,
  type Tone,
} from '@jobwork/ui';
import { api, ApiError } from '../../lib/api';

/**
 * The supplier directory (F-SO.8, doc 14 §6). Sourcing's question here is never "who
 * exists" — it is "who is stuck, and on what". So the two columns that earn their width
 * are the network state and the count of blocking rows, and the excluded-only filter is
 * one click away.
 */

const STATUS_TONE: Record<string, Tone> = {
  onboarding: 'progress',
  submitted: 'attention',
  active: 'positive',
  paused: 'attention',
  rejected: 'blocked',
  exited: 'neutral',
};

const STATUS_FILTERS = [
  { value: '', label: 'Every supplier' },
  { value: 'submitted', label: 'Waiting for a decision' },
  { value: 'onboarding', label: 'Still being set up' },
  { value: 'active', label: 'In the network' },
  { value: 'paused', label: 'Suspended' },
  { value: 'rejected', label: 'Not accepted' },
];

export default function SupplierDirectoryPage(): React.JSX.Element {
  const router = useRouter();
  const [rows, setRows] = useState<SupplierDirectoryRow[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [status, setStatus] = useState('');
  const [excludedOnly, setExcludedOnly] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const query = new URLSearchParams();
      if (status) query.set('status', status);
      if (excludedOnly) query.set('excludedOnly', 'true');
      const res = await api<{ suppliers: SupplierDirectoryRow[] }>(
        `/suppliers${query.toString() ? `?${query}` : ''}`,
      );
      setRows(res.suppliers);
    } catch (err) {
      if (err instanceof ApiError) setError(err);
      setRows([]);
    }
  }, [status, excludedOnly]);

  useEffect(() => {
    void load();
  }, [load]);

  const columns: Array<Column<SupplierDirectoryRow>> = [
    {
      key: 'displayName',
      header: 'Supplier',
      render: (row) => (
        <Link href={`/suppliers/${row.supplierProfileId}`}>{row.displayName}</Link>
      ),
    },
    { key: 'regionClass', header: 'Region', render: (row) => row.regionClass.replace(/_/g, ' ') },
    {
      key: 'status',
      header: 'Network',
      render: (row) => (
        <StatusChip tone={STATUS_TONE[row.status] ?? 'neutral'}>
          {row.status.replace(/_/g, ' ')}
        </StatusChip>
      ),
    },
    {
      key: 'eligible',
      header: 'Matchable',
      render: (row) =>
        row.eligible ? (
          <StatusChip tone="positive" silent>
            Yes
          </StatusChip>
        ) : (
          <StatusChip tone="blocked" silent>
            {row.exclusions.length > 0 ? row.exclusions.join(', ').replace(/_/g, ' ') : 'No'}
          </StatusChip>
        ),
    },
    {
      key: 'capabilityCount',
      header: 'Capabilities',
      numeric: true,
      render: (row) => row.capabilityCount,
    },
    {
      key: 'blockingCount',
      header: 'Outstanding',
      numeric: true,
      render: (row) => row.blockingCount,
    },
  ];

  return (
    <Page
      title="Suppliers"
      description="Everyone JobWork has admitted, and what each still owes before they can be matched."
      actions={
        <Inline gap={2}>
          <ButtonLink href="/suppliers/verification" variant="secondary">Evidence queue</ButtonLink>
          <ButtonLink href="/suppliers/applications" variant="secondary">Applications</ButtonLink>
          <ButtonLink href="/suppliers/new">Add supplier</ButtonLink>
        </Inline>
      }
    >
      <Stack gap={4}>
        {error ? (
          <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} />
        ) : null}

        <Card title="Filter">
          <Select
            label="Network state"
            value={status}
            options={STATUS_FILTERS}
            onChange={(event) => setStatus(event.target.value)}
          />
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setExcludedOnly((current) => !current)}
          >
            {excludedOnly ? 'Showing only unmatchable' : 'Show only unmatchable'}
          </Button>
        </Card>

        <Card flush>
          <DataTable
            caption="Suppliers with their network state and outstanding items"
            columns={columns}
            rows={rows}
            rowKey={(row) => row.supplierProfileId}
            stackTitle={(row) => row.displayName}
            onRowClick={(row) => router.push(`/suppliers/${row.supplierProfileId}`)}
            loadingLabel="Loading suppliers"
            empty={{
              title: 'No suppliers yet',
              detail: 'Add the first one — JobWork creates the account and invites them in.',
            }}
          />
        </Card>
      </Stack>
    </Page>
  );
}
