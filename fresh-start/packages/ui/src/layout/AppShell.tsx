'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Icon } from '../primitives/Icon';
import { UiLink } from '../primitives/Link';
import { activeHref, isActivePath } from './paths';
import { TabBar, type TabItem, type TabPrimaryAction } from './TabBar';

/**
 * The application frame both apps sit in (doc 21 §5 layout, §9 landmarks).
 *
 * It owns the three things that must be identical on every screen and were previously
 * re-declared per page: the skip link as the first focusable element, exactly one
 * `<main>` landmark, and the environment banner. Navigation collapses to a disclosure
 * below `md` — a button, not a drag or a hover, because doc 21 §9 forbids drag-only
 * paths and hover is not a thing on a phone in a workshop.
 *
 * F-MX.2 adds the phone layer from the prototype: when `tabs` are given, a bottom tab
 * bar carries the primary destinations below `md` and `main` gets room above it; the
 * header keeps the brand, the notification bell and the overflow menu. Above `md` the
 * tab bar is hidden and the header navigation is the only navigation — nothing exists
 * at one width that is missing at another (doc 21 §12).
 */

export interface NavItem {
  href: string;
  label: string;
  /**
   * Work waiting behind this item. Rendered as a count beside the label and spoken as
   * part of it, so the number is never colour alone (`DS-07`). Zero is not rendered:
   * a badge that is always there stops meaning anything.
   */
  badge?: number | undefined;
}

/**
 * Several destinations under one heading. Above `md` the heading is a disclosure button
 * that opens the list beneath it; below `md` the open navigation shows every group's
 * links under its heading, so nothing needs a second tap on a phone. The heading carries
 * the sum of its items' badges, so collapsed work is still announced.
 */
export interface NavGroup {
  label: string;
  items: readonly NavItem[];
}

export type NavEntry = NavItem | NavGroup;

export function isNavGroup(entry: NavEntry): entry is NavGroup {
  return 'items' in entry;
}

function flattenNavigation(navigation: readonly NavEntry[]): NavItem[] {
  return navigation.flatMap((entry) => (isNavGroup(entry) ? [...entry.items] : [entry]));
}

export interface AppShellProps {
  productName: string;
  /** Distinguishes the operations app from the portal at a glance. */
  variant?: 'portal' | 'operations' | undefined;
  navigation: readonly NavEntry[];
  /** Route path used to mark the active item; compared by prefix. */
  currentPath?: string | undefined;
  environmentLabel?: string | null | undefined;
  accountSlot?: ReactNode | undefined;
  /** The signed-in person's own settings, as an icon beside the bell at every width. */
  account?: { href: string; label: string } | undefined;
  /** Phone tab bar (F-MX.2). Omit for apps that are desktop-first, e.g. operations. */
  tabs?: readonly TabItem[] | undefined;
  /** The raised centre action of the tab bar. */
  primaryAction?: TabPrimaryAction | undefined;
  /** The bell: where it goes and how many things wait there. */
  notifications?: { href: string; count?: number | undefined } | undefined;
  children: ReactNode;
}

export function AppShell({
  productName,
  variant = 'portal',
  navigation,
  currentPath,
  environmentLabel,
  accountSlot,
  account,
  tabs,
  primaryAction,
  notifications,
  children,
}: AppShellProps): React.JSX.Element {
  const [navOpen, setNavOpen] = useState(false);
  const activeNav = activeHref(currentPath, flattenNavigation(navigation).map((item) => item.href));
  const bellCount = notifications?.count ?? 0;

  return (
    <div className={tabs ? 'jw-shell jw-has-tabbar' : 'jw-shell'}>
      <a className="jw-skip-link" href="#main">
        Skip to content
      </a>

      {environmentLabel ? (
        <div
          style={{
            background: 'var(--status-attention-bg)',
            color: 'var(--status-attention-fg)',
            borderBottom: '1px solid var(--status-attention-border)',
            padding: 'var(--space-1) var(--space-4)',
            font: 'var(--text-caption)',
            textAlign: 'center',
          }}
        >
          {environmentLabel}
        </div>
      ) : null}

      <header
        className="jw-shell-header"
      >
        <div
          style={{
            maxWidth: 'var(--container-wide)',
            margin: '0 auto',
            padding: 'var(--space-2) var(--space-4)',
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-3)',
            minHeight: 56,
            position: 'relative',
          }}
        >
          {/* VF-04: on phones the menu sits left of the name, the bell alone on the right. */}
          <button
            type="button"
            className="jw-nav-toggle jw-icon-button"
            aria-expanded={navOpen}
            aria-controls="jw-primary-nav"
            aria-label="Menu"
            onClick={() => setNavOpen((open) => !open)}
          >
            <Icon name={navOpen ? 'close' : 'menu'} size={1.4} />
          </button>

          <UiLink
            href="/"
            className="jw-shell-brand"
          >
            <span className="jw-brand-mark" aria-hidden="true">
              <Icon name="wrench" size={1} />
            </span>
            {productName}
            {variant === 'operations' ? (
              <span
                style={{
                  font: 'var(--text-caption)',
                  color: 'var(--color-text-muted)',
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '0 var(--space-2)',
                }}
              >
                operations
              </span>
            ) : null}
          </UiLink>

          <nav
            id="jw-primary-nav"
            aria-label="Primary"
            className={navOpen ? 'jw-nav jw-nav-open' : 'jw-nav'}
          >
            {navigation.map((entry, index) =>
              isNavGroup(entry) ? (
                <NavGroupMenu
                  key={entry.label}
                  group={entry}
                  activeHref={activeNav}
                  alignEnd={index >= navigation.length - 2}
                  currentPath={currentPath}
                />
              ) : (
                <NavLink key={entry.href} item={entry} active={entry.href === activeNav} />
              ),
            )}
          </nav>

          <div className="jw-header-tools">
            {notifications ? (
              <UiLink
                href={notifications.href}
                className="jw-icon-button"
                aria-label={
                  bellCount > 0
                    ? `Notifications, ${bellCount} waiting`
                    : 'Notifications'
                }
              >
                <Icon name="bell" size={1.4} />
                {bellCount > 0 ? (
                  <span className="jw-icon-button-badge" aria-hidden="true">
                    {bellCount > 99 ? '99+' : bellCount}
                  </span>
                ) : null}
              </UiLink>
            ) : null}


            {account ? (
              <UiLink
                href={account.href}
                className="jw-icon-button"
                aria-label={account.label}
                {...(isActivePath(currentPath, account.href) ? { 'aria-current': 'page' as const } : {})}
              >
                <Icon name="profile" size={1.4} />
              </UiLink>
            ) : null}

            {accountSlot ? <div className="jw-account-slot">{accountSlot}</div> : null}
          </div>
        </div>
      </header>

      <main id="main" tabIndex={-1}>
        {children}
      </main>

      {tabs ? <TabBar items={tabs} currentPath={currentPath} primary={primaryAction} /> : null}
    </div>
  );
}

function NavBadge({ count }: { count: number | undefined }): React.JSX.Element | null {
  if (!count || count <= 0) return null;
  return (
    <span className="jw-nav-badge">
      {count}
      <span className="jw-visually-hidden"> waiting</span>
    </span>
  );
}

function NavLink({ item, active }: { item: NavItem; active: boolean }): React.JSX.Element {
  return (
    <UiLink
      href={item.href}
      className="jw-nav-link"
      {...(active ? { 'aria-current': 'page' as const } : {})}
    >
      {item.label}
      <NavBadge count={item.badge} />
    </UiLink>
  );
}

/**
 * A disclosure (button + list), not an ARIA menu: the items are ordinary links, reached
 * with Tab, and the list closes on Escape, on a click elsewhere, and on navigation.
 */
function NavGroupMenu({
  group,
  activeHref: activeNav,
  alignEnd,
  currentPath,
}: {
  group: NavGroup;
  activeHref: string | undefined;
  alignEnd: boolean;
  currentPath: string | undefined;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const containsActive = group.items.some((item) => item.href === activeNav);
  const total = group.items.reduce((sum, item) => sum + (item.badge ?? 0), 0);

  useEffect(() => {
    setOpen(false);
  }, [currentPath]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div
      ref={rootRef}
      className={containsActive ? 'jw-nav-group jw-nav-group-active' : 'jw-nav-group'}
      onBlur={(event) => {
        if (!rootRef.current?.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        className="jw-nav-link jw-nav-group-button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        {group.label}
        <NavBadge count={total} />
        <span className="jw-nav-chevron" aria-hidden="true">
          <Icon name="chevron" size={0.9} />
        </span>
      </button>
      <span className="jw-nav-group-label" aria-hidden="true">
        {group.label}
      </span>
      <div
        id={panelId}
        className={[
          'jw-nav-panel',
          open ? 'jw-nav-panel-open' : '',
          alignEnd ? 'jw-nav-panel-end' : '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        {group.items.map((item) => (
          <NavLink key={item.href} item={item} active={item.href === activeNav} />
        ))}
      </div>
    </div>
  );
}
