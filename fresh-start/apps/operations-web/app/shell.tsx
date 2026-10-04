'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import type { OperationsSummary } from '@jobwork/contracts';
import { AppShell, LinkProvider, type NavItem } from '@jobwork/ui';
import { api } from '../lib/api';

/**
 * Operations navigation. The app runs in `compact` density (doc 21 §2, `DS-02`) because
 * these screens are for scanning many rows, not for reading one decision.
 *
 * The badges are the point of F-OPS.5: an operator should not have to open Suppliers to
 * discover that three files are waiting on a decision. Counts come from the same
 * role-filtered summary the home screen uses, so a badge never advertises work the
 * operator is not allowed to do — and an item with nothing waiting carries no badge at
 * all, because a badge that is always present stops being read.
 */

const BASE_NAVIGATION: NavItem[] = [
  { href: '/', label: 'Home' },
  { href: '/queues', label: 'Queues' },
  { href: '/intake', label: 'Intake' },
  { href: '/rfqs', label: 'RFQs' },
  { href: '/quotes', label: 'Quotes' },
  { href: '/sales-orders', label: 'Orders' },
  { href: '/production', label: 'Production' },
  { href: '/finance', label: 'Finance' },
  { href: '/approvals', label: 'Approvals' },
  { href: '/leakage-reviews', label: 'Held messages' },
  { href: '/suppliers', label: 'Suppliers' },
  { href: '/organizations', label: 'Organizations' },
  { href: '/audit', label: 'Audit' },
  { href: '/account/security', label: 'Account' },
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
  '/finance': ['payments_unmatched'],
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

  useEffect(() => {
    // Anonymous, external, or offline: navigation without counts is still correct.
    api<OperationsSummary>('/operations/summary')
      .then(setSummary)
      .catch(() => setSummary(null));
  }, [pathname]);

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
  }, [pathname]);

  if (UNSHELLED.some((path) => pathname?.startsWith(path))) {
    return <main id="main">{children}</main>;
  }

  const counts = new Map(summary?.queues.map((queue) => [queue.key as string, queue.count]) ?? []);
  const navigation: NavItem[] = BASE_NAVIGATION.map((item) => {
    const badge = (BADGE_SOURCES[item.href] ?? []).reduce(
      (total, key) => total + (counts.get(key) ?? 0),
      0,
    );
    return badge > 0 ? { ...item, badge } : item;
  });

  return (
    <AppShell
      productName="JobWork"
      variant="operations"
      navigation={navigation}
      currentPath={pathname ?? undefined}
      environmentLabel={environmentLabel}
      notifications={{ href: '/notifications', count: unread }}
    >
      {children}
    </AppShell>
  );
}
