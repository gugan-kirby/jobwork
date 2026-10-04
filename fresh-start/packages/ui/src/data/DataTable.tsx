'use client';

import type { ReactNode } from 'react';
import { EmptyState, LoadingState } from './States';

/**
 * The queue/list table for both apps (doc 21 §6).
 *
 * The part that matters is the reflow contract in doc 21 §9: "dense operations tables
 * provide a per-row detail view as the reflow alternative". Rather than letting a wide
 * table scroll sideways off a phone, the same rows render as stacked label/value cards
 * below `md`. Both renderings come from one column definition, so they cannot drift —
 * a column added for the desktop view appears on mobile automatically.
 *
 * Columns marked `numeric` get tabular numerals and right alignment (`DS-08`), so
 * figures line up in the only place that matters: next to each other.
 */

export interface Column<Row> {
  key: string;
  header: string;
  render: (row: Row) => ReactNode;
  /** Money, quantities, measurements — aligned right with fixed-width digits. */
  numeric?: boolean | undefined;
  /** Hidden in the stacked mobile rendering (e.g. a redundant status already in the title). */
  hideOnStack?: boolean | undefined;
  width?: string | undefined;
}

export interface DataTableProps<Row> {
  /** Describes the table for assistive tech; visually hidden unless `showCaption`. */
  caption: string;
  showCaption?: boolean | undefined;
  columns: ReadonlyArray<Column<Row>>;
  rows: readonly Row[] | null;
  rowKey: (row: Row) => string;
  /** Title line for the stacked mobile card; defaults to the first column. */
  stackTitle?: ((row: Row) => ReactNode) | undefined;
  empty?: { title: string; detail: string; action?: ReactNode } | undefined;
  loadingLabel?: string | undefined;
  onRowClick?: ((row: Row) => void) | undefined;
}

export function DataTable<Row>({
  caption,
  showCaption = false,
  columns,
  rows,
  rowKey,
  stackTitle,
  empty,
  loadingLabel,
  onRowClick,
}: DataTableProps<Row>): React.JSX.Element {
  if (rows === null) {
    return <LoadingState {...(loadingLabel ? { label: loadingLabel } : {})} rows={4} />;
  }
  if (rows.length === 0) {
    return (
      <EmptyState
        title={empty?.title ?? 'Nothing here yet'}
        detail={empty?.detail ?? 'When there is something to show, it appears in this list.'}
        {...(empty?.action ? { action: empty.action } : {})}
      />
    );
  }

  const first = columns[0];

  return (
    <>
      {/* Wide: a real table, header sticky inside its own scroll container. */}
      <div className="jw-table-wrap">
        <table style={{ width: '100%', borderCollapse: 'collapse', font: 'var(--text-body)' }}>
          <caption className={showCaption ? undefined : 'jw-visually-hidden'}
            style={showCaption ? { font: 'var(--text-caption)', color: 'var(--color-text-muted)', textAlign: 'left', padding: 'var(--space-2) var(--table-cell-pad)' } : undefined}
          >
            {caption}
          </caption>
          <thead>
            <tr>
              {columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  className={column.numeric ? 'numeric' : undefined}
                  style={{
                    position: 'sticky',
                    top: 0,
                    zIndex: 1,
                    textAlign: column.numeric ? 'right' : 'left',
                    background: 'var(--table-header-bg)',
                    borderBottom: '1px solid var(--table-border)',
                    padding: 'var(--table-cell-pad)',
                    font: 'var(--text-caption)',
                    color: 'var(--color-text-muted)',
                    whiteSpace: 'nowrap',
                    width: column.width,
                  }}
                >
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={rowKey(row)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                style={{
                  borderBottom: '1px solid var(--table-border)',
                  height: 'var(--row-height)',
                  cursor: onRowClick ? 'pointer' : undefined,
                }}
              >
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={column.numeric ? 'numeric' : undefined}
                    style={{
                      padding: 'var(--table-cell-pad)',
                      textAlign: column.numeric ? 'right' : 'left',
                      verticalAlign: 'middle',
                    }}
                  >
                    {column.render(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Narrow: the documented reflow alternative — one card per row, no sideways scroll. */}
      <ul className="jw-table-stack" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {rows.map((row) => (
          <li
            key={rowKey(row)}
            style={{
              borderBottom: '1px solid var(--table-border)',
              padding: 'var(--space-3) var(--table-cell-pad)',
            }}
          >
            <p style={{ font: 'var(--text-body-strong)', marginBottom: 'var(--space-2)' }}>
              {stackTitle ? stackTitle(row) : first ? first.render(row) : null}
            </p>
            <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: 'var(--space-1) var(--space-3)', margin: 0, font: 'var(--text-caption)' }}>
              {columns
                .filter((column) => !column.hideOnStack && column !== first)
                .map((column) => (
                  <div key={column.key} style={{ display: 'contents' }}>
                    <dt style={{ color: 'var(--color-text-muted)' }}>{column.header}</dt>
                    <dd className={column.numeric ? 'numeric' : undefined} style={{ margin: 0 }}>
                      {column.render(row)}
                    </dd>
                  </div>
                ))}
            </dl>
          </li>
        ))}
      </ul>

    </>
  );
}
