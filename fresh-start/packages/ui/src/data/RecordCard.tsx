import type { ReactNode } from 'react';
import { Icon, type IconName } from '../primitives/Icon';
import { UiLink } from '../primitives/Link';

/**
 * One record in a phone list (F-MX.7, prototype tiles 8/11/13): reference on top, title,
 * a caption line, the status on the right, a chevron that says "this opens".
 *
 * It is a single link, so the whole card is the target (44 px minimum, doc 21 §9) and
 * the accessible name is "reference, title" — what someone would say on the phone —
 * rather than the chevron's nothing. Status and amounts are slots, not styles: the chip
 * inside carries its own tone and glyph (`DS-07`).
 */

export interface RecordCardProps {
  href: string;
  /** The human reference, rendered in mono: ENQ-2026-0001, ORD-…, INV-…. */
  reference: string;
  title: string;
  /** Category, counterpart, date — the one line of context under the title. */
  caption?: ReactNode | undefined;
  /** Right-aligned primary figure, e.g. an amount (rendered with tabular numerals). */
  figure?: ReactNode | undefined;
  /** Usually a `StatusChip`. */
  status?: ReactNode | undefined;
  /** Small trailing text under the status, e.g. a date. */
  meta?: ReactNode | undefined;
  /**
   * VF-08 (reference screens 08/11/13): a tinted glyph tile on the left turns on the
   * rich layout — title and status on one row, the reference and caption under it, and
   * `date` with a calendar glyph. Without it the card keeps the compact layout.
   */
  icon?: { name: IconName; tint: RecordTint } | undefined;
  date?: ReactNode | undefined;
  /** VF-11: 0–100, drawn as a bar under the date with its percentage (rich layout only). */
  progress?: number | undefined;
}

export type RecordTint = 'blue' | 'violet' | 'orange' | 'sky' | 'green' | 'neutral';

export function RecordCard({
  href,
  reference,
  title,
  caption,
  figure,
  status,
  meta,
  icon,
  date,
  progress,
}: RecordCardProps): React.JSX.Element {
  if (icon) {
    return (
      <UiLink href={href} className="jw-record jw-record-rich">
        <span className={`jw-record-tile jw-record-tile-${icon.tint}`} aria-hidden="true">
          <Icon name={icon.name} size={1.9} />
        </span>
        <span className="jw-record-main">
          <span className="jw-record-top">
            <span className="jw-record-title">{title}</span>
            {status ? <span className="jw-record-status">{status}</span> : null}
          </span>
          <span className="jw-record-caption">
            {reference ? <span className="mono">{reference}</span> : null}
            {reference && caption ? ' • ' : null}
            {caption}
          </span>
          {date || figure ? (
            <span className="jw-record-foot">
              {date ? (
                <span className="jw-record-date">
                  <Icon name="calendar" size={1.15} />
                  {date}
                </span>
              ) : (
                <span />
              )}
              {figure ? <span className="jw-record-figure numeric">{figure}</span> : null}
            </span>
          ) : null}
          {typeof progress === 'number' ? (
            <span className="jw-record-progress">
              <span
                className="jw-progress"
                role="progressbar"
                aria-label="Progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(progress)}
              >
                <span style={{ width: `${Math.max(0, Math.min(100, progress))}%` }} />
              </span>
              <span className="jw-record-progress-value" aria-hidden="true">
                {Math.round(progress)}%
              </span>
            </span>
          ) : null}
          {meta ? <span className="jw-record-meta">{meta}</span> : null}
        </span>
        <span className="jw-record-chevron">
          <Icon name="chevron" size={1.4} />
        </span>
      </UiLink>
    );
  }
  return (
    <UiLink href={href} className="jw-record">
      <span className="jw-record-main">
        <span className="jw-record-ref mono">{reference}</span>
        <span className="jw-record-title">{title}</span>
        {caption ? <span className="jw-record-caption">{caption}</span> : null}
      </span>
      <span className="jw-record-side">
        {figure ? <span className="jw-record-figure numeric">{figure}</span> : null}
        {status ? <span className="jw-record-status">{status}</span> : null}
        {meta ? <span className="jw-record-meta">{meta}</span> : null}
      </span>
      <span className="jw-record-chevron">
        <Icon name="chevron" />
      </span>
    </UiLink>
  );
}

/** Stacks record cards with the gap the prototype uses; nothing else. */
export function RecordList({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="jw-record-list">{children}</div>;
}
