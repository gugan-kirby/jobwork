'use client';

/**
 * A polite announcer for state that changes without the reader doing anything: autosave,
 * upload and scan progress, command receipts (doc 21 §9 — "status changes announce via
 * live regions; long-running upload/scan states are polled into text, not spinner-only").
 *
 * Rendered visibly by default because sighted users need the same information; pass
 * `visuallyHidden` where the surrounding UI already says it.
 */

export interface LiveRegionProps {
  message: string;
  assertive?: boolean | undefined;
  visuallyHidden?: boolean | undefined;
}

export function LiveRegion({
  message,
  assertive = false,
  visuallyHidden = false,
}: LiveRegionProps): React.JSX.Element {
  return (
    <p
      role="status"
      aria-live={assertive ? 'assertive' : 'polite'}
      className={visuallyHidden ? 'jw-visually-hidden' : undefined}
      style={
        visuallyHidden
          ? undefined
          : { font: 'var(--text-caption)', color: 'var(--color-text-muted)', margin: 0 }
      }
    >
      {message}
    </p>
  );
}
