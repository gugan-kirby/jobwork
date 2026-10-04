'use client';

import type { ReactNode } from 'react';

/**
 * The doc 21 §6 action-needed card: "owner, due time (with the timezone rule of doc 05
 * §10), one primary action, blocking reason slot — the home-queue unit for all three
 * apps".
 *
 * Exactly one primary action, by construction. A card that offers three things to do is
 * a card that has not decided what is needed, and the home queue's whole job is to
 * decide. Due times carry an explicit timezone label because a deadline without one is
 * a dispute waiting to happen (doc 21 §10).
 */

export interface ActionNeededCardProps {
  title: string;
  detail: string;
  /** Who has to act. Omitted when it is unambiguously the reader. */
  owner?: string | undefined;
  /** Rendered verbatim — format it with the timezone label, e.g. "2 Sep 2026, 14:30 IST". */
  due?: string | undefined;
  /** Why it cannot proceed, if something blocks it. */
  blockedReason?: string | undefined;
  /** The single primary action. */
  action?: ReactNode | undefined;
}

export function ActionNeededCard({
  title,
  detail,
  owner,
  due,
  blockedReason,
  action,
}: ActionNeededCardProps): React.JSX.Element {
  const tone = blockedReason ? 'blocked' : 'attention';
  return (
    <section
      style={{
        background: `var(--status-${tone}-bg)`,
        border: `1px solid var(--status-${tone}-border)`,
        borderRadius: 'var(--radius-md)',
        padding: 'var(--space-4)',
        display: 'flex',
        flexWrap: 'wrap',
        gap: 'var(--space-4)',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}
    >
      <div style={{ minWidth: 240, flex: 1 }}>
        <p style={{ font: 'var(--text-body-strong)', color: `var(--status-${tone}-fg)` }}>{title}</p>
        <p style={{ font: 'var(--text-caption)', marginTop: 'var(--space-1)' }}>{detail}</p>
        {owner || due ? (
          <p style={{ font: 'var(--text-caption)', color: 'var(--color-text-muted)', marginTop: 'var(--space-1)' }}>
            {owner ? `Owner: ${owner}` : null}
            {owner && due ? ' · ' : null}
            {due ? `Due ${due}` : null}
          </p>
        ) : null}
        {blockedReason ? (
          <p style={{ font: 'var(--text-caption)', color: 'var(--status-blocked-fg)', marginTop: 'var(--space-1)' }}>
            Blocked: {blockedReason}
          </p>
        ) : null}
      </div>
      {action ? <div>{action}</div> : null}
    </section>
  );
}
