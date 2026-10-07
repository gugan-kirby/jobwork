'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { ApprovalRequest, MeResponse } from '@jobwork/contracts';
import {
  Button,
  Callout,
  Card,
  CommandButton,
  CopyableId,
  DataTable,
  ErrorState,
  Page,
  ReasonField,
  Select,
  Stack,
  StatusChip,
  formatMoney,
  type Column,
  type Tone,
} from '@jobwork/ui';
import { api, ApiError } from '../../lib/api';

/**
 * The approval queue (doc 03 §§4–5, doc 14 §9, F-07.3/4/5). Every row names the exact
 * subject version and hash, the policy version it was judged under, and who may decide.
 * The decision panel is the doc 21 approval panel in miniature: subject, authority being
 * used, a reason for anything negative, and a single-flight button.
 */

const KIND_LABEL: Record<ApprovalRequest['kind'], string> = {
  award: 'Award',
  cost_sheet: 'Cost sheet',
  quote: 'Quotation',
  allocation: 'Cash allocation',
  change: 'Engineering change',
  deviation: 'Deviation',
  dispatch_override: 'Dispatch override',
  bill_exception: 'Supplier bill exception',
  case_resolution: 'Case resolution',
};

const STATUS_TONE: Record<ApprovalRequest['status'], Tone> = {
  pending: 'attention',
  approved: 'positive',
  rejected: 'blocked',
  returned: 'neutral',
  superseded: 'neutral',
};

const FILTERS = [
  { value: 'pending', label: 'Waiting' },
  { value: 'approved', label: 'Approved' },
  { value: 'returned', label: 'Returned' },
  { value: 'rejected', label: 'Rejected' },
  { value: '', label: 'All' },
];

export default function ApprovalsPage(): React.JSX.Element {
  const [rows, setRows] = useState<ApprovalRequest[] | null>(null);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [status, setStatus] = useState('pending');
  const [deciding, setDeciding] = useState<ApprovalRequest | null>(null);
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api<{ approvals: ApprovalRequest[] }>(`/approvals${status ? `?status=${status}` : ''}`);
      setRows(res.approvals);
    } catch (err) {
      if (err instanceof ApiError) setError(err);
      setRows([]);
    }
  }, [status]);

  useEffect(() => {
    void load();
    api<MeResponse>('/auth/me').then(setMe).catch(() => setMe(null));
  }, [load]);

  async function decide(decision: 'approved' | 'rejected' | 'returned'): Promise<void> {
    if (!deciding) return;
    await api(`/approvals/${deciding.approvalRequestId}/decide`, {
      method: 'POST',
      body: { decision, reason: reason.trim() },
      idempotencyKey: `decide-${deciding.approvalRequestId}-${decision}`,
    });
    setDeciding(null);
    setReason('');
    await load();
  }

  const mayDecide = (row: ApprovalRequest): boolean =>
    row.status === 'pending' && me !== null && row.requestedBy !== me.userId && row.requiredRoles.some((r) => me.roles.includes(r));

  const columns: Array<Column<ApprovalRequest>> = [
    {
      key: 'subject',
      header: 'What',
      render: (row) => (
        <>
          <Link href={row.href}>{row.title}</Link>
          <br />
          <span style={{ font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>
            {KIND_LABEL[row.kind]}
            {row.subjectVersionNo ? ` v${row.subjectVersionNo}` : ''} · policy v{row.policyVersionNo}
          </span>
        </>
      ),
    },
    {
      key: 'amount',
      header: 'Amount',
      numeric: true,
      render: (row) =>
        row.amountMinor !== null && row.currency ? formatMoney({ amountMinor: row.amountMinor, currency: row.currency }) : '—',
    },
    {
      key: 'margin',
      header: 'Margin',
      numeric: true,
      render: (row) => (row.marginBp !== null ? `${(row.marginBp / 100).toFixed(1)} %` : '—'),
    },
    {
      key: 'who',
      header: 'Asked by',
      render: (row) => `${row.requestedByName || row.requestedBy.slice(0, 8)} · ${row.requestedAt.slice(0, 10)}`,
    },
    {
      key: 'needs',
      header: 'Needs',
      render: (row) => row.requiredRoles.map((r) => r.replace('jobwork_', '')).join(' or '),
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) => <StatusChip tone={STATUS_TONE[row.status]}>{row.status}</StatusChip>,
    },
    {
      key: 'act',
      header: 'Decision',
      render: (row) =>
        row.status !== 'pending' ? (
          <span style={{ color: 'var(--color-text-muted)' }}>
            {row.decisions[0] ? `${row.decisions[0].decision} by ${row.decisions[0].decidedByName || 'someone'}` : '—'}
          </span>
        ) : mayDecide(row) ? (
          <Button size="sm" onClick={() => setDeciding(row)}>
            Decide…
          </Button>
        ) : (
          <span style={{ font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>
            {me && row.requestedBy === me.userId ? 'yours to ask, not to decide' : 'not your authority'}
          </span>
        ),
    },
  ];

  return (
    <Page
      title="Approvals"
      description="Awards, cost sheets, quotations, cash allocations, engineering changes and dispatch overrides waiting for a second pair of eyes. The requester never decides."
      width="wide"
      actions={<Select label="Show" value={status} options={FILTERS} onChange={(event) => setStatus(event.target.value)} />}
    >
      <Stack gap={4}>
        {error ? <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} /> : null}

        {deciding ? (
          <Card
            title={`Decide: ${deciding.title}`}
            description={`${KIND_LABEL[deciding.kind]}${deciding.subjectVersionNo ? ` v${deciding.subjectVersionNo}` : ''} · judged under policy v${deciding.policyVersionNo} · asked by ${deciding.requestedByName}`}
          >
            <Stack gap={3}>
              <CopyableId label="Subject hash" value={deciding.subjectHash} />
              {deciding.kind === 'dispatch_override' ? (
                <Callout tone="attention" title="Letting it leave despite">
                  <ul>
                    {((deciding.context as { reasons?: string[] }).reasons ?? []).map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                  <p>Logistics says: {String((deciding.context as { justification?: string }).justification ?? '')}</p>
                  <p>Your approval covers exactly these reasons; a new one turns the guard red again.</p>
                </Callout>
              ) : null}
              {(deciding.context as { exception?: string | null }).exception ? (
                <Callout tone="attention" title="This is an exception">
                  {String((deciding.context as { exception?: string }).exception).replace(/_/g, ' ')} — your approval is the recorded sign-off.
                </Callout>
              ) : null}
              <p style={{ font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>
                Deciding as: {me?.roles.filter((r) => deciding.requiredRoles.includes(r)).join(', ')}. The decision is permanent and audited.
              </p>
              <ReasonField label="Reason (required unless approving)" audience="internal" value={reason} onChange={setReason} />
              <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                <CommandButton receiptLabel="Approved" onCommand={() => decide('approved')}>
                  Approve
                </CommandButton>
                {deciding.kind !== 'award' ? (
                  <CommandButton variant="secondary" receiptLabel="Returned" disabled={reason.trim().length < 3} disabledReason="Say what to change" onCommand={() => decide('returned')}>
                    Return for changes
                  </CommandButton>
                ) : null}
                <CommandButton variant="danger" receiptLabel="Rejected" disabled={reason.trim().length < 3} disabledReason="Say why" onCommand={() => decide('rejected')}>
                  Reject
                </CommandButton>
                <Button variant="ghost" onClick={() => setDeciding(null)}>
                  Cancel
                </Button>
              </div>
            </Stack>
          </Card>
        ) : null}

        <Card flush>
          <DataTable
            caption="Approval requests"
            columns={columns}
            rows={rows}
            rowKey={(row) => row.approvalRequestId}
            loadingLabel="Loading approvals"
            stackTitle={(row) => row.title}
            empty={{
              title: status === 'pending' ? 'Nothing waiting' : 'Nothing here',
              detail: status === 'pending' ? 'Awards, cost sheets, quotations, cash allocations, engineering changes and dispatch overrides arrive here when somebody asks for approval.' : 'No requests with that status.',
            }}
          />
        </Card>
      </Stack>
    </Page>
  );
}
