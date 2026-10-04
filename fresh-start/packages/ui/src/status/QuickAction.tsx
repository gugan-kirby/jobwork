import type { ReactNode } from 'react';
import { Icon, type IconName } from '../primitives/Icon';
import type { Tone } from '../tokens';
import { UiLink } from '../primitives/Link';

/**
 * A quick-action tile (F-MX.5, prototype tile 4 "Quick Actions"): icon, label, and the
 * number of things waiting behind it. The count is the reason to tap — a tile that says
 * "Invoices" is a menu entry; one that says "Invoices · 2 unpaid" is a to-do.
 *
 * The count is spoken as part of the link name, so the badge is never colour alone
 * (`DS-07`), and a zero renders nothing rather than a hollow "0".
 */

export interface QuickActionProps {
  href: string;
  icon: IconName;
  label: string;
  /** Items waiting; omitted or zero renders no badge. */
  count?: number | undefined;
  /** What the count is of, spoken after the number: "2 unpaid". */
  countLabel?: string | undefined;
  /** Colours the icon disc; `attention` when the count needs acting on. */
  tone?: Tone | undefined;
}

export function QuickAction({
  href,
  icon,
  label,
  count,
  countLabel,
  tone = 'progress',
}: QuickActionProps): React.JSX.Element {
  const showCount = typeof count === 'number' && count > 0;
  return (
    <UiLink href={href} className="jw-quick">
      <span className={`jw-quick-disc jw-quick-disc-${tone}`}>
        <Icon name={icon} size={1.5} />
      </span>
      <span className="jw-quick-label">{label}</span>
      {showCount ? (
        <span className="jw-quick-count">
          {count}
          {countLabel ? <span className="jw-visually-hidden"> {countLabel}</span> : null}
        </span>
      ) : null}
    </UiLink>
  );
}

/** The 3-up grid the tiles sit in; collapses to 2-up on the narrowest phones. */
export function QuickActionGrid({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="jw-quick-grid">{children}</div>;
}
