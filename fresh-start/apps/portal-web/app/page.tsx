'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { MeResponse, PortalSummary } from '@jobwork/contracts';
import {
  ActionNeededCard,
  BannerMachines,
  ButtonLink,
  Card,
  ErrorState,
  LoadingState,
  Page,
  ProcessArt,
  processArtFor,
  QuickAction,
  QuickActionGrid,
  Stack,
  type IconName,
  type QuickAccent,
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
 *
 * VF-04 (reference screen 04): banner, quick actions, top categories in the reference's
 * order and look. Anything waiting on the customer follows the categories as a short
 * list, and every quick action still carries its count. The reference's "RFQ / Quotes"
 * is "Quotations": the customer receives JobWork's quotation, never an RFQ or a bid.
 * Categories are processes (the reference shows CNC machining, VMC, turning, welding),
 * each opening the wizard on its family.
 */

const QUICK: Array<{
  href: string;
  icon: IconName;
  label: string;
  accent: QuickAccent;
  queue?: string;
  countLabel?: string;
}> = [
  { href: '/enquiries/new', icon: 'edit', label: 'New Enquiry', accent: 'blue' },
  { href: '/enquiries', icon: 'enquiries', label: 'My Enquiries', accent: 'orange', queue: 'questions_awaiting_answer', countLabel: 'waiting on you' },
  { href: '/quotations', icon: 'quote', label: 'Quotations', accent: 'green', queue: 'quotations_awaiting_decision', countLabel: 'to decide' },
  { href: '/orders', icon: 'orders', label: 'Orders', accent: 'ink', queue: 'orders_in_progress', countLabel: 'in progress' },
  { href: '/invoices', icon: 'invoice', label: 'Invoices', accent: 'sky', queue: 'invoices_unpaid', countLabel: 'unpaid' },
  { href: '/payments', icon: 'payment', label: 'Payments', accent: 'ink' },
];

/** The reference leads with these four; every other process follows in taxonomy order. */
const FEATURED = ['milling', 'vmc', 'turning', 'weld'];

function topProcesses(families: PublicCategory[]): Array<{ code: string; label: string; family: string }> {
  const all = families.flatMap((family) =>
    family.processes.map((process) => ({ ...process, family: family.code })),
  );
  const rank = (code: string): number => {
    const index = FEATURED.findIndex((key) => code.toLowerCase().includes(key));
    return index === -1 ? FEATURED.length : index;
  };
  return all
    .map((process, order) => ({ process, order }))
    .sort((a, b) => rank(a.process.code) - rank(b.process.code) || a.order - b.order)
    .map(({ process }) => process);
}

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
  const processes = topProcesses(families);

  return (
    <Page title="Home" titleHidden>
      <Stack gap={6}>
        <section className="jw-banner" aria-label={`Welcome, ${me.displayName.split(/\s+/)[0] || 'back'}`}>
          <div>
            <p className="jw-banner-title">Precision Work.</p>
            <p className="jw-banner-sub">On Time, Every Time.</p>
          </div>
          <div className="jw-banner-art">
            <BannerMachines />
          </div>
        </section>

        <section aria-labelledby="home-quick" className="jw-home-section">
          <h2 id="home-quick" className="jw-home-title">
            Quick Actions
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
                  accent={action.accent}
                  {...(queue && queue.count > 0 ? { count: queue.count, countLabel: action.countLabel } : {})}
                />
              );
            })}
          </QuickActionGrid>
        </section>

        {processes.length > 0 ? (
          <section aria-labelledby="home-categories" className="jw-home-section">
            <h2 id="home-categories" className="jw-home-title">
              Top Categories
            </h2>
            <div className="jw-category-row">
              {processes.map((process) => (
                <Link
                  key={process.code}
                  href={`/enquiries/new?category=${process.family}`}
                  className="jw-category"
                >
                  <ProcessArt name={processArtFor(process.code)} />
                  {process.label}
                </Link>
              ))}
            </div>
          </section>
        ) : null}

        {waiting.length > 0 ? (
          <section aria-labelledby="home-waiting" className="jw-home-section">
            <h2 id="home-waiting" className="jw-home-title">
              Waiting on you
            </h2>
            <Stack gap={3}>
              {waiting.map((queue) => (
                <ActionNeededCard
                  key={queue.key}
                  title={`${queue.label} (${queue.count})`}
                  detail={queue.detail}
                  action={<ButtonLink href={queue.href} size="sm">Open</ButtonLink>}
                />
              ))}
            </Stack>
          </section>
        ) : null}
      </Stack>
    </Page>
  );
}
