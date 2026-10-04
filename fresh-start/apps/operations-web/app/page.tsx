'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { OperationsSummary } from '@jobwork/contracts';
import {
  ActionNeededCard,
  ButtonLink,
  Card,
  DescriptionList,
  ErrorState,
  LoadingState,
  Page,
  QueueCard,
  Stack,
  StatusChip,
} from '@jobwork/ui';
import { api, ApiError } from '../lib/api';

interface Me {
  displayName: string;
  email: string;
  organizationType: string | null;
  roles: string[];
  mfaEnrolled: boolean;
}

/**
 * The command center (doc 14 §6, F-OPS.3).
 *
 * The old version was a list of links, which asked every operator to open four queues to
 * discover whether any of them had work. This one answers the question the moment it
 * loads: what is waiting, how much, and how long it has waited — and nothing else above
 * the fold, because an admin console is action-oriented, not a dashboard.
 *
 * Queues are chosen by the server from the operator's roles, so this page never renders
 * a number somebody cannot act on.
 */
export default function HomePage(): React.JSX.Element {
  const [me, setMe] = useState<Me | null>(null);
  const [summary, setSummary] = useState<OperationsSummary | null>(null);
  const [anonymous, setAnonymous] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const load = useCallback(async () => {
    try {
      const account = await api<Me>('/auth/me');
      setMe(account);
      // A summary the actor may not read is not an error worth showing them; the page
      // still works as the account view it always was.
      setSummary(await api<OperationsSummary>('/operations/summary').catch(() => null));
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      if (err.problem.status === 401) setAnonymous(true);
      else setError(err);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (anonymous) {
    return (
      <Page title="JobWork operations" width="narrow">
        <Card>
          <p>
            <Link href="/login">Sign in</Link> to continue.
          </p>
        </Card>
      </Page>
    );
  }

  if (!me) {
    return (
      <Page title="JobWork operations" width="narrow">
        {error ? (
          <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} correlationId={error.problem.correlationId} />
        ) : (
          <Card>
            <LoadingState label="Loading your account" />
          </Card>
        )}
      </Page>
    );
  }

  const waiting = summary?.queues.filter((queue) => queue.count > 0) ?? [];
  const clear = summary?.queues.filter((queue) => queue.count === 0) ?? [];
  const isAdministrator =
    me.roles.includes('platform_admin') || me.roles.includes('security_admin');

  return (
    <Page
      title={`Good to see you, ${me.displayName.split(' ')[0]}`}
      description="What is waiting on you right now."
      width="wide"
      actions={
        isAdministrator ? (
          <ButtonLink href="/organizations" variant="secondary">
            Organizations &amp; people
          </ButtonLink>
        ) : null
      }
    >
      <Stack gap={4}>
        {!me.mfaEnrolled ? (
          <ActionNeededCard
            title="Two-factor authentication is required for internal work"
            detail="Transactional actions stay locked until you enrol (AUTH-15)."
            owner="You"
            action={
              <ButtonLink href="/account/security">Enrol now</ButtonLink>
            }
          />
        ) : null}

        {summary === null ? (
          <Card>
            <LoadingState label="Counting what is waiting" />
          </Card>
        ) : waiting.length === 0 ? (
          <Card title="Nothing is waiting on you">
            <p>
              Every queue your roles cover is clear. New work appears here as it arrives —
              customers submitting enquiries, suppliers sending evidence, files coming up for a
              decision.
            </p>
          </Card>
        ) : (
          <div
            style={{
              display: 'grid',
              gap: 'var(--space-3)',
              gridTemplateColumns: 'repeat(auto-fit, minmax(20rem, 1fr))',
            }}
          >
            {waiting.map((queue) => (
              <QueueCard
                key={queue.key}
                label={queue.label}
                detail={queue.detail}
                count={queue.count}
                oldestWaitingSince={queue.oldestWaitingSince}
                href={queue.href}
              />
            ))}
          </div>
        )}

        {clear.length > 0 ? (
          <Card title="Clear" description="Checked, and empty.">
            <Stack gap={2}>
              {clear.map((queue) => (
                <p key={queue.key} style={{ margin: 0 }}>
                  <Link href={queue.href}>{queue.label}</Link> — {queue.detail}
                </p>
              ))}
            </Stack>
          </Card>
        ) : null}

        <Card title="Your session">
          <DescriptionList
            columns={2}
            items={[
              { label: 'Signed in as', value: `${me.displayName} (${me.email})` },
              { label: 'Roles', value: me.roles.join(', ') || 'None in this context' },
              {
                label: 'Two-factor',
                value: me.mfaEnrolled ? (
                  <StatusChip tone="positive">Enrolled</StatusChip>
                ) : (
                  <StatusChip tone="attention">Not enrolled</StatusChip>
                ),
              },
            ]}
          />
        </Card>

        <Card title="Reference">
          <Stack gap={2}>
            <p style={{ margin: 0 }}>
              <Link href="/suppliers">Supplier network</Link> — everyone admitted, and what each
              still owes.
            </p>
            {isAdministrator ? (
              <p style={{ margin: 0 }}>
                <Link href="/organizations">Organizations and people</Link> — customers, suppliers,
                JobWork staff, invitations and access.
              </p>
            ) : null}
            <p style={{ margin: 0 }}>
              <Link href="/audit">Audit explorer</Link> — every command, by correlation id.
            </p>
            <p style={{ font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>
              RFQ control room and bid comparison arrive with IN-06.
            </p>
          </Stack>
        </Card>
      </Stack>
    </Page>
  );
}
