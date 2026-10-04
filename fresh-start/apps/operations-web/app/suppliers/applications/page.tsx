'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { SupplierApplication } from '@jobwork/contracts';
import {
  Button,
  ButtonLink,
  Card,
  CommandButton,
  DataTable,
  ErrorState,
  Page,
  ReasonField,
  Select,
  Stack,
  StatusChip,
  type Column,
  type Tone,
} from '@jobwork/ui';
import { api, ApiError } from '../../../lib/api';

/**
 * Workshops asking to join (F-MX.4). Two decisions per row and nothing else: admit —
 * which opens the admission form with the application's details filled in — or decline
 * with a reason. Nothing here is matched, verified, or visible to a customer.
 */

const TONE: Record<SupplierApplication['status'], Tone> = {
  received: 'attention',
  admitted: 'positive',
  declined: 'neutral',
};

const FILTERS = [
  { value: 'received', label: 'Waiting for a decision' },
  { value: 'admitted', label: 'Admitted' },
  { value: 'declined', label: 'Declined' },
  { value: '', label: 'All' },
];

export default function ApplicationsPage(): React.JSX.Element {
  const [rows, setRows] = useState<SupplierApplication[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [status, setStatus] = useState('received');
  const [declining, setDeclining] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api<{ applications: SupplierApplication[] }>(
        `/supplier-applications${status ? `?status=${status}` : ''}`,
      );
      setRows(res.applications);
    } catch (err) {
      if (err instanceof ApiError) setError(err);
      setRows([]);
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  async function decline(applicationId: string): Promise<void> {
    await api(`/supplier-applications/${applicationId}/decline`, {
      method: 'POST',
      body: { reason },
      idempotencyKey: `decline-${applicationId}`,
    });
    setDeclining(null);
    setReason('');
    await load();
  }

  const columns: Array<Column<SupplierApplication>> = [
    {
      key: 'company',
      header: 'Workshop',
      render: (row) => (
        <>
          <strong>{row.companyName}</strong>
          <br />
          <span style={{ font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>
            {row.contactName} · {row.email}
            {row.phone ? ` · ${row.phone}` : ''}
            {row.city ? ` · ${row.city}` : ''}
          </span>
        </>
      ),
    },
    {
      key: 'processes',
      header: 'Claims',
      render: (row) => (row.processCodes.length ? row.processCodes.map((c) => c.replace(/_/g, ' ')).join(', ') : '—'),
    },
    {
      key: 'received',
      header: 'Received',
      render: (row) => row.createdAt.slice(0, 10),
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) => (
        <StatusChip tone={TONE[row.status]}>
          {row.status}
          {row.status === 'declined' && row.decisionReason ? ` — ${row.decisionReason}` : ''}
        </StatusChip>
      ),
    },
    {
      key: 'actions',
      header: 'Decision',
      render: (row) =>
        row.status === 'received' ? (
          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            <ButtonLink href={`/suppliers/new?application=${row.applicationId}`} size="sm">
              Admit…
            </ButtonLink>
            <Button size="sm" variant="secondary" onClick={() => setDeclining(row.applicationId)}>
              Decline…
            </Button>
          </div>
        ) : row.admittedOrganizationId ? (
          <Link href={`/organizations/${row.admittedOrganizationId}`}>Open organization</Link>
        ) : null,
    },
  ];

  const target = rows?.find((row) => row.applicationId === declining) ?? null;

  return (
    <Page
      title="Supplier applications"
      breadcrumb={<Link href="/suppliers">← Suppliers</Link>}
      description="Workshops that asked to join through the public form. Admit to create their account and invite them; decline with a reason."
      width="wide"
      actions={
        <Select
          label="Show"
          value={status}
          options={FILTERS}
          onChange={(event) => setStatus(event.target.value)}
        />
      }
    >
      <Stack gap={4}>
        {error ? (
          <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} />
        ) : null}

        {target ? (
          <Card
            title={`Decline ${target.companyName}`}
            description="The reason is recorded with the decision; the workshop is not told it automatically."
          >
            <ReasonField audience="internal" value={reason} onChange={setReason} />
            <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
              <CommandButton
                variant="danger"
                receiptLabel="Declined"
                disabled={reason.trim().length < 3}
                disabledReason="Give a reason"
                onCommand={() => decline(target.applicationId)}
              >
                Decline application
              </CommandButton>
              <Button variant="secondary" onClick={() => setDeclining(null)}>
                Cancel
              </Button>
            </div>
          </Card>
        ) : null}

        <Card flush>
          <DataTable
            caption="Supplier applications"
            columns={columns}
            rows={rows}
            rowKey={(row) => row.applicationId}
            loadingLabel="Loading applications"
            stackTitle={(row) => row.companyName}
            empty={{
              title: status === 'received' ? 'No applications waiting' : 'Nothing here',
              detail:
                status === 'received'
                  ? 'Workshops apply through the public register page. New applications appear here and on the home screen.'
                  : 'No applications with that status.',
            }}
          />
        </Card>
      </Stack>
    </Page>
  );
}
