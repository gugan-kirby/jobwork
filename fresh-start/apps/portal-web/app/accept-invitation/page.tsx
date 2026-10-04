'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Button, Card, ErrorState, LoadingState, Stack, TextInput } from '@jobwork/ui';
import { api, ApiError } from '../../lib/api';

interface Preview {
  organizationName: string;
  email: string;
  roleKeys: string[];
  accountExists: boolean;
}

/**
 * Invitation acceptance (UC-36). Outside the shell for the same reason as sign-in: the
 * person holding this link does not have an account yet.
 *
 * The preview states which organization and which roles before anything is typed —
 * accepting an invitation grants access to another company's data, so it should never be
 * the click that reveals what was accepted.
 */
function AcceptInvitation(): React.JSX.Element {
  const token = useSearchParams().get('token') ?? '';
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<ApiError | string | null>(null);
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) {
      setError('This link is missing its invitation token. Ask for a fresh invitation.');
      return;
    }
    api<Preview>(`/invitations/preview?token=${encodeURIComponent(token)}`)
      .then(setPreview)
      .catch((err) => setError(err instanceof ApiError ? err : 'Invitation could not be loaded'));
  }, [token]);

  async function accept(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ organizationName: string }>('/invitations/accept', {
        method: 'POST',
        body: preview?.accountExists ? { token } : { token, password, displayName },
      });
      setDone(res.organizationName);
    } catch (err) {
      setError(err instanceof ApiError ? err : 'Could not accept invitation');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 480, margin: '10vh auto', padding: 'var(--space-4)' }}>
      <h1 style={{ font: 'var(--text-display)', marginBottom: 'var(--space-4)' }}>Join JobWork</h1>
      <Card>
        <Stack gap={3}>
          {error ? (
            <ErrorState
              message={typeof error === 'string' ? error : (error.problem.detail ?? error.problem.title)}
              {...(typeof error === 'string' ? {} : { code: error.problem.code })}
            />
          ) : null}

          {done ? (
            <>
              <p>
                You have joined <strong>{done}</strong>.
              </p>
              <p>
                <Link href="/login">Continue to sign in</Link>
              </p>
            </>
          ) : preview ? (
            <form onSubmit={accept}>
              <p style={{ marginBottom: 'var(--space-4)' }}>
                <strong>{preview.email}</strong> is invited to{' '}
                <strong>{preview.organizationName}</strong> as {preview.roleKeys.join(', ')}.
              </p>
              {preview.accountExists ? (
                <p style={{ font: 'var(--text-caption)', color: 'var(--color-text-muted)', marginBottom: 'var(--space-4)' }}>
                  An account with this email already exists — sign in first, then reopen this link.
                </p>
              ) : (
                <>
                  <TextInput
                    label="Your name"
                    required
                    autoComplete="name"
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                  />
                  <TextInput
                    label="Choose a password"
                    hint="At least 12 characters. Longer beats complicated."
                    type="password"
                    autoComplete="new-password"
                    minLength={12}
                    required
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                </>
              )}
              <Button type="submit" busy={busy} fullWidth>
                Accept invitation
              </Button>
            </form>
          ) : !error ? (
            <LoadingState label="Loading this invitation" rows={2} />
          ) : null}
        </Stack>
      </Card>
    </div>
  );
}

export default function AcceptInvitationPage() {
  return (
    <Suspense>
      <AcceptInvitation />
    </Suspense>
  );
}
