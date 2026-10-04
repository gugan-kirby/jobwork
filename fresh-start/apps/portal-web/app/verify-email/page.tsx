'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { ButtonLink, Callout, Card, LoadingState } from '@jobwork/ui';
import { api, ApiError } from '../../lib/api';
import { PublicFrame } from '../public-frame';

/**
 * The verification landing (F-MX.4). The token is consumed exactly once on the server;
 * this page just reports which way it went and points at sign-in. A used or expired link
 * is told apart from a broken one by the stable problem code.
 */
function VerifyEmail(): React.JSX.Element {
  const params = useSearchParams();
  const token = params.get('token');
  const [state, setState] = useState<'working' | 'done' | 'invalid' | 'missing'>(
    token ? 'working' : 'missing',
  );

  useEffect(() => {
    if (!token) return;
    api('/auth/verify-email', { method: 'POST', body: { token } })
      .then(() => setState('done'))
      .catch((err) => {
        setState(err instanceof ApiError ? 'invalid' : 'invalid');
      });
  }, [token]);

  return (
    <PublicFrame title="Confirm your email">
      {state === 'working' ? (
        <Card>
          <LoadingState label="Confirming your email" />
        </Card>
      ) : state === 'done' ? (
        <Callout tone="positive" title="Your email is confirmed">
          <p>Your account is active. Sign in to raise your first enquiry.</p>
          <div style={{ marginTop: 'var(--space-3)' }}>
            <ButtonLink href="/login">Login</ButtonLink>
          </div>
        </Callout>
      ) : (
        <Callout tone="blocked" title={state === 'missing' ? 'No link to confirm' : 'That link is not valid'}>
          <p>
            {state === 'missing'
              ? 'Open the confirmation link from the email we sent you.'
              : 'It may have been used already or expired. Register again to get a fresh link, or sign in if you already confirmed.'}
          </p>
          <div style={{ marginTop: 'var(--space-3)', display: 'flex', gap: 'var(--space-2)' }}>
            <ButtonLink href="/register" variant="secondary">Register</ButtonLink>
            <ButtonLink href="/login">Login</ButtonLink>
          </div>
        </Callout>
      )}
    </PublicFrame>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={null}>
      <VerifyEmail />
    </Suspense>
  );
}
