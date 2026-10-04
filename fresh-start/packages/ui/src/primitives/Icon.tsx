import type { CSSProperties } from 'react';

/**
 * The icon set (F-MX.2). A closed list of stroke glyphs drawn inline, so there is no
 * icon-font request, no third-party package deciding what "orders" looks like, and no
 * way for a screen to reach for an icon the system has not named.
 *
 * Every icon is decorative by contract: `aria-hidden` and `focusable="false"`, sized in
 * `em` so it scales with the text beside it. Meaning always travels in the adjacent
 * label (`DS-07`); a button that is only an icon must give itself an `aria-label`.
 */

const PATHS = {
  home: 'M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  enquiries:
    'M9 4h6a1 1 0 0 1 1 1v1h2a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h2V5a1 1 0 0 1 1-1z M9 12h6 M9 16h4',
  plus: 'M12 5v14 M5 12h14',
  orders: 'M21 8l-9-5-9 5v8l9 5 9-5z M3 8l9 5 9-5 M12 13v8',
  profile: 'M20 21a8 8 0 0 0-16 0 M12 13a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  bell: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9 M10 21h4',
  menu: 'M4 7h16 M4 12h16 M4 17h16',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z M20 20l-4-4',
  chevron: 'M9 6l6 6-6 6',
  back: 'M15 6l-6 6 6 6',
  upload: 'M7 18a4 4 0 0 1-.5-7.97A6 6 0 0 1 18 9a4 4 0 0 1 0 8h-1 M12 12v9 M9 15l3-3 3 3',
  document: 'M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V8z M14 3v5h5',
  invoice: 'M6 3h12v18l-2-1.5L14 21l-2-1.5L10 21l-2-1.5L6 21z M9 8h6 M9 12h6',
  payment: 'M3 6h18v12H3z M3 10h18 M7 15h3',
  quote: 'M20 12l-8 8-9-9V3h8z M7.5 7.5h.01',
  location:
    'M12 21s7-6 7-11a7 7 0 0 0-14 0c0 5 7 11 7 11z M12 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  bolt: 'M13 2L4 14h7l-1 8 9-12h-7z',
  check: 'M5 12l4 4L19 6',
  close: 'M6 6l12 12 M18 6L6 18',
  logout: 'M10 17l5-5-5-5 M15 12H3 M21 4v16',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7 M12 17h.01',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 11v5 M12 8h.01',
  edit: 'M4 20h4l10-10-4-4L4 16z M13 7l4 4',
  team: 'M17 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2 M10 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M21 21v-2a4 4 0 0 0-3-3.9 M16 3.1a4 4 0 0 1 0 7.8',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  factory: 'M3 21V10l6 4V10l6 4V4h6v17z M7 17h2 M11 17h2 M15 17h2',
  wrench:
    'M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.4 2.4-2.1-2.1z',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 7v5l3 2',
  truck:
    'M1 6h13v10H1z M14 10h4l3 3v3h-7z M5.5 19a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z M17.5 19a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z',
  capabilities: 'M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z',
} as const;

export type IconName = keyof typeof PATHS;

export const ICON_NAMES = Object.keys(PATHS) as IconName[];

export interface IconProps {
  name: IconName;
  /** Size in `em` relative to the surrounding text; defaults to a line-height-friendly 1.25. */
  size?: number | undefined;
  style?: CSSProperties | undefined;
}

export function Icon({ name, size = 1.25, style }: IconProps): React.JSX.Element {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      width={`${size}em`}
      height={`${size}em`}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0, verticalAlign: 'middle', ...style }}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
