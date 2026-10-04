'use client';

import type { ReactNode } from 'react';
import type { Tone } from '../tokens';

/**
 * A toned notice box. It exists because four screens had independently written the same
 * "tinted background, hairline border, radius, padding" block, each with its own
 * spacing — exactly the page-local drift doc 21 §11 forbids.
 *
 * `assertive` raises it to `role="alert"` for something the reader must not miss (a
 * conflict, a failed command); the default is a passive region.
 */

export interface CalloutProps {
  tone: Tone;
  title?: string | undefined;
  assertive?: boolean | undefined;
  children: ReactNode;
}

export function Callout({ tone, title, assertive, children }: CalloutProps): React.JSX.Element {
  return (
    <div
      {...(assertive ? { role: 'alert' as const } : {})}
      style={{
        background: `var(--status-${tone}-bg)`,
        border: `var(--hairline) solid var(--status-${tone}-border)`,
        borderRadius: 'var(--radius-md)',
        padding: 'var(--space-4)',
      }}
    >
      {title ? (
        <p style={{ font: 'var(--text-body-strong)', color: `var(--status-${tone}-fg)` }}>{title}</p>
      ) : null}
      <div style={{ font: 'var(--text-caption)', marginTop: title ? 'var(--space-1)' : 0 }}>
        {children}
      </div>
    </div>
  );
}
