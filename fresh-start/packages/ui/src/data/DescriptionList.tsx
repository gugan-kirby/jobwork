'use client';

import type { ReactNode } from 'react';

/**
 * Label/value pairs — the shape every detail pane in both apps was hand-rolling.
 * `numeric` values get tabular numerals (`DS-08`) so a column of quantities in a
 * requirement pane lines up the same way it does in a table.
 */

export interface DescriptionItem {
  label: string;
  value: ReactNode;
  numeric?: boolean | undefined;
  mono?: boolean | undefined;
}

export function DescriptionList({
  items,
  columns = 1,
}: {
  items: readonly DescriptionItem[];
  columns?: 1 | 2 | undefined;
}): React.JSX.Element {
  return (
    <dl
      style={{
        display: 'grid',
        gridTemplateColumns: columns === 2 ? 'repeat(auto-fit, minmax(240px, 1fr))' : '1fr',
        gap: 'var(--space-3) var(--space-5)',
        margin: 0,
      }}
    >
      {items.map((item) => (
        <div key={item.label}>
          <dt style={{ font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>
            {item.label}
          </dt>
          <dd
            className={[item.numeric ? 'numeric' : '', item.mono ? 'mono' : ''].join(' ').trim() || undefined}
            style={{ margin: 'var(--space-1) 0 0', overflowWrap: 'anywhere' }}
          >
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
