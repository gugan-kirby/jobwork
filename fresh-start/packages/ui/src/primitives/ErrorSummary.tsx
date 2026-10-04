'use client';

import { useEffect, useRef } from 'react';

/**
 * The submit-time error summary (doc 21 §7 and §9: "error summary receives focus on
 * failed submit").
 *
 * Server problems arrive as `{ path, message }` pairs (doc 08 §3), and each entry is a
 * link, not a sentence — the point is to get the person to the control that is wrong,
 * which on a seven-step wizard may be three steps away. `onNavigate` lets the caller
 * change step before focusing.
 */

export interface ErrorSummaryProps {
  title?: string | undefined;
  issues: ReadonlyArray<{ path: string; message: string }>;
  onNavigate?: ((path: string) => void) | undefined;
}

export function ErrorSummary({
  title = 'This could not be submitted yet',
  issues,
  onNavigate,
}: ErrorSummaryProps): React.JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (issues.length > 0) ref.current?.focus();
  }, [issues]);

  if (issues.length === 0) return null;

  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="alert"
      style={{
        background: 'var(--status-blocked-bg)',
        border: '1px solid var(--status-blocked-border)',
        borderRadius: 'var(--radius-md)',
        padding: 'var(--space-4)',
        marginBottom: 'var(--space-4)',
      }}
    >
      <p style={{ font: 'var(--text-body-strong)', color: 'var(--status-blocked-fg)' }}>{title}</p>
      <ul style={{ margin: 'var(--space-2) 0 0', paddingLeft: 'var(--space-4)' }}>
        {issues.map((issue) => (
          <li key={issue.path} style={{ marginBottom: 'var(--space-1)' }}>
            {onNavigate ? (
              <button
                type="button"
                onClick={() => onNavigate(issue.path)}
                style={{
                  background: 'none',
                  border: 'none',
                  padding: 0,
                  color: 'var(--color-action)',
                  font: 'var(--text-body)',
                  textDecoration: 'underline',
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                {issue.message}
              </button>
            ) : (
              issue.message
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
