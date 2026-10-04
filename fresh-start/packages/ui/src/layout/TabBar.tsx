'use client';

import { Icon, type IconName } from '../primitives/Icon';
import { isActivePath } from './paths';
import { UiLink } from '../primitives/Link';

/**
 * The bottom tab bar (F-MX.2, prototype tiles 4/8/11/13–16). Phones get their primary
 * navigation where the thumb is; above `md` the bar is hidden and the header carries
 * the same links, so nothing exists only at one width (doc 21 §12).
 *
 * Four destinations and a raised centre action, by design rather than by prop: the
 * prototype's "+" is the one thing a customer does most (create an enquiry) and the
 * bar exists to keep it one tap away. A bar with seven equal items is a menu, not a
 * tab bar.
 *
 * Accessibility: a `nav` landmark with its own name (the header nav is "Primary"),
 * `aria-current="page"` on the active item, 44 px targets (doc 21 §9), and a badge that
 * is spoken as a count rather than left as a coloured dot (`DS-07`).
 */

export interface TabItem {
  href: string;
  label: string;
  icon: IconName;
  badge?: number | undefined;
}

export interface TabPrimaryAction {
  href: string;
  /** Spoken name of the raised button — it shows only an icon. */
  label: string;
  icon?: IconName | undefined;
}

export interface TabBarProps {
  items: readonly TabItem[];
  currentPath?: string | undefined;
  /** The raised centre action. Rendered between the second and third item. */
  primary?: TabPrimaryAction | undefined;
}

export function TabBar({ items, currentPath, primary }: TabBarProps): React.JSX.Element {
  const splitAt = Math.ceil(items.length / 2);
  const leading = items.slice(0, splitAt);
  const trailing = items.slice(splitAt);

  const renderItem = (item: TabItem): React.JSX.Element => {
    const active = isActivePath(currentPath, item.href);
    return (
      <UiLink
        key={item.href}
        href={item.href}
        className={active ? 'jw-tab jw-tab-current' : 'jw-tab'}
        {...(active ? { 'aria-current': 'page' as const } : {})}
      >
        <span className="jw-tab-icon">
          <Icon name={item.icon} size={1.4} />
          {item.badge && item.badge > 0 ? (
            <span className="jw-tab-badge">
              {item.badge > 99 ? '99+' : item.badge}
              <span className="jw-visually-hidden"> waiting</span>
            </span>
          ) : null}
        </span>
        <span className="jw-tab-label">{item.label}</span>
      </UiLink>
    );
  };

  return (
    <nav aria-label="Primary, bottom bar" className="jw-tabbar">
      {leading.map(renderItem)}
      {primary ? (
        <UiLink href={primary.href} className="jw-tab jw-tab-primary" aria-label={primary.label}>
          <span className="jw-tab-primary-disc">
            <Icon name={primary.icon ?? 'plus'} size={1.5} />
          </span>
        </UiLink>
      ) : null}
      {trailing.map(renderItem)}
    </nav>
  );
}
