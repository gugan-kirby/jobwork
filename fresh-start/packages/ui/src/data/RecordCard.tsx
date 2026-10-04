import type { ReactNode } from 'react';
import { Icon } from '../primitives/Icon';
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
}

export function RecordCard({
  href,
  reference,
  title,
  caption,
  figure,
  status,
  meta,
}: RecordCardProps): React.JSX.Element {
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
