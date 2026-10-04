/**
 * Typed map of the semantic tokens (doc 21 §2, "exported as CSS custom properties and
 * a typed TS map").
 *
 * Components reference `token.colorAction`, never the string `'var(--color-action)'`,
 * so a renamed token is a compile error rather than a silently transparent element.
 * Primitives are deliberately absent: `DS-01` keeps them internal to the stylesheet.
 */

function cssVar<T extends string>(name: T): `var(--${T})` {
  return `var(--${name})` as `var(--${T})`;
}

export const token = {
  // surfaces and text
  bg: cssVar('color-bg'),
  surface: cssVar('color-surface'),
  border: cssVar('color-border'),
  text: cssVar('color-text'),
  textMuted: cssVar('color-text-muted'),
  action: cssVar('color-action'),
  actionHover: cssVar('color-action-hover'),
  focusRing: cssVar('color-focus-ring'),

  // spacing
  space1: cssVar('space-1'),
  space2: cssVar('space-2'),
  space3: cssVar('space-3'),
  space4: cssVar('space-4'),
  space5: cssVar('space-5'),
  space6: cssVar('space-6'),
  space7: cssVar('space-7'),
  space8: cssVar('space-8'),

  // radius and elevation
  radiusSm: cssVar('radius-sm'),
  radiusMd: cssVar('radius-md'),
  radiusLg: cssVar('radius-lg'),
  shadowRaised: cssVar('shadow-raised'),
  shadowOverlay: cssVar('shadow-overlay'),
  shadowModal: cssVar('shadow-modal'),

  // type
  textDisplay: cssVar('text-display'),
  textHeading1: cssVar('text-heading-1'),
  textHeading2: cssVar('text-heading-2'),
  textBody: cssVar('text-body'),
  textBodyStrong: cssVar('text-body-strong'),
  textCaption: cssVar('text-caption'),
  textMono: cssVar('text-mono'),

  // density
  rowHeight: cssVar('row-height'),
  controlHeight: cssVar('control-height'),
  tableCellPad: cssVar('table-cell-pad'),

  // motion
  motionFast: cssVar('motion-fast'),
  motionBase: cssVar('motion-base'),
  motionEase: cssVar('motion-ease'),

  // containers
  containerNarrow: cssVar('container-narrow'),
  containerPage: cssVar('container-page'),
  containerWide: cssVar('container-wide'),
} as const;

/** The six semantic statuses of doc 21 §3. Every status surface uses one of these. */
export const STATUS_TONES = [
  'neutral',
  'progress',
  'attention',
  'positive',
  'blocked',
  'special',
] as const;

export type Tone = (typeof STATUS_TONES)[number];

export interface ToneTriple {
  fg: string;
  bg: string;
  border: string;
}

/** `DS-06`: each status ships as a tested triple, addressed by name rather than by hex. */
export function toneTriple(tone: Tone): ToneTriple {
  return {
    fg: `var(--status-${tone}-fg)`,
    bg: `var(--status-${tone}-bg)`,
    border: `var(--status-${tone}-border)`,
  };
}

/** Doc 21 §5 breakpoints, for the rare component that must branch in JS. */
export const BREAKPOINTS = { sm: 640, md: 768, lg: 1024, xl: 1280, xxl: 1536 } as const;
