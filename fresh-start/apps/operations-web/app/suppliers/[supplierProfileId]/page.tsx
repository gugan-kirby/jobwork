'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { SupplierDetail } from '@jobwork/contracts';
import {
  ButtonLink,
  Callout,
  Card,
  CommandButton,
  CopyableId,
  DataTable,
  DescriptionList,
  ErrorState,
  Inline,
  LiveRegion,
  LoadingState,
  Page,
  ReasonField,
  Stack,
  StatusChip,
  type Column,
  type Tone,
} from '@jobwork/ui';
import { api, ApiError } from '../../../lib/api';

/**
 * Supplier 360 (F-SO.8, doc 14 §6). One screen holds what the reviewer needs to decide:
 * who the company is, what it still owes, what it can prove, and what it says it can do.
 *
 * The decisions live at the bottom for a reason — a reviewer should scroll past the
 * evidence before signing anything — and every negative one insists on a reason the
 * supplier will read.
 */

const STATUS_TONE: Record<string, Tone> = {
  onboarding: 'progress',
  submitted: 'attention',
  active: 'positive',
  paused: 'attention',
  rejected: 'blocked',
  exited: 'neutral',
};

export default function SupplierDetailPage(): React.JSX.Element {
  const params = useParams<{ supplierProfileId: string }>();
  const supplierProfileId = params.supplierProfileId;
  const [detail, setDetail] = useState<SupplierDetail | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState('');
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      setDetail(await api<SupplierDetail>(`/suppliers/${supplierProfileId}`));
    } catch (err) {
      if (err instanceof ApiError) setError(err);
    }
  }, [supplierProfileId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(action: string, needsReason: boolean): Promise<void> {
    if (!detail) return;
    if (needsReason && reason.trim().length < 3) {
      throw new Error('Say why — the supplier reads this.');
    }
    await api(`/suppliers/${supplierProfileId}/${action}`, {
      method: 'POST',
      body: {
        expectedVersion: detail.profile.aggregateVersion,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      },
      idempotencyKey: `${action}:${supplierProfileId}:${detail.profile.aggregateVersion}`,
    });
    setReason('');
    setNotice(`Supplier ${action}d.`);
    await load();
  }

  if (error) {
    return (
      <Page title="Supplier" breadcrumb={<Link href="/suppliers">← Suppliers</Link>}>
        <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} />
      </Page>
    );
  }

  if (!detail) {
    return (
      <Page title="Supplier" breadcrumb={<Link href="/suppliers">← Suppliers</Link>}>
        <Card>
          <LoadingState label="Loading the supplier" />
        </Card>
      </Page>
    );
  }

  const { profile } = detail;
  const blocking = detail.checklist.filter((row) => row.blocking);

  const checklistColumns: Array<Column<SupplierDetail['checklist'][number]>> = [
    {
      key: 'state',
      header: 'State',
      render: (row) => (
        <StatusChip tone={row.state === 'complete' ? 'positive' : row.blocking ? 'blocked' : 'progress'}>
          {row.state}
        </StatusChip>
      ),
    },
    { key: 'label', header: 'Item', render: (row) => row.label },
    { key: 'detail', header: 'Detail', render: (row) => row.detail },
  ];

  const verificationColumns: Array<Column<SupplierDetail['verification'][number]>> = [
    { key: 'kind', header: 'Evidence', render: (row) => row.kind.replace(/_/g, ' ') },
    { key: 'versionNo', header: 'v', numeric: true, render: (row) => row.versionNo },
    {
      key: 'status',
      header: 'Status',
      render: (row) => (
        <StatusChip
          tone={
            row.status === 'verified'
              ? 'positive'
              : row.status === 'expiring'
                ? 'attention'
                : ['expired', 'revoked', 'returned_for_evidence'].includes(row.status)
                  ? 'blocked'
                  : 'progress'
          }
        >
          {row.status.replace(/_/g, ' ')}
        </StatusChip>
      ),
    },
    { key: 'referenceValue', header: 'Number', render: (row) => row.referenceValue ?? '—' },
    {
      key: 'expiresAt',
      header: 'Valid to',
      render: (row) => (row.expiresAt ? row.expiresAt.slice(0, 10) : '—'),
    },
    { key: 'reviewReason', header: 'Reviewer note', render: (row) => row.reviewReason ?? '' },
  ];

  const memberColumns: Array<Column<SupplierDetail['members'][number]>> = [
    { key: 'email', header: 'User', render: (row) => row.email },
    { key: 'roles', header: 'Roles', render: (row) => row.roles.join(', ').replace(/_/g, ' ') },
    { key: 'status', header: 'Status', render: (row) => row.status },
  ];

  const invitationColumns: Array<Column<SupplierDetail['pendingInvitations'][number]>> = [
    { key: 'email', header: 'Invited', render: (row) => row.email },
    { key: 'expiresAt', header: 'Link valid to', render: (row) => row.expiresAt.slice(0, 10) },
    {
      key: 'actions',
      header: 'Action',
      render: (row) => (
        <CommandButton
          size="sm"
          variant="secondary"
          receiptLabel="Resent"
          onCommand={async () => {
            await api(
              `/admin/organizations/${profile.organizationId}/invitations/${row.invitationId}/resend`,
              { method: 'POST', body: {}, idempotencyKey: crypto.randomUUID() },
            );
            setNotice(`A fresh invitation is on its way to ${row.email}.`);
            await load();
          }}
        >
          Resend
        </CommandButton>
      ),
    },
  ];

  return (
    <Page
      title={profile.displayName}
      breadcrumb={<Link href="/suppliers">← Suppliers</Link>}
      description={profile.legalName}
      actions={
        <Inline gap={2}>
          <StatusChip tone={STATUS_TONE[profile.status] ?? 'neutral'}>
            {profile.status.replace(/_/g, ' ')}
          </StatusChip>
          <StatusChip tone={detail.eligible ? 'positive' : 'blocked'}>
            {detail.eligible ? 'matchable' : 'not matchable'}
          </StatusChip>
          {!profile.acceptingWork ? (
            <StatusChip tone="attention">not taking work</StatusChip>
          ) : null}
        </Inline>
      }
    >
      <Stack gap={4}>
        {notice ? <LiveRegion message={notice} /> : null}

        {profile.status === 'submitted' ? (
          <Callout tone="attention" title="This file is waiting on a decision">
            Submitted {profile.submittedAt?.slice(0, 10)}. Approving admits them to the network;
            returning sends it back with your reason and keeps their evidence intact.
          </Callout>
        ) : null}

        {detail.exclusions.length > 0 ? (
          <Callout tone="blocked" title="Why they are not matchable">
            {detail.exclusions.join(', ').replace(/_/g, ' ')}
          </Callout>
        ) : null}

        <Card title="Company">
          <DescriptionList
            columns={2}
            items={[
              { label: 'Trade name', value: profile.tradeName || '—' },
              { label: 'Region', value: profile.regionClass.replace(/_/g, ' ') },
              { label: 'Contact', value: profile.primaryContactName || '—' },
              { label: 'Email', value: profile.primaryContactEmail || '—' },
              { label: 'Phone', value: profile.primaryContactPhone || '—' },
              { label: 'Established', value: profile.yearEstablished?.toString() ?? '—' },
              { label: 'Size', value: profile.employeeBand ?? '—' },
              { label: 'Website', value: profile.website || '—' },
              {
                label: 'Works address',
                value: profile.worksSite
                  ? `${profile.worksSite.addressLine1}, ${profile.worksSite.city}, ${profile.worksSite.state} ${profile.worksSite.postalCode}`
                  : 'Not given yet',
              },
              { label: 'What they make', value: profile.summary || '—' },
              {
                // Their own statement, not a suspension: the console must not read the
                // two as the same thing (F-SN).
                label: 'Taking work',
                value: profile.acceptingWork
                  ? 'Yes'
                  : `No${profile.acceptingWorkUntil ? ` — back on ${profile.acceptingWorkUntil}` : ''}${
                      profile.acceptingWorkNote ? ` · ${profile.acceptingWorkNote}` : ''
                    }`,
              },
            ]}
          />
          <div style={{ marginTop: 'var(--space-3)' }}>
            <CopyableId label="Supplier profile" value={profile.supplierProfileId} />
          </div>
          <p style={{ marginTop: 'var(--space-3)' }}>
            <Link
              href={`/audit?subjectType=supplier_profile&subjectId=${profile.supplierProfileId}`}
            >
              Everything that has happened to this supplier →
            </Link>
          </p>
        </Card>

        <Card title="Onboarding checklist" description={`${blocking.length} outstanding.`} flush>
          <DataTable
            caption="What the supplier still owes before admission"
            columns={checklistColumns}
            rows={detail.checklist}
            rowKey={(row) => row.key}
            stackTitle={(row) => row.label}
          />
        </Card>

        <Card
          title="Evidence"
          description="Decide individual items in the evidence queue; this is the current state of each."
          flush
        >
          <DataTable
            caption="Verification items and their states"
            columns={verificationColumns}
            rows={detail.verification}
            rowKey={(row) => row.verificationItemId}
            stackTitle={(row) => row.kind.replace(/_/g, ' ')}
            empty={{ title: 'No evidence yet', detail: 'Nothing has been submitted.' }}
          />
        </Card>

        <Card title="Declared capability">
          <DescriptionList
            columns={2}
            items={[
              { label: 'Published capabilities', value: String(detail.capabilityCount), numeric: true },
              { label: 'Machines', value: String(detail.machineCount), numeric: true },
              {
                label: 'Certifications',
                value:
                  detail.certifications.length === 0
                    ? '—'
                    : detail.certifications
                        .map((cert) => `${cert.certificationType} (${cert.status})`)
                        .join(', '),
              },
            ]}
          />
        </Card>

        <Card
          title="Their people"
          description="Access, roles and invitations are administered on the organization record."
          actions={
            <ButtonLink
              href={`/organizations/${profile.organizationId}`}
              variant="secondary"
              size="sm"
            >
              Manage access
            </ButtonLink>
          }
          flush
        >
          <DataTable
            caption="Users inside the supplier organization"
            columns={memberColumns}
            rows={detail.members}
            rowKey={(row) => row.userId}
            stackTitle={(row) => row.email}
            empty={{
              title: 'Nobody has accepted yet',
              detail:
                detail.pendingInvitations.length > 0
                  ? `Invitation outstanding for ${detail.pendingInvitations[0]!.email}.`
                  : 'No users and no pending invitations.',
            }}
          />
        </Card>

        {detail.pendingInvitations.length > 0 ? (
          <Card
            title="Invitations outstanding"
            description="A supplier that never signed in is usually a link that went stale, not a supplier that changed its mind."
            flush
          >
            <DataTable
              caption="Invitations to this supplier that nobody has accepted"
              columns={invitationColumns}
              rows={detail.pendingInvitations}
              rowKey={(row) => row.invitationId}
              stackTitle={(row) => row.email}
            />
          </Card>
        ) : null}

        <Card
          title="Decision"
          description="Approval re-reads the checklist at this moment. Anything that lapsed since they submitted stops it."
        >
          <ReasonField
            label="Reason"
            audience="supplier"
            value={reason}
            onChange={setReason}
          />
          <Inline gap={2}>
            {profile.status === 'submitted' ? (
              <>
                <CommandButton
                  receiptLabel="Approved"
                  disabled={blocking.length > 0}
                  onCommand={() => decide('approve', false)}
                >
                  Approve and admit
                </CommandButton>
                <CommandButton
                  variant="secondary"
                  receiptLabel="Returned"
                  onCommand={() => decide('return', true)}
                >
                  Return for changes
                </CommandButton>
                <CommandButton
                  variant="danger"
                  receiptLabel="Rejected"
                  onCommand={() => decide('reject', true)}
                >
                  Reject
                </CommandButton>
              </>
            ) : null}
            {profile.status === 'active' ? (
              <CommandButton
                variant="danger"
                receiptLabel="Suspended"
                onCommand={() => decide('suspend', true)}
              >
                Suspend from matching
              </CommandButton>
            ) : null}
            {profile.status === 'paused' ? (
              <CommandButton receiptLabel="Reinstated" onCommand={() => decide('reinstate', false)}>
                Reinstate
              </CommandButton>
            ) : null}
            {profile.status !== 'exited' ? (
              <CommandButton
                variant="danger"
                receiptLabel="Offboarded"
                onCommand={async () => {
                  if (reason.trim().length < 3) {
                    throw new Error('Say why — offboarding is permanent and audited.');
                  }
                  await api(`/suppliers/${supplierProfileId}/exit`, {
                    method: 'POST',
                    // Confirmed by name on both sides: the same guard the supplier faces.
                    body: { confirmation: profile.displayName, reason: reason.trim() },
                    idempotencyKey: `exit:${supplierProfileId}`,
                  });
                  setReason('');
                  setNotice(`${profile.displayName} has left the network.`);
                  await load();
                }}
              >
                Offboard from the network
              </CommandButton>
            ) : null}
            {profile.status === 'onboarding' ? (
              <CommandButton
                variant="danger"
                receiptLabel="Rejected"
                onCommand={() => decide('reject', true)}
              >
                Reject this application
              </CommandButton>
            ) : null}
          </Inline>
          {blocking.length > 0 && profile.status === 'submitted' ? (
            <p style={{ font: 'var(--text-caption)', color: 'var(--status-blocked-fg)' }}>
              Approval is unavailable while {blocking.length} checklist item
              {blocking.length === 1 ? '' : 's'} remain outstanding.
            </p>
          ) : null}
          {profile.decisionReason ? (
            <p style={{ font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>
              Last decision: {profile.decisionReason} ({profile.decidedAt?.slice(0, 10)})
            </p>
          ) : null}
        </Card>
      </Stack>
    </Page>
  );
}
