'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { OrganizationSummary } from '@jobwork/contracts';
import {
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
 * Every organization JobWork deals with, in one list (F-OPS.4): customers, suppliers and
 * JobWork itself. Until now this existed only as API routes, so an administrator had no
 * way to see who was on the platform, who could sign in, or who was waiting on an
 * invitation nobody had noticed had expired.
 *
 * Supplier rows link to the supplier 360 rather than duplicating it — one record, one
 * place, whichever door you came through.
 */

const STATUS_TONE: Record<string, Tone> = {
  active: 'positive',
  suspended: 'attention',
  deactivated: 'neutral',
};

const TYPE_FILTERS = [
  { value: '', label: 'Every organization' },
  { value: 'customer', label: 'Customers' },
  { value: 'supplier', label: 'Suppliers' },
  { value: 'internal', label: 'JobWork' },
];

const STATUS_FILTERS = [
  { value: '', label: 'Any status' },
  { value: 'active', label: 'Active' },
  { value: 'suspended', label: 'Suspended' },
  { value: 'deactivated', label: 'Deactivated' },
];

export default function OrganizationsPage(): React.JSX.Element {
  const router = useRouter();
  const [rows, setRows] = useState<OrganizationSummary[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      const query = new URLSearchParams();
      if (type) query.set('type', type);
      if (status) query.set('status', status);
      const res = await api<{ organizations: OrganizationSummary[] }>(
        `/admin/organizations${query.toString() ? `?${query}` : ''}`,
      );
      setRows(res.organizations);
    } catch (err) {
      if (err instanceof ApiError) setError(err);
      setRows([]);
    }
  }, [type, status]);

  useEffect(() => {
    void load();
  }, [load]);

  const href = (row: OrganizationSummary): string =>
    row.supplierProfileId
      ? `/suppliers/${row.supplierProfileId}`
      : `/organizations/${row.organizationId}`;

  const columns: Array<Column<OrganizationSummary>> = [
    {
      key: 'displayName',
      header: 'Organization',
      render: (row) => <Link href={href(row)}>{row.displayName}</Link>,
    },
    { key: 'type', header: 'Kind', render: (row) => row.type },
    {
      key: 'status',
      header: 'Status',
      render: (row) => (
        <StatusChip tone={STATUS_TONE[row.status] ?? 'neutral'}>{row.status}</StatusChip>
      ),
    },
    {
      key: 'people',
      header: 'People',
      numeric: true,
      render: (row) =>
        row.memberCount === row.activeMemberCount
          ? row.memberCount
          : `${row.activeMemberCount} of ${row.memberCount}`,
    },
    {
      key: 'pendingInvitationCount',
      header: 'Invited',
      numeric: true,
      render: (row) =>
        row.pendingInvitationCount > 0 ? (
          <StatusChip tone="attention" silent>
            {row.pendingInvitationCount} waiting
          </StatusChip>
        ) : (
          '—'
        ),
    },
    { key: 'createdAt', header: 'Added', render: (row) => row.createdAt.slice(0, 10) },
  ];

  return (
    <Page
      title="Organizations and people"
      description="Everyone on the platform: customers, suppliers, and JobWork's own staff."
      actions={
        <Inline gap={2}>
          <ButtonLink href="/suppliers/new" variant="secondary">Admit supplier</ButtonLink>
          <ButtonLink href="/organizations/new">Add customer</ButtonLink>
        </Inline>
      }
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
            label="Kind"
            value={type}
            options={TYPE_FILTERS}
            onChange={(event) => setType(event.target.value)}
          />
          <Select
            label="Status"
            value={status}
            options={STATUS_FILTERS}
            onChange={(event) => setStatus(event.target.value)}
          />
        </Card>

        <Card flush>
          <DataTable
            caption="Organizations with their people and pending invitations"
            columns={columns}
            rows={rows}
            rowKey={(row) => row.organizationId}
            stackTitle={(row) => row.displayName}
            onRowClick={(row) => router.push(href(row))}
            loadingLabel="Loading organizations"
            empty={{
              title: 'No organizations match',
              detail: 'Clear the filters, or add a customer to get started.',
            }}
          />
        </Card>
      </Stack>
    </Page>
  );
}
