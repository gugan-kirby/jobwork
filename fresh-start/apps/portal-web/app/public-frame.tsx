'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { Icon } from '@jobwork/ui';

/**
 * The frame for the entry pages (prototype tiles 2 and 3): a narrow column with the
 * brand mark on top and the page's own heading under it. Rendered outside the app
 * shell, so it carries its own `main`-level heading and a way back.
 */
export function PublicFrame({
  eyebrow,
  title,
  lede,
  children,
  footer,
}: {
  eyebrow?: string | undefined;
  title: string;
  lede?: ReactNode | undefined;
  children: ReactNode;
  footer?: ReactNode | undefined;
}): React.JSX.Element {
  return (
    <div
      style={{
        maxWidth: 'calc(var(--container-narrow) * 0.62)',
        margin: '0 auto',
        padding: 'var(--space-6) var(--space-4) var(--space-8)',
        minHeight: '100vh',
        display: 'grid',
        alignContent: 'start',
        gap: 'var(--space-5)',
      }}
    >
      <Link
        href="/welcome"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 'var(--space-2)',
          textDecoration: 'none',
          color: 'var(--color-text)',
          font: 'var(--text-heading-2)',
        }}
      >
        <span className="jw-brand-mark" aria-hidden="true">
          <Icon name="wrench" size={1} />
        </span>
        JobWork
      </Link>

      <div>
        {eyebrow ? (
          <p style={{ font: 'var(--text-body-strong)', color: 'var(--color-text-muted)' }}>{eyebrow}</p>
        ) : null}
        <h1 style={{ font: 'var(--text-display)', color: 'var(--color-action)' }}>{title}</h1>
        {lede ? <p style={{ marginTop: 'var(--space-2)', color: 'var(--color-text-muted)' }}>{lede}</p> : null}
      </div>

      {children}

      {footer ? (
        <div style={{ textAlign: 'center', font: 'var(--text-body)' }}>{footer}</div>
      ) : null}
    </div>
  );
}

/** The prototype's "Secure · Reliable · Fast" strip — what the platform does, not a promise (`D-10`). */
export function AssuranceStrip(): React.JSX.Element {
  const items = [
    { icon: 'shield' as const, label: 'Secure', detail: 'Your drawings stay yours' },
    { icon: 'check' as const, label: 'Reviewed', detail: 'Every requirement checked' },
    { icon: 'bolt' as const, label: 'Managed', detail: 'One accountable counterpart' },
  ];
  return (
    <ul
      style={{
        listStyle: 'none',
        display: 'grid',
        gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
        gap: 'var(--space-3)',
        textAlign: 'center',
      }}
    >
      {items.map((item) => (
        <li key={item.label} style={{ display: 'grid', justifyItems: 'center', gap: 'var(--space-1)' }}>
          <span className="jw-quick-disc jw-quick-disc-progress">
            <Icon name={item.icon} size={1.4} />
          </span>
          <span style={{ font: 'var(--text-body-strong)' }}>{item.label}</span>
          <span style={{ font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>{item.detail}</span>
        </li>
      ))}
    </ul>
  );
}
