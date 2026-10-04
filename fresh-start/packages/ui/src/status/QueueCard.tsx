'use client';

import type { ReactNode } from 'react';
import type { Tone } from '../tokens';
import { UiLink } from '../primitives/Link';

/**
 * One queue on the command center (doc 21 §6, F-OPS.3): how much is waiting, and how
 * long the oldest item has waited.
 *
 * The age is the point. A count alone says "there is work"; a count with an age says
 * "this queue is going stale", which is the only version an operator can prioritise
 * with. Empty queues still render — an operator needs to know a queue was checked, not
 * be left wondering whether it failed to load.
 */

export interface QueueCardProps {
  label: string;
  detail: string;
  count: number;
  /** ISO timestamp of the oldest waiting item, or null when nothing waits. */
  oldestWaitingSince?: string | null | undefined;
  href: string;
  /** Days after which a waiting item is called out. */
  ageWarningDays?: number;
  action?: ReactNode;
}

export function describeAge(since: string, now: Date = new Date()): { days: number; text: string } {
  const ms = now.getTime() - new Date(since).getTime();
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return { days, text: `oldest waiting ${days} day${days === 1 ? '' : 's'}` };
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 1) return { days, text: `oldest waiting ${hours} hour${hours === 1 ? '' : 's'}` };
  return { days, text: 'all arrived within the hour' };
}

export function QueueCard({
  label,
  detail,
  count,
  oldestWaitingSince,
  href,
  ageWarningDays = 2,
  action,
}: QueueCardProps): React.JSX.Element {
  const age = oldestWaitingSince ? describeAge(oldestWaitingSince) : null;
  const tone: Tone =
    count === 0 ? 'neutral' : age && age.days >= ageWarningDays ? 'attention' : 'progress';

  return (
    <UiLink
      href={href}
      style={{
        display: 'block',
        textDecoration: 'none',
        color: 'var(--color-text)',
        border: `1px solid var(--status-${tone}-border)`,
        borderLeft: `var(--rule-emphasis) solid var(--status-${tone}-fg)`,
        borderRadius: 'var(--radius-md)',
        background: 'var(--color-surface)',
        padding: 'var(--space-4)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-3)' }}>
        <span
          style={{
            font: 'var(--text-heading-1)',
            color: count === 0 ? 'var(--color-text-muted)' : `var(--status-${tone}-fg)`,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {count}
        </span>
        <span style={{ font: 'var(--text-body-strong)' }}>{label}</span>
      </div>
      <p style={{ margin: 'var(--space-2) 0 0', color: 'var(--color-text-muted)' }}>{detail}</p>
      {count === 0 || age ? (
        <p style={{ margin: 'var(--space-1) 0 0', font: 'var(--text-caption)' }}>
          {count === 0 ? 'Nothing waiting.' : age!.text}
        </p>
      ) : null}
      {action ? <div style={{ marginTop: 'var(--space-3) ' }}>{action}</div> : null}
    </UiLink>
  );
}
