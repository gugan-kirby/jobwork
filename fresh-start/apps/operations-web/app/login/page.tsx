'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Card, ErrorState, Stack, TextInput } from '@jobwork/ui';
import { api, ApiError } from '../../lib/api';

/**
 * Operations sign-in. Internal accounts are MFA-gated for every transactional command
 * (AUTH-15), so the second step is the normal path here rather than the exception.
 */
export default function LoginPage() {
  const router = useRouter();
  const [step, setStep] = useState<'credentials' | 'mfa'>('credentials');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  async function submitCredentials(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ mfaRequired: boolean }>('/auth/login', {
        method: 'POST',
        body: { email, password },
      });
      if (res.mfaRequired) setStep('mfa');
      else router.push('/');
    } catch (err) {
      if (err instanceof ApiError) setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function submitMfa(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/auth/mfa', { method: 'POST', body: { code } });
      router.push('/');
    } catch (err) {
      if (err instanceof ApiError) setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 420, margin: '10vh auto', padding: 'var(--space-4)' }}>
      <h1 style={{ font: 'var(--text-display)', marginBottom: 'var(--space-4)' }}>JobWork operations</h1>
      <Card>
        <Stack gap={3}>
          {error ? (
            <ErrorState
              title={step === 'mfa' ? 'That code was not accepted' : 'Sign-in failed'}
              message={error.problem.detail ?? error.problem.title}
              code={error.problem.code}
            />
          ) : null}

          {step === 'credentials' ? (
            <form onSubmit={submitCredentials}>
              <TextInput
                label="Email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
              <TextInput
                label="Password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              <Button type="submit" busy={busy} fullWidth>
                Sign in
              </Button>
            </form>
          ) : (
            <form onSubmit={submitMfa}>
              <TextInput
                label="Authentication code"
                hint="The six-digit code from your authenticator app."
                inputMode="numeric"
                autoComplete="one-time-code"
                required
                numeric
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
              <Button type="submit" busy={busy} fullWidth>
                Verify
              </Button>
            </form>
          )}
        </Stack>
      </Card>
    </div>
  );
}
