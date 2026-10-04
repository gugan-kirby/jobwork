'use client';

import type { CSSProperties, ReactNode } from 'react';

/**
 * Spacing on the 8-pt grid without margin literals scattered through screens.
 * `gap` names a spacing token; there is no escape hatch to an arbitrary pixel value,
 * which is the point (`DS-01`).
 */

type Gap = 1 | 2 | 3 | 4 | 5 | 6;

export interface StackProps {
  gap?: Gap | undefined;
  /**
   * Hairline separators between children — the list-row pattern several screens were
   * each re-declaring with their own `borderTop`. Rendered as a border on the stack's
   * own children so a conditional child never leaves a stray rule behind.
   */
  divided?: boolean | undefined;
  children: ReactNode;
  style?: CSSProperties | undefined;
}

export function Stack({ gap = 4, divided, children, style }: StackProps): React.JSX.Element {
  return (
    <div
      className={divided ? 'jw-stack-divided' : undefined}
      style={{ display: 'grid', gap: `var(--space-${gap})`, ...style }}
    >
      {children}
    </div>
  );
}

export interface InlineProps extends StackProps {
  align?: CSSProperties['alignItems'] | undefined;
  justify?: CSSProperties['justifyContent'] | undefined;
  wrap?: boolean | undefined;
}

export function Inline({
  gap = 3,
  align = 'center',
  justify,
  wrap = true,
  children,
  style,
}: InlineProps): React.JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        gap: `var(--space-${gap})`,
        alignItems: align,
        justifyContent: justify,
        flexWrap: wrap ? 'wrap' : 'nowrap',
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/**
 * The two-pane operations layout (doc 14 §6 intake workspace, later the RFQ control
 * room). Collapses to one column below `lg`, where the side pane follows the main
 * content rather than being squeezed beside it.
 */
export function SplitPane({
  main,
  side,
  children: _children,
}: {
  main: ReactNode;
  side: ReactNode;
  children?: never;
}): React.JSX.Element {
  return (
    <div className="jw-split">
      {/* `alignContent: start` on both columns: without it the grid stretches each
          card to fill the taller column's height, and a short card grows a pool of
          dead space under its content. */}
      <div style={{ display: 'grid', gap: 'var(--space-4)', alignContent: 'start', minWidth: 0 }}>
        {main}
      </div>
      <div style={{ display: 'grid', gap: 'var(--space-4)', alignContent: 'start', minWidth: 0 }}>
        {side}
      </div>
    </div>
  );
}
