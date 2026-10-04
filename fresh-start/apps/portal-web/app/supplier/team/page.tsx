'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Callout,
  Card,
  CommandButton,
  DataTable,
  EmptyState,
  ErrorState,
  LiveRegion,
  LoadingState,
  Page,
  Select,
  Stack,
  TextInput,
  type Column,
} from '@jobwork/ui';
import { api, ApiError } from '../../../lib/api';

/**
 * The supplier's own team (F-SO.7). A workshop is not one person: the estimator who
 * quotes, the production lead who acknowledges the PO and the quality engineer who
 * uploads inspection evidence are usually three people, and each needs their own
 * account rather than a shared login.
 */

interface Member {
  userId: string;
  email: string;
  displayName: string;
  roles: string[];
  status: string;
}

interface PendingInvitation {
  invitationId: string;
  email: string;
  expiresAt: string;
}

const SUPPLIER_ROLES = [
  { value: 'supplier_estimator', label: 'Estimator — reads RFQs and submits bids' },
  { value: 'supplier_production', label: 'Production — acknowledges orders, reports progress' },
  { value: 'supplier_quality', label: 'Quality — inspection evidence and NCR responses' },
  { value: 'org_admin', label: 'Administrator — manages this team' },
];

export default function SupplierTeamPage(): React.JSX.Element {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [pending, setPending] = useState<PendingInvitation[]>([]);
  const [organizationId, setOrganizationId] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('supplier_estimator');

  const load = useCallback(async () => {
    setError(null);
    try {
      const [me, team] = await Promise.all([
        api<{ organizationId: string | null }>('/auth/me'),
        api<{ members: Member[]; pendingInvitations: PendingInvitation[] }>(
          '/organizations/me/members',
        ),
      ]);
      setOrganizationId(me.organizationId);
      setMembers(team.members);
      setPending(team.pendingInvitations);
    } catch (err) {
      if (err instanceof ApiError) setError(err);
      setMembers([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const memberColumns: Array<Column<Member>> = [
    { key: 'displayName', header: 'Name', render: (row: Member) => row.displayName },
    { key: 'email', header: 'Email', render: (row: Member) => row.email },
    { key: 'roles', header: 'Can do', render: (row: Member) => row.roles.join(', ').replace(/_/g, ' ') },
    { key: 'status', header: 'Status', render: (row: Member) => row.status },
  ];

  const invitationColumns: Array<Column<PendingInvitation>> = [
    { key: 'email', header: 'Invited', render: (row: PendingInvitation) => row.email },
    {
      key: 'expiresAt',
      header: 'Invitation expires',
      render: (row: PendingInvitation) => row.expiresAt.slice(0, 10),
    },
  ];

  if (error && members === null) {
    return (
      <Page title="Your team">
        <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} />
      </Page>
    );
  }

  return (
    <Page
      title="Your team"
      breadcrumb={<Link href="/supplier">← Your account</Link>}
      description="Give each person their own sign-in. Roles decide what they can see and do — nobody needs to share a password."
    >
      <Stack gap={4}>
        {notice ? <LiveRegion message={notice} /> : null}
        {error ? (
          <Callout tone="blocked" assertive title={error.problem.title}>
            {error.problem.detail ?? 'That invitation was not sent.'} ({error.problem.code})
          </Callout>
        ) : null}

        <Card title="People with access">
          {members === null ? (
            <LoadingState label="Loading your team" />
          ) : members.length === 0 ? (
            <EmptyState title="Nobody yet" detail="Invite your first colleague below." />
          ) : (
            <DataTable
              caption="People who can sign in for this organization"
              columns={memberColumns}
              rows={members}
              rowKey={(row) => row.userId}
            />
          )}
        </Card>

        {pending.length > 0 ? (
          <Card title="Invitations waiting to be accepted">
            <DataTable
              caption="Invitations that have not been accepted yet"
              columns={invitationColumns}
              rows={pending}
              rowKey={(row) => row.invitationId}
            />
          </Card>
        ) : null}

        <Card
          title="Invite a colleague"
          description="They get an email with a link to set their own password."
        >
          <TextInput
            label="Their work email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Select
            label="What they do"
            value={role}
            options={SUPPLIER_ROLES}
            onChange={(e) => setRole(e.target.value)}
          />
          <CommandButton
            receiptLabel="Invited"
            disabled={!organizationId || email.trim() === ''}
            onCommand={async () => {
              setError(null);
              try {
                await api(`/organizations/${organizationId}/invitations`, {
                  method: 'POST',
                  body: { email: email.trim(), roleKeys: [role] },
                  idempotencyKey: crypto.randomUUID(),
                });
                setNotice(`Invitation sent to ${email.trim()}.`);
                setEmail('');
                await load();
              } catch (err) {
                if (err instanceof ApiError) setError(err);
                throw err;
              }
            }}
          >
            Send invitation
          </CommandButton>
        </Card>
      </Stack>
    </Page>
  );
}
