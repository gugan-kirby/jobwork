'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, Card, ErrorState, Stack, TextInput } from '@jobwork/ui';
import { api, ApiError } from '../../lib/api';
import { AssuranceStrip, PublicFrame } from '../public-frame';

/**
 * Sign-in (prototype tile 2 styling on the doc 20 flow). Rendered outside the app shell
 * — someone who is not signed in should not be shown a navigation bar of links that
 * will bounce them straight back here.
 *
 * The second factor is a separate step rather than a field that appears in place, so the
 * password manager has finished its job before the code is asked for (doc 20 §5).
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
    <PublicFrame
      eyebrow="Welcome back to"
      title="JobWork"
      lede="Sign in to raise enquiries, review quotations and follow your orders."
      footer={
        <Stack gap={4}>
          <p>
            New here? <Link href="/register">Register</Link> ·{' '}
            <Link href="/explore">Continue as guest</Link>
          </p>
          <AssuranceStrip />
        </Stack>
      }
    >
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
                Login
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
    </PublicFrame>
  );
}
