'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { MeResponse } from '@jobwork/contracts';
import { Button, Card, ErrorState, LoadingState, Page, Stack, TextInput } from '@jobwork/ui';
import { api, ApiError } from '../../../lib/api';

/**
 * Edit profile (prototype tile 16 "Edit Profile"): the two things a person may change
 * about themselves without a verified flow — display name and phone. Email change is a
 * two-sided verified flow (doc 20 §2) and lives under Security.
 */
export default function EditProfilePage() {
  const router = useRouter();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<MeResponse & { phone?: string }>('/auth/me')
      .then((account) => {
        setMe(account);
        setDisplayName(account.displayName);
        setPhone(account.phone ?? '');
      })
      .catch((err) => {
        if (err instanceof ApiError) setError(err);
      });
  }, []);

  async function save(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/account/profile', { method: 'POST', body: { displayName, phone } });
      router.push('/profile');
    } catch (err) {
      if (err instanceof ApiError) setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page title="Edit profile" back={{ href: '/profile', label: 'Back to profile' }} width="narrow">
      <Card>
        {!me ? (
          error ? (
            <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} />
          ) : (
            <LoadingState label="Loading your account" />
          )
        ) : (
          <form onSubmit={save}>
            <Stack gap={3}>
              {error ? (
                <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} />
              ) : null}
              <TextInput
                label="Full name"
                autoComplete="name"
                required
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
              />
              <TextInput
                label="Mobile number"
                type="tel"
                autoComplete="tel"
                hint="Used only if we need to reach you about an order."
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
              />
              <TextInput label="Email" type="email" value={me.email} readOnly hint="Change your email under Security." />
              <Button type="submit" busy={busy} fullWidth>
                Save changes
              </Button>
            </Stack>
          </form>
        )}
      </Card>
    </Page>
  );
}
