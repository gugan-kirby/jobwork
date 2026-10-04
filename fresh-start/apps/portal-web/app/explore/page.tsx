'use client';

import { useEffect, useState } from 'react';
import {
  ButtonLink,
  Callout,
  Card,
  ErrorState,
  Icon,
  LoadingState,
  Page,
  Stack,
} from '@jobwork/ui';
import { api, ApiError } from '../../lib/api';

interface PublicCategory {
  code: string;
  label: string;
  processes: Array<{ code: string; label: string }>;
}

/**
 * Guest browsing (`D-17`, `UC-01`): the process families JobWork sources and what sits
 * under each. No suppliers, no counts, no prices — the page says so, because a guest who
 * expected a directory should learn here that this is not one.
 */
export default function ExplorePage() {
  const [families, setFamilies] = useState<PublicCategory[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    api<{ families: PublicCategory[] }>('/public/categories')
      .then((res) => setFamilies(res.families))
      .catch((err) => {
        if (err instanceof ApiError) setError(err);
      });
  }, []);

  return (
    <Page
      title="What we make"
      description="The manufacturing processes JobWork sources for its customers. Tell us what you need and we do the rest."
      actions={
        <ButtonLink href="/register">Create an account</ButtonLink>
      }
    >
      <Stack gap={4}>
        <Callout tone="neutral" title="JobWork is your counterpart, not a directory">
          We choose and manage the workshop for every job. Suppliers are never listed here,
          and you are never asked to deal with one directly.
        </Callout>

        {error ? (
          <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} />
        ) : families === null ? (
          <Card>
            <LoadingState label="Loading categories" />
          </Card>
        ) : (
          <div
            style={{
              display: 'grid',
              gap: 'var(--space-3)',
              gridTemplateColumns: 'repeat(auto-fill, minmax(16rem, 1fr))',
            }}
          >
            {families.map((family) => (
              <Card
                key={family.code}
                title={
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                    <span className="jw-quick-disc jw-quick-disc-progress">
                      <Icon name="settings" size={1.2} />
                    </span>
                    {family.label}
                  </span>
                }
              >
                <ul style={{ listStyle: 'none', display: 'grid', gap: 'var(--space-2)' }}>
                  {family.processes.map((process) => (
                    <li key={process.code} style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
                      <span style={{ color: 'var(--status-positive-fg)', display: 'inline-flex' }}>
                        <Icon name="check" size={1} />
                      </span>
                      {process.label}
                    </li>
                  ))}
                </ul>
              </Card>
            ))}
          </div>
        )}

        <Card title="Ready to get a part made?">
          <p style={{ marginBottom: 'var(--space-3)' }}>
            An enquiry takes a few minutes: what it is, how many, your drawing, and when you need
            it. We come back with questions or a quotation.
          </p>
          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            <ButtonLink href="/register">Register</ButtonLink>
            <ButtonLink href="/login" variant="secondary">Sign in</ButtonLink>
          </div>
        </Card>
      </Stack>
    </Page>
  );
}
