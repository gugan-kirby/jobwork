'use client';

import { useState } from 'react';

/**
 * `DS-10`: hashes, document versions and correlation ids render in mono, truncated
 * middle-out, with the full value available and a copy affordance.
 *
 * Middle-out rather than a trailing ellipsis because the ends of a hash are what people
 * actually compare. The full value is always in the accessible name — a screen reader
 * user must not be handed "ab12 dot dot dot 9f" as if that were the identifier.
 */

export interface CopyableIdProps {
  value: string;
  /** Characters kept at each end. */
  edge?: number | undefined;
  label?: string | undefined;
}

function middleOut(value: string, edge: number): string {
  if (value.length <= edge * 2 + 1) return value;
  return `${value.slice(0, edge)}…${value.slice(-edge)}`;
}

export function CopyableId({ value, edge = 6, label }: CopyableIdProps): React.JSX.Element {
  const [copied, setCopied] = useState(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be refused; the full value is selectable either way.
      setCopied(false);
    }
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1)' }}>
      <button
        type="button"
        onClick={() => void copy()}
        title={value}
        aria-label={`${label ? `${label}: ` : ''}${value}. Copy`}
        className="mono"
        style={{
          background: 'none',
          border: 'none',
          padding: 0,
          color: 'inherit',
          cursor: 'pointer',
          textDecoration: 'underline dotted',
          textUnderlineOffset: 3,
        }}
      >
        {middleOut(value, edge)}
      </button>
      <span role="status" aria-live="polite" className="jw-visually-hidden">
        {copied ? 'Copied' : ''}
      </span>
      {copied ? (
        <span aria-hidden style={{ font: 'var(--text-caption)', color: 'var(--status-positive-fg)' }}>
          copied
        </span>
      ) : null}
    </span>
  );
}
