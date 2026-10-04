'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import type { PortalSummary } from '@jobwork/contracts';
import { AppShell, LinkProvider, type NavItem, type TabItem, type TabPrimaryAction } from '@jobwork/ui';
import { api, ApiError } from '../lib/api';

/**
 * The portal's navigation, in one place. `AppShell` needs the current path to mark the
 * active item, and that is only knowable in a client component — so the shell is split
 * here rather than making the whole root layout a client boundary.
 *
 * Entry pages (welcome, start, login, register, verification) render without the shell:
 * someone who is not signed in should not be shown a navigation bar full of links that
 * will bounce them back.
 *
 * Two audiences share this application and must never share a navigation. A customer
 * raises enquiries; a supplier answers them and maintains its own record. Showing a
 * supplier the customer's Enquiries link is not a cosmetic slip — it invites a supplier
 * organization to try a surface that will refuse it, and suggests JobWork mixed the two
 * roles up (doc 14 §§4–5). A guest gets a third, public navigation (`D-17`).
 *
 * F-MX.2: below `md` the same destinations sit in a bottom tab bar (prototype tiles
 * 4/8/11/13–16) with the audience's primary action raised in the middle.
 */

const CUSTOMER_NAVIGATION: NavItem[] = [
  { href: '/', label: 'Home' },
  { href: '/enquiries', label: 'Enquiries' },
  { href: '/quotations', label: 'Quotations' },
  { href: '/orders', label: 'Orders' },
  { href: '/invoices', label: 'Invoices' },
  { href: '/documents', label: 'Documents' },
  { href: '/team', label: 'Team' },
];

const CUSTOMER_TABS: TabItem[] = [
  { href: '/', label: 'Home', icon: 'home' },
  { href: '/enquiries', label: 'Enquiries', icon: 'enquiries' },
  { href: '/orders', label: 'Orders', icon: 'orders' },
  { href: '/profile', label: 'Profile', icon: 'profile' },
];

const CUSTOMER_PRIMARY: TabPrimaryAction = { href: '/enquiries/new', label: 'Create enquiry' };

const SUPPLIER_NAVIGATION: NavItem[] = [
  { href: '/supplier', label: 'Home' },
  { href: '/rfqs', label: 'RFQs' },
  { href: '/supplier/orders', label: 'Orders' },
  { href: '/supplier/company', label: 'Company' },
  { href: '/supplier/compliance', label: 'Compliance' },
  { href: '/capabilities', label: 'Capabilities' },
  { href: '/documents', label: 'Documents' },
  { href: '/supplier/team', label: 'Team' },
];

const SUPPLIER_TABS: TabItem[] = [
  { href: '/supplier', label: 'Home', icon: 'home' },
  { href: '/rfqs', label: 'RFQs', icon: 'enquiries' },
  { href: '/supplier/orders', label: 'Orders', icon: 'orders' },
  { href: '/profile', label: 'Profile', icon: 'profile' },
];

const SUPPLIER_PRIMARY: TabPrimaryAction = {
  href: '/capabilities',
  label: 'Declare a capability',
  icon: 'capabilities',
};

const PUBLIC_NAVIGATION: NavItem[] = [
  { href: '/explore', label: 'Explore' },
  { href: '/login', label: 'Sign in' },
  { href: '/register', label: 'Register' },
];

const ACCOUNT: NavItem = { href: '/profile', label: 'Account' };

const UNSHELLED = ['/login', '/accept-invitation', '/welcome', '/start', '/register', '/verify-email'];

/** Which navigation items answer for which home-queue counts. */
const CUSTOMER_BADGES: Record<string, ReadonlyArray<string>> = {
  '/enquiries': ['questions_awaiting_answer', 'drafts_unfinished'],
  '/quotations': ['quotations_awaiting_decision'],
  '/invoices': ['invoices_unpaid'],
};

/** Progress, not a to-do: shown on the home screen, never counted on the bell. */
const INFORMATIONAL_QUEUES = new Set(['enquiries_in_progress', 'orders_in_progress']);

/**
 * `unreachable` is not `anonymous`: it means JobWork could not say who this is, and a
 * shell that guessed would offer Sign in to a customer who is signed in.
 */
type Audience = 'loading' | 'unreachable' | 'anonymous' | 'customer' | 'supplier' | 'internal';

function audienceOf(organizationType: string | null): Audience {
  if (organizationType === 'supplier') return 'supplier';
  if (organizationType === 'internal') return 'internal';
  return 'customer';
}

type ShellProps = { environmentLabel: string | null; children: ReactNode };

/**
 * F-FE.4: the design system's links (navigation, tabs, cards, back links, button links)
 * render through Next's router link, so moving between pages is client-side and
 * prefetched instead of a full document load.
 */
export function PortalShell(props: ShellProps): React.JSX.Element {
  return (
    <LinkProvider component={Link}>
      <PortalFrame {...props} />
    </LinkProvider>
  );
}

function PortalFrame({ environmentLabel, children }: ShellProps): React.JSX.Element {
  const pathname = usePathname();
  const unshelled = UNSHELLED.some((path) => pathname?.startsWith(path));
  const [audience, setAudience] = useState<Audience>('loading');
  const [summary, setSummary] = useState<PortalSummary | null>(null);

  // Login, logout and invitation pages are unshelled: passing through one forgets who
  // this was, so the next signed-in page asks again.
  useEffect(() => {
    if (!unshelled) return;
    setAudience('loading');
    setSummary(null);
  }, [unshelled]);

  // F-FE.2: identity is asked once on entering the signed-in area, not on every
  // navigation. The key moves with the path only while there is no answer, so a failed
  // attempt is retried on the next page — never in a loop, never once an answer is known.
  const asking = !unshelled && (audience === 'loading' || audience === 'unreachable');
  const askKey = asking ? (pathname ?? '') : null;
  useEffect(() => {
    if (askKey === null) return;
    let cancelled = false;
    api<{ organizationType: string | null }>('/auth/me')
      .then((me) => {
        if (!cancelled) setAudience(audienceOf(me.organizationType));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Only the API saying "no session" makes this a visitor.
        setAudience(err instanceof ApiError && err.problem.status === 401 ? 'anonymous' : 'unreachable');
      });
    return () => {
      cancelled = true;
    };
  }, [askKey]);

  // Counts feed the badges and change as work moves, so they are refreshed per page.
  useEffect(() => {
    if (audience !== 'customer') return;
    let cancelled = false;
    api<PortalSummary>('/portal/summary')
      .then((s) => {
        if (!cancelled) setSummary(s);
      })
      // A failure to count is not a reason to hide the navigation; it shows no badges.
      .catch(() => {
        if (!cancelled) setSummary(null);
      });
    return () => {
      cancelled = true;
    };
  }, [audience, pathname]);

  if (unshelled) {
    return <main id="main">{children}</main>;
  }

  if (audience === 'anonymous') {
    return (
      <AppShell
        productName="JobWork"
        navigation={PUBLIC_NAVIGATION}
        currentPath={pathname ?? undefined}
        environmentLabel={environmentLabel}
      >
        {children}
      </AppShell>
    );
  }

  // Until JobWork says who this is, no audience's navigation is shown: a supplier must
  // never see the customer's links, even for the moment it takes to ask.
  if (audience === 'loading' || audience === 'unreachable') {
    return (
      <AppShell
        productName="JobWork"
        navigation={[]}
        currentPath={pathname ?? undefined}
        environmentLabel={environmentLabel}
      >
        {children}
      </AppShell>
    );
  }

  const counts = new Map(summary?.queues.map((queue) => [queue.key as string, queue.count]) ?? []);
  // The bell counts what needs the customer, not what JobWork is busy with.
  const waiting = (summary?.queues ?? [])
    .filter((queue) => !INFORMATIONAL_QUEUES.has(queue.key))
    .reduce((total, queue) => total + queue.count, 0);

  if (audience === 'supplier') {
    return (
      <AppShell
        productName="JobWork"
        navigation={[...SUPPLIER_NAVIGATION, ACCOUNT]}
        currentPath={pathname ?? undefined}
        environmentLabel={environmentLabel}
        tabs={SUPPLIER_TABS}
        primaryAction={SUPPLIER_PRIMARY}
        notifications={{ href: '/notifications' }}
      >
        {children}
      </AppShell>
    );
  }

  const navigation: NavItem[] = CUSTOMER_NAVIGATION.map((item) => {
    const badge = (CUSTOMER_BADGES[item.href] ?? []).reduce(
      (total, key) => total + (counts.get(key) ?? 0),
      0,
    );
    return badge > 0 ? { ...item, badge } : item;
  });
  const tabs: TabItem[] = CUSTOMER_TABS.map((tab) => {
    const badge = (CUSTOMER_BADGES[tab.href] ?? []).reduce(
      (total, key) => total + (counts.get(key) ?? 0),
      0,
    );
    return badge > 0 ? { ...tab, badge } : tab;
  });

  return (
    <AppShell
      productName="JobWork"
      navigation={[...navigation, ACCOUNT]}
      currentPath={pathname ?? undefined}
      environmentLabel={environmentLabel}
      tabs={tabs}
      primaryAction={CUSTOMER_PRIMARY}
      notifications={{ href: '/notifications', count: waiting }}
    >
      {children}
    </AppShell>
  );
}
