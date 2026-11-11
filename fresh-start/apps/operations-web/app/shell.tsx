'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import type { OperationsSummary } from '@jobwork/contracts';
import { activeHref, Icon, isActivePath, LinkProvider, UiLink, useCommandTick } from '@jobwork/ui';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar';
import { api, ApiError } from '../lib/api';

/**
 * Operations navigation, in shadcn/ui's Sidebar. The app runs in `compact` density
 * (doc 21 §2, `DS-02`) because these screens are for scanning many rows, not for reading
 * one decision.
 *
 * The badges are the point of F-OPS.5: an operator should not have to open Suppliers to
 * discover that three files are waiting on a decision. Counts come from the same
 * role-filtered summary the home screen uses, so a badge never advertises work the
 * operator is not allowed to do — and an item with nothing waiting carries no badge at
 * all, because a badge that is always present stops being read.
 *
 * F-OPS.6: the sidebar lists every screen at once under its section, each with its own
 * badge, where the header held six entries and hid the rest in dropdowns (VF-20). The two
 * inboxes every operator returns to all day stay first. Below `md` the same sidebar opens
 * as a sheet from the menu button; Account is the profile icon by the bell.
 */

interface NavItem {
  href: string;
  label: string;
  badge?: number;
}

interface NavSection {
  /** None for the first section: its entries are the console's own front door. */
  label?: string;
  items: NavItem[];
}

const SECTIONS: NavSection[] = [
  {
    items: [
      { href: '/', label: 'Home' },
      { href: '/queues', label: 'Queues' },
      { href: '/approvals', label: 'Approvals' },
    ],
  },
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
    label: 'Back office',
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
  const sections = SECTIONS.map((section) => ({ ...section, items: section.items.map(withBadge) }));

  return (
    <>
      <a className="jw-skip-link" href="#main">
        Skip to content
      </a>
      <SidebarProvider>
        <Sidebar>
          <SidebarHeader>
            <UiLink href="/" className="jw-shell-brand">
              <span className="jw-brand-mark" aria-hidden="true">
                <Icon name="wrench" size={1} />
              </span>
              JobWork
              <span className="rounded-sm border border-sidebar-border px-2 text-xs text-muted-foreground">operations</span>
            </UiLink>
          </SidebarHeader>
          <SidebarContent>
            <PrimaryNavigation sections={sections} currentPath={pathname ?? undefined} />
          </SidebarContent>
          <SidebarRail />
        </Sidebar>
        <SidebarInset id="main" tabIndex={-1}>
          {environmentLabel ? (
            <div className="border-b border-[var(--status-attention-border)] bg-[var(--status-attention-bg)] px-4 py-1 text-center text-xs text-[var(--status-attention-fg)]">
              {environmentLabel}
            </div>
          ) : null}
          <div className="sticky top-0 z-10 flex min-h-14 items-center gap-2 border-b border-border bg-card px-4">
            <SidebarTrigger aria-label="Menu" />
            <div className="jw-header-tools">
              <UiLink
                href="/notifications"
                className="jw-icon-button"
                aria-label={unread > 0 ? `Notifications, ${unread} waiting` : 'Notifications'}
              >
                <Icon name="bell" size={1.4} />
                {unread > 0 ? (
                  <span className="jw-icon-button-badge" aria-hidden="true">
                    {unread > 99 ? '99+' : unread}
                  </span>
                ) : null}
              </UiLink>
              <UiLink
                href="/account/security"
                className="jw-icon-button"
                aria-label="Account"
                {...(isActivePath(pathname ?? undefined, '/account/security') ? { 'aria-current': 'page' as const } : {})}
              >
                <Icon name="profile" size={1.4} />
              </UiLink>
            </div>
          </div>
          {children}
        </SidebarInset>
      </SidebarProvider>
    </>
  );
}

/**
 * Every screen, under its section. A `nav` named "Primary" holds them, as the header's did,
 * and each count is part of its link's name, so the number is never colour alone (`DS-07`).
 * On a phone the sheet closes once a screen is chosen.
 */
function PrimaryNavigation({ sections, currentPath }: { sections: NavSection[]; currentPath: string | undefined }): React.JSX.Element {
  const { isMobile, setOpenMobile } = useSidebar();
  const active = activeHref(currentPath, sections.flatMap((section) => section.items.map((item) => item.href)));

  return (
    <nav aria-label="Primary">
      {sections.map((section) => (
        <SidebarGroup key={section.label ?? 'start'}>
          {section.label ? <SidebarGroupLabel>{section.label}</SidebarGroupLabel> : null}
          <SidebarGroupContent>
            <SidebarMenu>
              {section.items.map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton asChild isActive={item.href === active}>
                    <Link
                      href={item.href}
                      {...(item.href === active ? { 'aria-current': 'page' as const } : {})}
                      {...(item.badge ? { 'aria-label': `${item.label}, ${item.badge} waiting` } : {})}
                      onClick={() => {
                        if (isMobile) setOpenMobile(false);
                      }}
                    >
                      {item.label}
                    </Link>
                  </SidebarMenuButton>
                  {item.badge ? (
                    <SidebarMenuBadge
                      aria-hidden="true"
                      className="rounded-sm border border-[var(--status-attention-border)] bg-[var(--status-attention-bg)] text-[var(--status-attention-fg)]"
                    >
                      {item.badge}
                    </SidebarMenuBadge>
                  ) : null}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      ))}
    </nav>
  );
}
