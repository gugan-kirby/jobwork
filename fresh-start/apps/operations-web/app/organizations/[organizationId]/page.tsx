'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { OrganizationDetail } from '@jobwork/contracts';
import {
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
  Select,
  Stack,
  StatusChip,
  TextInput,
  type Column,
  type Tone,
} from '@jobwork/ui';
import { api, ApiError } from '../../../lib/api';

/**
 * One organization and everyone in it (F-OPS.4): who can sign in, who is suspended, who
 * was invited and never arrived. Every action here has its mirror — suspend/reinstate,
 * invite/resend — because an administrator who cannot undo a mistake stops using the
 * commands at all, and then nobody is ever suspended.
 */

const STATUS_TONE: Record<string, Tone> = {
  active: 'positive',
  suspended: 'attention',
  deactivated: 'neutral',
  ended: 'neutral',
};

const ROLES_BY_TYPE: Record<string, Array<{ value: string; label: string }>> = {
  customer: [
    { value: 'org_admin', label: 'Administrator' },
    { value: 'customer_requester', label: 'Requester' },
    { value: 'customer_approver', label: 'Approver' },
  ],
  supplier: [
    { value: 'org_admin', label: 'Administrator' },
    { value: 'supplier_estimator', label: 'Estimator' },
    { value: 'supplier_production', label: 'Production' },
    { value: 'supplier_quality', label: 'Quality' },
  ],
  internal: [
    { value: 'jobwork_sourcing', label: 'Sourcing' },
    { value: 'jobwork_engineering', label: 'Engineering' },
    { value: 'jobwork_quality', label: 'Quality' },
    { value: 'jobwork_finance', label: 'Finance' },
    { value: 'jobwork_logistics', label: 'Logistics' },
    { value: 'jobwork_support', label: 'Support' },
    { value: 'jobwork_sales', label: 'Sales' },
    { value: 'platform_admin', label: 'Platform administrator' },
    { value: 'security_admin', label: 'Security administrator' },
    { value: 'auditor', label: 'Auditor' },
  ],
};

export default function OrganizationDetailPage(): React.JSX.Element {
  const params = useParams<{ organizationId: string }>();
  const organizationId = params.organizationId;
  const [detail, setDetail] = useState<OrganizationDetail | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState('');
  const [reason, setReason] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      const next = await api<OrganizationDetail>(`/admin/organizations/${organizationId}`);
      setDetail(next);
      setInviteRole((current) => current || (ROLES_BY_TYPE[next.organization.type]?.[0]?.value ?? ''));
    } catch (err) {
      if (err instanceof ApiError) setError(err);
    }
  }, [organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function command(path: string, body: unknown, message: string): Promise<void> {
    setError(null);
    try {
      await api(path, { method: 'POST', body, idempotencyKey: crypto.randomUUID() });
      setNotice(message);
      setReason('');
      await load();
    } catch (err) {
      if (err instanceof ApiError) setError(err);
      throw err;
    }
  }

  if (error && !detail) {
    return (
      <Page title="Organization" breadcrumb={<Link href="/organizations">← Organizations</Link>}>
        <ErrorState
          message={error.problem.detail ?? error.problem.title}
          code={error.problem.code}
        />
      </Page>
    );
  }

  if (!detail) {
    return (
      <Page title="Organization" breadcrumb={<Link href="/organizations">← Organizations</Link>}>
        <Card>
          <LoadingState label="Loading the organization" />
        </Card>
      </Page>
    );
  }

  const { organization, members, invitations } = detail;
  const roleOptions = ROLES_BY_TYPE[organization.type] ?? [];

  const memberColumns: Array<Column<OrganizationDetail['members'][number]>> = [
    {
      key: 'person',
      header: 'Person',
      render: (row) => (
        <>
          {row.displayName}
          <br />
          <span style={{ font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>
            {row.email}
          </span>
        </>
      ),
    },
    { key: 'roles', header: 'Roles', render: (row) => row.roles.join(', ').replace(/_/g, ' ') },
    {
      key: 'membershipStatus',
      header: 'Membership',
      render: (row) => (
        <StatusChip tone={STATUS_TONE[row.membershipStatus] ?? 'neutral'}>
          {row.membershipStatus}
        </StatusChip>
      ),
    },
    {
      key: 'userStatus',
      header: 'Account',
      render: (row) => (
        <StatusChip tone={STATUS_TONE[row.userStatus] ?? 'neutral'}>{row.userStatus}</StatusChip>
      ),
    },
    {
      key: 'mfaEnrolled',
      header: 'Two-factor',
      render: (row) =>
        row.mfaEnrolled ? (
          <StatusChip tone="positive" silent>
            Enrolled
          </StatusChip>
        ) : (
          <StatusChip tone="attention" silent>
            No
          </StatusChip>
        ),
    },
    {
      key: 'lastSignInAt',
      header: 'Last sign-in',
      render: (row) => (row.lastSignInAt ? row.lastSignInAt.slice(0, 10) : 'never'),
    },
    {
      key: 'actions',
      header: 'Access',
      render: (row) => (
        <Inline gap={2}>
          {row.membershipStatus === 'active' ? (
            <CommandButton
              size="sm"
              variant="danger"
              receiptLabel="Suspended"
              onCommand={() =>
                command(
                  `/admin/memberships/${row.membershipId}/suspend`,
                  {},
                  `${row.email} can no longer sign in here.`,
                )
              }
            >
              Suspend
            </CommandButton>
          ) : (
            <CommandButton
              size="sm"
              variant="secondary"
              receiptLabel="Reinstated"
              onCommand={() =>
                command(
                  `/admin/memberships/${row.membershipId}/reinstate`,
                  reason.trim() ? { reason: reason.trim() } : {},
                  `${row.email} can sign in again.`,
                )
              }
            >
              Reinstate
            </CommandButton>
          )}
          {row.userStatus === 'suspended' ? (
            <CommandButton
              size="sm"
              variant="secondary"
              receiptLabel="Account restored"
              onCommand={() =>
                command(
                  `/admin/users/${row.userId}/reinstate`,
                  reason.trim() ? { reason: reason.trim() } : {},
                  `${row.email}'s account is active again.`,
                )
              }
            >
              Restore account
            </CommandButton>
          ) : null}
        </Inline>
      ),
    },
  ];

  const invitationColumns: Array<Column<OrganizationDetail['invitations'][number]>> = [
    { key: 'email', header: 'Invited', render: (row) => row.email },
    {
      key: 'proposedRoleKeys',
      header: 'As',
      render: (row) => row.proposedRoleKeys.join(', ').replace(/_/g, ' '),
    },
    {
      key: 'expiresAt',
      header: 'Link',
      render: (row) =>
        row.expired ? (
          <StatusChip tone="blocked">expired {row.expiresAt.slice(0, 10)}</StatusChip>
        ) : (
          <StatusChip tone="progress">valid to {row.expiresAt.slice(0, 10)}</StatusChip>
        ),
    },
    {
      key: 'actions',
      header: 'Action',
      render: (row) => (
        <Inline gap={2}>
          <CommandButton
            size="sm"
            variant="secondary"
            receiptLabel="Resent"
            onCommand={() =>
              command(
                `/admin/organizations/${organizationId}/invitations/${row.invitationId}/resend`,
                {},
                `A fresh invitation is on its way to ${row.email}; the old link no longer works.`,
              )
            }
          >
            Resend
          </CommandButton>
          <CommandButton
            size="sm"
            variant="danger"
            receiptLabel="Revoked"
            onCommand={() =>
              command(
                `/organizations/${organizationId}/invitations/${row.invitationId}/revoke`,
                {},
                `The invitation to ${row.email} is cancelled.`,
              )
            }
          >
            Revoke
          </CommandButton>
        </Inline>
      ),
    },
  ];

  return (
    <Page
      title={organization.displayName}
      breadcrumb={<Link href="/organizations">← Organizations</Link>}
      description={organization.legalName}
      width="wide"
      actions={
        <Inline gap={2}>
          <StatusChip tone={STATUS_TONE[organization.status] ?? 'neutral'}>
            {organization.status}
          </StatusChip>
          <StatusChip tone="neutral" silent>
            {organization.type}
          </StatusChip>
        </Inline>
      }
    >
      <Stack gap={4}>
        {notice ? <LiveRegion message={notice} /> : null}
        {error ? (
          <Callout tone="blocked" assertive title={error.problem.title}>
            {error.problem.detail ?? 'That command did not go through.'} ({error.problem.code})
          </Callout>
        ) : null}

        {organization.status !== 'active' ? (
          <Callout tone="attention" title="This organization is suspended">
            Nobody in it can work in the product until it is reinstated.
          </Callout>
        ) : null}

        {organization.supplierProfileId ? (
          <Callout tone="neutral" title="This is a supplier">
            Capabilities, evidence and admission live on the{' '}
            <Link href={`/suppliers/${organization.supplierProfileId}`}>supplier record</Link>.
          </Callout>
        ) : null}

        <Card title="Organization">
          <DescriptionList
            columns={2}
            items={[
              { label: 'Kind', value: organization.type },
              { label: 'Status', value: organization.status },
              {
                label: 'People',
                value: `${organization.activeMemberCount} active of ${organization.memberCount}`,
              },
              {
                label: 'Invitations outstanding',
                value: String(organization.pendingInvitationCount),
                numeric: true,
              },
              { label: 'Added', value: organization.createdAt.slice(0, 10) },
            ]}
          />
          <div style={{ marginTop: 'var(--space-3)' }}>
            <CopyableId label="Organization id" value={organization.organizationId} />
          </div>
          <p style={{ marginTop: 'var(--space-3)' }}>
            <Link href={`/audit?aboutOrganizationId=${organization.organizationId}`}>
              Everything that has happened to this organization →
            </Link>
          </p>
        </Card>

        <Card title="People" description="Suspending a membership signs them out immediately." flush>
          <DataTable
            caption="People who can sign in for this organization"
            columns={memberColumns}
            rows={members}
            rowKey={(row) => row.membershipId}
            stackTitle={(row) => row.email}
            empty={{
              title: 'Nobody has accepted yet',
              detail: 'Invite someone below, or resend an outstanding invitation.',
            }}
          />
        </Card>

        <Card title="Invitations" description="Resending replaces the old link; it stops working." flush>
          <DataTable
            caption="Invitations that have not been accepted"
            columns={invitationColumns}
            rows={invitations}
            rowKey={(row) => row.invitationId}
            stackTitle={(row) => row.email}
            empty={{ title: 'None outstanding', detail: 'Everybody invited has joined.' }}
          />
        </Card>

        <Card title="Invite somebody">
          <TextInput
            label="Their work email"
            required
            value={inviteEmail}
            onChange={(event) => setInviteEmail(event.target.value)}
          />
          <Select
            label="What they do"
            value={inviteRole}
            options={roleOptions}
            onChange={(event) => setInviteRole(event.target.value)}
          />
          <CommandButton
            receiptLabel="Invited"
            disabled={inviteEmail.trim() === '' || inviteRole === ''}
            onCommand={async () => {
              await command(
                `/organizations/${organizationId}/invitations`,
                { email: inviteEmail.trim(), roleKeys: [inviteRole] },
                `Invitation sent to ${inviteEmail.trim()}.`,
              );
              setInviteEmail('');
            }}
          >
            Send invitation
          </CommandButton>
        </Card>

        <Card
          title="Organization access"
          description="Suspension takes everyone in this organization out of the product at once."
        >
          <ReasonField label="Reason" audience="internal" value={reason} onChange={setReason} />
          <Inline gap={2}>
            {organization.status === 'active' ? (
              <CommandButton
                variant="danger"
                receiptLabel="Suspended"
                onCommand={() => {
                  if (reason.trim().length < 3) {
                    throw new Error('Say why — this is recorded against the organization.');
                  }
                  return command(
                    `/admin/organizations/${organizationId}/suspend`,
                    { reason: reason.trim() },
                    `${organization.displayName} is suspended.`,
                  );
                }}
              >
                Suspend organization
              </CommandButton>
            ) : (
              <CommandButton
                receiptLabel="Reinstated"
                onCommand={() =>
                  command(
                    `/admin/organizations/${organizationId}/reinstate`,
                    reason.trim() ? { reason: reason.trim() } : {},
                    `${organization.displayName} is active again.`,
                  )
                }
              >
                Reinstate organization
              </CommandButton>
            )}
          </Inline>
        </Card>
      </Stack>
    </Page>
  );
}
