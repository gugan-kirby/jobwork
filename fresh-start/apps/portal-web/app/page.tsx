'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { MeResponse } from '@jobwork/contracts';
import {
  BannerMachines,
  Card,
  ErrorState,
  LoadingState,
  Page,
  ProcessArt,
  QuickAction,
  QuickActionGrid,
  Stack,
  type IconName,
  type QuickAccent,
} from '@jobwork/ui';
import { api, ApiError } from '../lib/api';

/**
 * The customer home (VF-04, VF-18, reference screen 04): banner, quick actions, top
 * categories, nothing else. What is waiting on the customer lives on the bell and on each
 * list. A supplier's home is its own record, so it is redirected to `/supplier`.
 */

const QUICK: Array<{ href: string; icon: IconName; label: string; accent: QuickAccent }> = [
  { href: '/enquiries/new', icon: 'edit', label: 'New Enquiry', accent: 'blue' },
  { href: '/enquiries', icon: 'enquiries', label: 'My Enquiries', accent: 'orange' },
  { href: '/quotations', icon: 'quote', label: 'RFQ / Quotes', accent: 'green' },
  { href: '/orders', icon: 'orders', label: 'Orders', accent: 'ink' },
  { href: '/invoices', icon: 'invoice', label: 'Invoices', accent: 'sky' },
  { href: '/payments', icon: 'payment', label: 'Payments', accent: 'ink' },
];

const CATEGORIES = [
  { label: 'CNC Machining', art: 'milling', family: 'machining' },
  { label: 'VMC', art: 'vmc', family: 'machining' },
  { label: 'Turning', art: 'turning', family: 'machining' },
  { label: 'Welding', art: 'welding', family: 'fabrication' },
] as const;

export default function HomePage() {
  const router = useRouter();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    api<MeResponse>('/auth/me')
      .then((account) => {
        // A supplier's home is its own record, not the customer's action queue.
        if (account.organizationType === 'supplier') {
          router.replace('/supplier');
          return;
        }
        setMe(account);
      })
      .catch((err) => {
        if (!(err instanceof ApiError)) throw err;
        // A visitor with no session lands on the splash, not on a sign-in nag.
        if (err.problem.status === 401) router.replace('/welcome');
        else setError(err);
      });
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

  return (
    <Page title="Home" titleHidden>
      <Stack gap={6}>
        <section className="jw-banner" aria-label="JobWork">
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
            {QUICK.map((action) => (
              <QuickAction key={action.href} href={action.href} icon={action.icon} label={action.label} accent={action.accent} />
            ))}
          </QuickActionGrid>
        </section>

        <section aria-labelledby="home-categories" className="jw-home-section">
          <h2 id="home-categories" className="jw-home-title">
            Top Categories
          </h2>
          <div className="jw-category-row">
            {CATEGORIES.map((category) => (
              <Link key={category.label} href={`/enquiries/new?category=${category.family}`} className="jw-category">
                <ProcessArt name={category.art} />
                {category.label}
              </Link>
            ))}
          </div>
        </section>
      </Stack>
    </Page>
  );
}
