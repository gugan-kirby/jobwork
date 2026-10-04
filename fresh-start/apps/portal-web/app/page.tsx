'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { MeResponse, PortalSummary } from '@jobwork/contracts';
import {
  ActionNeededCard,
  ButtonLink,
  Card,
  ErrorState,
  Hero,
  Icon,
  LoadingState,
  Page,
  QuickAction,
  QuickActionGrid,
  Stack,
  type IconName,
} from '@jobwork/ui';
import { api, ApiError } from '../lib/api';

interface PublicCategory {
  code: string;
  label: string;
  processes: Array<{ code: string; label: string }>;
}

/**
 * The customer home (prototype tile 4, doc 14 §4). Three bands, in the prototype's
 * order: a hero with the one primary action, the quick-action grid with counts, and the
 * categories we source. Above all of it, anything waiting on the customer — because
 * the home is an action queue first and a menu second.
 *
 * Counts come from `/portal/summary`; a count the server cannot give is absent, never
 * invented. A supplier's home is its own record, so it is redirected to `/supplier`.
 */

const QUICK: Array<{
  href: string;
  icon: IconName;
  label: string;
  queue?: string;
  countLabel?: string;
}> = [
  { href: '/enquiries/new', icon: 'plus', label: 'New enquiry' },
  { href: '/enquiries', icon: 'enquiries', label: 'My enquiries', queue: 'questions_awaiting_answer', countLabel: 'waiting on you' },
  { href: '/quotations', icon: 'quote', label: 'Quotations', queue: 'quotations_awaiting_decision', countLabel: 'to decide' },
  { href: '/orders', icon: 'orders', label: 'Orders', queue: 'orders_in_progress', countLabel: 'in progress' },
  { href: '/invoices', icon: 'invoice', label: 'Invoices', queue: 'invoices_unpaid', countLabel: 'unpaid' },
  { href: '/payments', icon: 'payment', label: 'Payments' },
];

const FAMILY_ICON: Record<string, IconName> = {
  machining: 'settings',
  sheet_metal: 'document',
  fabrication: 'bolt',
  casting: 'factory',
  forming: 'capabilities',
  moulding: 'orders',
};

export default function HomePage() {
  const router = useRouter();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [summary, setSummary] = useState<PortalSummary | null>(null);
  const [families, setFamilies] = useState<PublicCategory[]>([]);

  useEffect(() => {
    api<MeResponse>('/auth/me')
      .then((account) => {
        // A supplier's home is its own record, not the customer's action queue.
        if (account.organizationType === 'supplier') {
          router.replace('/supplier');
          return;
        }
        setMe(account);
        void api<PortalSummary>('/portal/summary')
          .then(setSummary)
          .catch(() => setSummary(null));
      })
      .catch((err) => {
        if (!(err instanceof ApiError)) throw err;
        // A visitor with no session lands on the splash, not on a sign-in nag.
        if (err.problem.status === 401) router.replace('/welcome');
        else setError(err);
      });
    api<{ families: PublicCategory[] }>('/public/categories')
      .then((res) => setFamilies(res.families))
      .catch(() => setFamilies([]));
  }, [router]);

  if (!me) {
    return (
      <Page title="Home" titleHidden>
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

  const counts = new Map(summary?.queues.map((q) => [q.key as string, q]) ?? []);
  const waiting = (summary?.queues ?? []).filter(
    (q) => q.count > 0 && q.key !== 'enquiries_in_progress' && q.key !== 'orders_in_progress',
  );
  const firstName = me.displayName.split(/\s+/)[0] || 'there';

  return (
    <Page title="Home" titleHidden>
      <Stack gap={5}>
        <Hero
          headline="Precision work. On time. Every time."
          subline={`Hello ${firstName}. Tell us what you need made and we take it from enquiry to delivery.`}
          illustration={
            <span style={{ display: 'inline-flex', gap: 'var(--space-3)', opacity: 0.9 }}>
              <Icon name="factory" size={3} />
              <Icon name="settings" size={3} />
              <Icon name="truck" size={3} />
            </span>
          }
          actions={
            <ButtonLink
              href="/enquiries/new"
              variant="secondary"
              style={{ background: 'var(--brand-hero-fg)', color: 'var(--color-action)' }}
            >
              Create enquiry
            </ButtonLink>
          }
        />

        {waiting.length > 0 ? (
          <section aria-labelledby="home-waiting">
            <h2 id="home-waiting" className="jw-section-title">
              Waiting on you
            </h2>
            <Stack gap={3}>
              {waiting.map((queue) => (
                <ActionNeededCard
                  key={queue.key}
                  title={`${queue.label} (${queue.count})`}
                  detail={queue.detail}
                  action={
                    <ButtonLink href={queue.href} size="sm">Open</ButtonLink>
                  }
                />
              ))}
            </Stack>
          </section>
        ) : null}

        <section aria-labelledby="home-quick">
          <h2 id="home-quick" className="jw-section-title">
            Quick actions
          </h2>
          <QuickActionGrid>
            {QUICK.map((action) => {
              const queue = action.queue ? counts.get(action.queue) : undefined;
              return (
                <QuickAction
                  key={action.href}
                  href={action.href}
                  icon={action.icon}
                  label={action.label}
                  {...(queue && queue.count > 0
                    ? { count: queue.count, countLabel: action.countLabel, tone: 'attention' as const }
                    : {})}
                />
              );
            })}
          </QuickActionGrid>
        </section>

        {families.length > 0 ? (
          <section aria-labelledby="home-categories">
            <h2 id="home-categories" className="jw-section-title">
              Top categories
            </h2>
            <QuickActionGrid>
              {families.map((family) => (
                <QuickAction
                  key={family.code}
                  href={`/enquiries/new?category=${family.code}`}
                  icon={FAMILY_ICON[family.code] ?? 'settings'}
                  label={family.label}
                  tone="neutral"
                />
              ))}
            </QuickActionGrid>
          </section>
        ) : null}

        <Card title="Your account">
          <p style={{ color: 'var(--color-text-muted)' }}>
            Signed in as {me.email}
            {me.memberships.find((m) => m.organizationId === me.organizationId)
              ? ` for ${me.memberships.find((m) => m.organizationId === me.organizationId)!.organizationName}`
              : ''}
            . Manage addresses, documents, your team and security from your{' '}
            <Link href="/profile">profile</Link>.
          </p>
        </Card>
      </Stack>
    </Page>
  );
}
