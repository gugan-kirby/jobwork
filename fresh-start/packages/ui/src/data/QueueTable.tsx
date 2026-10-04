'use client';

import type { ReactNode } from 'react';
import type { Tone } from '../tokens';
import { StatusChip } from '../status/StatusChip';
import { UiLink } from '../primitives/Link';
import { DataTable, type Column } from './DataTable';

/**
 * The operations queue table (doc 21 §6 "Queue table": sticky context column, owner,
 * due/overdue states; F-11.1).
 *
 * A deadline is shown the way doc 05 §10 stores it: an instant read in a declared zone,
 * so "5 Oct, 14:30 IST" and never a bare time a reader in another office would misread.
 * Where an item stands is said in words beside its colour (`DS-07`) — "Overdue, raised
 * with the team" — and a row offers only the actions its owner and the reader allow:
 * the caller decides per row, the table never renders a button that would be refused.
 *
 * Not built yet, and recorded in the IN-11 plan: virtualisation (queues are tens of rows
 * at launch) and bulk selection.
 */

export type QueueState = 'no_target' | 'on_track' | 'due_soon' | 'overdue';

export interface QueueTableItem {
  /** Unique across queues: one subject can wait in two queues at once. */
  key: string;
  reference: string;
  title: string;
  queueLabel: string;
  href: string;
  waitingSince: string;
  dueAt: string | null;
  timeZone: string | null;
  state: QueueState;
  escalationLevel: number;
  /** Display name of whoever has it, or null while it is unassigned. */
  owner: string | null;
  mine: boolean;
}

export interface QueueTableProps<T extends QueueTableItem> {
  caption: string;
  items: readonly T[] | null;
  /** The row's own actions; return null for none. */
  actions?: ((item: T) => ReactNode) | undefined;
  /** Hide the queue name when every row comes from one queue. */
  showQueue?: boolean | undefined;
  empty?: { title: string; detail: string } | undefined;
  /** For tests: the instant ages are measured from. */
  now?: Date | undefined;
}

const STATE: Record<QueueState, { tone: Tone; label: string }> = {
  overdue: { tone: 'blocked', label: 'Overdue' },
  due_soon: { tone: 'attention', label: 'Due soon' },
  on_track: { tone: 'progress', label: 'On track' },
  no_target: { tone: 'neutral', label: 'No target' },
};

/** "5 Oct, 14:30 IST" — the deadline in its own zone, labelled. */
export function formatDue(dueAt: string, timeZone: string | null): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: timeZone ?? 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
  }).format(new Date(dueAt));
}

/** "3 d 4 h", "5 h 20 min", "12 min" — how long something has waited. */
export function formatAge(since: string, now: Date = new Date()): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - new Date(since).getTime()) / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return hours > 0 ? `${days} d ${hours} h` : `${days} d`;
  if (hours > 0) return `${hours} h ${minutes % 60} min`;
  return `${minutes} min`;
}

export function DueLabel({ state, dueAt, timeZone, escalationLevel }: Pick<QueueTableItem, 'state' | 'dueAt' | 'timeZone' | 'escalationLevel'>): React.JSX.Element {
  const meta = STATE[state];
  const raised = state === 'overdue' && escalationLevel >= 2;
  return (
    <span style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)' }}>
      <StatusChip tone={meta.tone} silent>
        {raised ? 'Overdue, raised with the team' : meta.label}
      </StatusChip>
      {dueAt ? <span className="numeric">{formatDue(dueAt, timeZone)}</span> : null}
    </span>
  );
}

export function QueueTable<T extends QueueTableItem>({ caption, items, actions, showQueue = true, empty, now }: QueueTableProps<T>): React.JSX.Element {
  const columns: Array<Column<T>> = [
    {
      key: 'reference',
      header: 'Reference',
      sticky: true,
      // A neutral reference ("Supplier", "Application") repeats down the column; the
      // hidden title makes each link's name say which record it opens (WCAG 2.4.4).
      render: (item) => (
        <UiLink href={item.href}>
          {item.reference}
          <span className="jw-visually-hidden">, {item.title}</span>
        </UiLink>
      ),
    },
    {
      key: 'item',
      header: 'Item',
      render: (item) => (
        <span style={{ display: 'flex', flexDirection: 'column' }}>
          <span>{item.title}</span>
          {showQueue ? <span style={{ font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>{item.queueLabel}</span> : null}
        </span>
      ),
    },
    { key: 'waiting', header: 'Waiting', numeric: true, render: (item) => formatAge(item.waitingSince, now) },
    {
      key: 'due',
      header: 'Due',
      render: (item) => <DueLabel state={item.state} dueAt={item.dueAt} timeZone={item.timeZone} escalationLevel={item.escalationLevel} />,
    },
    {
      key: 'owner',
      header: 'Owner',
      render: (item) => (item.mine ? 'You' : item.owner ?? <span style={{ color: 'var(--color-text-muted)' }}>Unassigned</span>),
    },
  ];
  if (actions) {
    columns.push({ key: 'actions', header: 'Actions', render: (item) => actions(item) });
  }
  return (
    <DataTable
      caption={caption}
      columns={columns}
      rows={items}
      rowKey={(item) => item.key}
      // The stacked card is headed by the reference link alone; the title is its first row.
      stackTitle={(item) => (
        <UiLink href={item.href}>
          {item.reference}
          <span className="jw-visually-hidden">, {item.title}</span>
        </UiLink>
      )}
      empty={empty ?? { title: 'Nothing waiting', detail: 'When work arrives in these queues it is listed here, oldest deadline first.' }}
    />
  );
}
