'use client';

import { useState, type ReactNode } from 'react';
import { Icon } from '../primitives/Icon';
import { UiLink } from '../primitives/Link';
import { activeHref } from './paths';
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

export interface AppShellProps {
  productName: string;
  /** Distinguishes the operations app from the portal at a glance. */
  variant?: 'portal' | 'operations' | undefined;
  navigation: readonly NavItem[];
  /** Route path used to mark the active item; compared by prefix. */
  currentPath?: string | undefined;
  environmentLabel?: string | null | undefined;
  accountSlot?: ReactNode | undefined;
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
  tabs,
  primaryAction,
  notifications,
  children,
}: AppShellProps): React.JSX.Element {
  const [navOpen, setNavOpen] = useState(false);
  const activeNav = activeHref(currentPath, navigation.map((item) => item.href));
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
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 20,
          background: 'var(--color-surface)',
          borderBottom: '1px solid var(--color-border)',
        }}
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
          <UiLink
            href="/"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 'var(--space-2)',
              font: 'var(--text-heading-2)',
              color: 'var(--color-text)',
              textDecoration: 'none',
              whiteSpace: 'nowrap',
            }}
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
            {navigation.map((item) => {
              const active = item.href === activeNav;
              return (
                <UiLink
                  key={item.href}
                  href={item.href}
                  {...(active ? { 'aria-current': 'page' as const } : {})}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    minHeight: 'var(--control-height)',
                    padding: '0 var(--space-3)',
                    borderRadius: 'var(--radius-sm)',
                    font: active ? 'var(--text-body-strong)' : 'var(--text-body)',
                    color: active ? 'var(--color-action)' : 'var(--color-text)',
                    background: active ? 'var(--status-progress-bg)' : 'transparent',
                    textDecoration: 'none',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {item.label}
                  {item.badge && item.badge > 0 ? (
                    <span
                      style={{
                        marginLeft: 'var(--space-2)',
                        padding: '0 var(--space-2)',
                        borderRadius: 'var(--radius-sm)',
                        background: 'var(--status-attention-bg)',
                        border: '1px solid var(--status-attention-border)',
                        color: 'var(--status-attention-fg)',
                        font: 'var(--text-caption)',
                      }}
                    >
                      {item.badge}
                      <span className="jw-visually-hidden"> waiting</span>
                    </span>
                  ) : null}
                </UiLink>
              );
            })}
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
