'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import type { OperationsSummary } from '@jobwork/contracts';
import { AppShell, isNavGroup, LinkProvider, type NavEntry, type NavItem, useCommandTick } from '@jobwork/ui';
import { api, ApiError } from '../lib/api';

/**
 * Operations navigation. The app runs in `compact` density (doc 21 §2, `DS-02`) because
 * these screens are for scanning many rows, not for reading one decision.
 *
 * The badges are the point of F-OPS.5: an operator should not have to open Suppliers to
 * discover that three files are waiting on a decision. Counts come from the same
 * role-filtered summary the home screen uses, so a badge never advertises work the
 * operator is not allowed to do — and an item with nothing waiting carries no badge at
 * all, because a badge that is always present stops being read.
 *
 * Nineteen flat items wrapped onto two rows at desktop widths, so related screens sit in
 * groups (one row; a group's heading carries its items' badge total). VF-20: the header
 * holds six entries. The two inboxes every operator returns to all day stay top-level and
 * come first, so on a phone no plain link reads as part of the group above it; Account is
 * the profile icon by the bell.
 */

const BASE_NAVIGATION: NavEntry[] = [
  { href: '/', label: 'Home' },
  { href: '/queues', label: 'Queues' },
  { href: '/approvals', label: 'Approvals' },
  {
    label: 'Sales',
    items: [
      { href: '/intake', label: 'Intake' },
      { href: '/rfqs', label: 'RFQs' },
      { href: '/quotes', label: 'Quotes' },
      { href: '/sales-orders', label: 'Orders' },
    ],
  },
  {
    label: 'Delivery',
    items: [
      { href: '/production', label: 'Production' },
      { href: '/changes', label: 'Changes' },
      { href: '/quality', label: 'Quality' },
      { href: '/logistics', label: 'Logistics' },
    ],
  },
  {
    label: 'More',
    items: [
      { href: '/finance', label: 'Finance' },
      { href: '/support', label: 'Support' },
      { href: '/suppliers', label: 'Suppliers' },
      { href: '/organizations', label: 'Organizations' },
      { href: '/leakage-reviews', label: 'Held messages' },
      { href: '/ops-health', label: 'Health' },
      { href: '/audit', label: 'Audit' },
    ],
  },
];

/** Which queues each navigation item is answerable for. */
const BADGE_SOURCES: Record<string, ReadonlyArray<string>> = {
  '/intake': ['enquiries_awaiting_triage'],
  '/suppliers': [
    'supplier_files_awaiting_decision',
    'supplier_evidence_awaiting_review',
    'supplier_applications_received',
  ],
  '/organizations': ['invitations_pending'],
  '/rfqs': ['rfqs_in_evaluation'],
  '/approvals': ['approvals_pending'],
  '/leakage-reviews': ['leakage_reviews_open'],
  '/sales-orders': ['orders_awaiting_release', 'purchase_orders_to_issue', 'baselines_to_release', 'work_packages_to_release'],
  '/production': ['milestones_to_verify'],
  '/quality': ['inspections_awaiting_review', 'ncrs_open'],
  '/logistics': ['shipments_to_release', 'shipments_awaiting_receiving', 'receiving_discrepancies_open', 'customer_dispatches_to_release', 'deliveries_awaiting_pod', 'delivery_exceptions_open'],
  '/finance': ['payments_unmatched', 'supplier_bills_to_match', 'settlements_held'],
  '/support': ['cases_open'],
};

const UNSHELLED = ['/login'];

type ShellProps = { environmentLabel: string | null; children: ReactNode };

/**
 * F-FE.4: the design system's links (navigation, tabs, cards, back links, button links)
 * render through Next's router link, so moving between pages is client-side and
 * prefetched instead of a full document load.
 */
export function OperationsShell(props: ShellProps): React.JSX.Element {
  return (
    <LinkProvider component={Link}>
      <OperationsFrame {...props} />
    </LinkProvider>
  );
}

function OperationsFrame({ environmentLabel, children }: ShellProps): React.JSX.Element {
  const pathname = usePathname();
  const [summary, setSummary] = useState<OperationsSummary | null>(null);
  const [unread, setUnread] = useState(0);
  // Counts change when someone acts here as well as when they move on (F-12.4).
  const commandTick = useCommandTick();

  const router = useRouter();
  const unshelled = UNSHELLED.some((path) => pathname?.startsWith(path));

  useEffect(() => {
    // Offline or external: navigation without counts is still correct. Signed out: every
    // screen is JobWork-only, so go to sign in rather than render "Authentication required"
    // beside an empty list (FW W15).
    api<OperationsSummary>('/operations/summary')
      .then(setSummary)
      .catch((err: unknown) => {
        setSummary(null);
        if (!unshelled && err instanceof ApiError && err.problem.status === 401) router.replace('/login');
      });
  }, [pathname, commandTick, unshelled, router]);

  // F-10.3: the bell counts this person's unread notifications.
  useEffect(() => {
    let cancelled = false;
    api<{ unread: number }>('/notifications/unread-count')
      .then((r) => {
        if (!cancelled) setUnread(r.unread);
      })
      // Signed out or offline: the bell simply shows no count.
      .catch(() => {
        if (!cancelled) setUnread(0);
      });
    return () => {
      cancelled = true;
    };
  }, [pathname, commandTick]);

  if (unshelled) {
    return <main id="main">{children}</main>;
  }

  const counts = new Map(summary?.queues.map((queue) => [queue.key as string, queue.count]) ?? []);
  const withBadge = (item: NavItem): NavItem => {
    const badge = (BADGE_SOURCES[item.href] ?? []).reduce(
      (total, key) => total + (counts.get(key) ?? 0),
      0,
    );
    return badge > 0 ? { ...item, badge } : item;
  };
  const navigation: NavEntry[] = BASE_NAVIGATION.map((entry) =>
    isNavGroup(entry) ? { ...entry, items: entry.items.map(withBadge) } : withBadge(entry),
  );

  return (
    <AppShell
      productName="JobWork"
      variant="operations"
      navigation={navigation}
      currentPath={pathname ?? undefined}
      environmentLabel={environmentLabel}
      notifications={{ href: '/notifications', count: unread }}
      account={{ href: '/account/security', label: 'Account' }}
    >
      {children}
    </AppShell>
  );
}
