'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Button,
  Callout,
  Card,
  CommandButton,
  CopyableId,
  DataTable,
  ErrorState,
  LoadingState,
  Page,
  Stack,
  StatusChip,
  TextInput,
  type Column,
} from '@jobwork/ui';
import { purgeOfflineCaches } from '@jobwork/web-kit';
import { api, ApiError } from '../../../lib/api';

interface SessionInfo {
  id: string;
  current: boolean;
  lastSeenAt: string;
  createdAt: string;
  ip: string | null;
  userAgent: string | null;
}

interface Me {
  email: string;
  displayName: string;
  mfaEnrolled: boolean;
}

/**
 * Account security (doc 20 §5, UC-36): second factor and live sessions.
 *
 * Recovery codes are shown exactly once, so the page says so before they scroll past.
 * Session revocation is a `CommandButton` because it is a real state change someone may
 * click twice in a hurry when they think a device is compromised.
 */
export default function SecurityPage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [enroll, setEnroll] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  const refresh = useCallback(async () => {
    try {
      setMe(await api<Me>('/auth/me'));
      const res = await api<{ sessions: SessionInfo[] }>('/account/sessions');
      setSessions(res.sessions);
    } catch (err) {
      if (err instanceof ApiError && err.problem.status === 401) router.push('/login');
      else if (err instanceof ApiError) setError(err);
    }
  }, [router]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function startEnroll(): Promise<void> {
    setError(null);
    try {
      setEnroll(await api('/account/mfa/enroll', { method: 'POST' }));
    } catch (err) {
      if (err instanceof ApiError) setError(err);
    }
  }

  async function activate(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    try {
      const res = await api<{ recoveryCodes: string[] }>('/account/mfa/activate', {
        method: 'POST',
        body: { code },
      });
      setRecoveryCodes(res.recoveryCodes);
      setEnroll(null);
      await refresh();
    } catch (err) {
      if (err instanceof ApiError) setError(err);
    }
  }

  const columns: ReadonlyArray<Column<SessionInfo>> = [
    {
      key: 'device',
      header: 'Device',
      render: (session) => (
        <>
          {session.current ? <StatusChip tone="progress">This device</StatusChip> : null}{' '}
          {session.userAgent?.slice(0, 60) ?? 'Unknown device'}
          {session.ip ? (
            <span style={{ color: 'var(--color-text-muted)' }}> · {session.ip}</span>
          ) : null}
        </>
      ),
    },
    {
      key: 'lastSeen',
      header: 'Last active',
      render: (session) =>
        new Date(session.lastSeenAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' IST',
    },
    {
      key: 'actions',
      header: '',
      render: (session) =>
        session.current ? null : (
          <CommandButton
            variant="danger"
            size="sm"
            receiptLabel="Revoked"
            onCommand={async () => {
              await api(`/account/sessions/${session.id}/revoke`, { method: 'POST' });
              await refresh();
            }}
          >
            Revoke
          </CommandButton>
        ),
    },
  ];

  if (!me) {
    return (
      <Page title="Account security" width="page">
        <Card>
          <LoadingState label="Loading your account" />
        </Card>
      </Page>
    );
  }

  return (
    <Page title="Account security" description="Your second factor and the devices signed in as you.">
      <Stack gap={4}>
        {error ? (
          <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} />
        ) : null}

        <Card title="Two-factor authentication">
          {me.mfaEnrolled ? (
            <p>
              <StatusChip tone="positive">Enabled</StatusChip> for <strong>{me.email}</strong>.
            </p>
          ) : recoveryCodes ? null : enroll ? (
            <form onSubmit={activate}>
              <p style={{ marginBottom: 'var(--space-2)' }}>
                Add this secret to your authenticator app, then confirm a code:
              </p>
              <p style={{ marginBottom: 'var(--space-4)' }}>
                <CopyableId value={enroll.secret} edge={8} label="Authenticator secret" />
              </p>
              <TextInput
                label="Code from app"
                inputMode="numeric"
                autoComplete="one-time-code"
                numeric
                required
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
              <Button type="submit">Activate two-factor authentication</Button>
            </form>
          ) : (
            <Button onClick={() => void startEnroll()}>Enable two-factor authentication</Button>
          )}

          {recoveryCodes ? (
            <div style={{ marginTop: 'var(--space-4)' }}>
              <Callout tone="attention" title="Recovery codes — shown only now">
                <p>
                  Store these somewhere safe. Each one works once, and this page will not show
                  them again.
                </p>
                <ul className="mono" style={{ marginTop: 'var(--space-2)', paddingLeft: 'var(--space-4)' }}>
                  {recoveryCodes.map((recoveryCode) => (
                    <li key={recoveryCode}>{recoveryCode}</li>
                  ))}
                </ul>
              </Callout>
            </div>
          ) : null}
        </Card>

        <Card
          title="Active sessions"
          flush
          actions={
            <CommandButton
              variant="danger"
              size="sm"
              receiptLabel="Signed out"
              onCommand={async () => {
                await api('/auth/logout-all', { method: 'POST' });
                await purgeOfflineCaches().catch(() => undefined);
                router.push('/login');
              }}
            >
              Sign out everywhere
            </CommandButton>
          }
        >
          <DataTable
            caption="Devices currently signed in as you"
            columns={columns}
            rows={sessions}
            rowKey={(session) => session.id}
            stackTitle={(session) => session.userAgent?.slice(0, 40) ?? 'Unknown device'}
            empty={{ title: 'No other sessions', detail: 'Only this device is signed in.' }}
          />
        </Card>
      </Stack>
    </Page>
  );
}
