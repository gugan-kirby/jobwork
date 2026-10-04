'use client';

import type { ReactNode } from 'react';
import { Button } from '../primitives/Button';
import { ButtonLink } from '../primitives/Link';

/**
 * Empty, loading and error states (doc 21 §6).
 *
 * Each of the three has a rule it exists to enforce:
 *  - **Empty explains eligibility and the next action.** "No results" is not a state,
 *    it is a shrug; the reader needs to know whether nothing exists, nothing matches,
 *    or they are not allowed to see it.
 *  - **Skeletons never render enabled buttons.** A control that appears before its data
 *    invites a click against a state nobody has loaded yet.
 *  - **Errors carry the stable problem code and correlation id** (doc 08 §3), because
 *    that is what support asks for and what the audit log can be searched by.
 */

export function EmptyState({
  title,
  detail,
  action,
}: {
  title: string;
  /** Why it is empty and what would change that — required, not decorative. */
  detail: string;
  action?: ReactNode | undefined;
}): React.JSX.Element {
  return (
    <div
      style={{
        textAlign: 'center',
        padding: 'var(--space-7) var(--space-4)',
        color: 'var(--color-text-muted)',
      }}
    >
      <p style={{ font: 'var(--text-body-strong)', color: 'var(--color-text)' }}>{title}</p>
      <p style={{ marginTop: 'var(--space-2)', maxWidth: 460, marginInline: 'auto' }}>{detail}</p>
      {action ? <div style={{ marginTop: 'var(--space-4)' }}>{action}</div> : null}
    </div>
  );
}

export function Skeleton({
  width = '100%',
  height = 16,
}: {
  width?: string | number | undefined;
  height?: string | number | undefined;
}): React.JSX.Element {
  return (
    <span
      aria-hidden
      style={{
        display: 'block',
        width,
        height,
        borderRadius: 'var(--radius-sm)',
        background:
          'linear-gradient(90deg, var(--neutral-100) 25%, var(--neutral-200) 37%, var(--neutral-100) 63%)',
        backgroundSize: '400% 100%',
        animation: 'jw-shimmer 1400ms ease-in-out infinite',
      }}
    />
  );
}

export function LoadingState({
  label = 'Loading',
  rows = 3,
}: {
  label?: string | undefined;
  rows?: number | undefined;
}): React.JSX.Element {
  return (
    <div role="status" aria-live="polite" style={{ display: 'grid', gap: 'var(--space-3)', padding: 'var(--space-4)' }}>
      <span className="jw-visually-hidden">{label}</span>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} width={index === rows - 1 ? '60%' : '100%'} />
      ))}
    </div>
  );
}

export interface ErrorStateProps {
  title?: string | undefined;
  message: string;
  /** The stable machine code from the problem document (doc 08 §3). */
  code?: string | undefined;
  correlationId?: string | undefined;
  action?: ReactNode | undefined;
}

export function ErrorState({
  title = 'That did not work',
  message,
  code,
  correlationId,
  action,
}: ErrorStateProps): React.JSX.Element {
  return (
    <div
      role="alert"
      style={{
        background: 'var(--status-blocked-bg)',
        border: '1px solid var(--status-blocked-border)',
        borderRadius: 'var(--radius-md)',
        padding: 'var(--space-4)',
      }}
    >
      <p style={{ font: 'var(--text-body-strong)', color: 'var(--status-blocked-fg)' }}>{title}</p>
      <p style={{ marginTop: 'var(--space-1)' }}>{message}</p>
      {code || correlationId ? (
        <p style={{ marginTop: 'var(--space-2)', font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>
          Quote this to support:{' '}
          <span className="mono">
            {code}
            {correlationId ? ` · ${correlationId}` : ''}
          </span>
        </p>
      ) : null}
      {action ? <div style={{ marginTop: 'var(--space-3)' }}>{action}</div> : null}
    </div>
  );
}

export interface RouteErrorProps {
  /**
   * The framework's error digest, which matches the server log entry. It is the only
   * detail shown: an error's message can carry internals and is never rendered (`ES-13`).
   */
  digest?: string | undefined;
  onRetry: () => void;
  homeHref?: string | undefined;
}

/**
 * The error state for a page that failed while rendering (F-FE.5): what happened in
 * plain words, a reference support can match, and the two ways forward — try again, or
 * go home. Without it a render exception leaves a blank screen.
 */
export function RouteError({ digest, onRetry, homeHref = '/' }: RouteErrorProps): React.JSX.Element {
  return (
    <ErrorState
      title="We could not show this page"
      message="Something went wrong while showing this page. Try again, or go back to your home screen."
      code="PAGE_ERROR"
      correlationId={digest}
      action={
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
          <Button onClick={onRetry}>Try again</Button>
          <ButtonLink href={homeHref} variant="secondary">
            Go to home
          </ButtonLink>
        </div>
      }
    />
  );
}
