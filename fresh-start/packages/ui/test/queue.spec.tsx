import axe from 'axe-core';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Button } from '../src/primitives/Button';
import { formatAge, formatDue, QueueTable, type QueueTableItem } from '../src/data/QueueTable';

const NOW = new Date('2026-10-05T09:00:00Z');

const ITEMS: QueueTableItem[] = [
  {
    key: 'triage:a',
    reference: 'ENQ-2026-0001',
    title: 'Impeller housing',
    queueLabel: 'Enquiries awaiting triage',
    href: '/intake/a',
    waitingSince: '2026-10-02T05:00:00Z',
    dueAt: '2026-10-03T04:00:00Z',
    timeZone: 'Asia/Kolkata',
    state: 'overdue',
    escalationLevel: 2,
    owner: 'Priya',
    mine: false,
  },
  {
    key: 'triage:b',
    reference: 'ENQ-2026-0002',
    title: 'Bracket support',
    queueLabel: 'Enquiries awaiting triage',
    href: '/intake/b',
    waitingSince: '2026-10-05T08:40:00Z',
    dueAt: '2026-10-05T10:00:00Z',
    timeZone: 'Asia/Kolkata',
    state: 'due_soon',
    escalationLevel: 0,
    owner: null,
    mine: false,
  },
  {
    key: 'invites:c',
    reference: 'Invitation',
    title: 'new.person@kovai.test',
    queueLabel: 'Invitations not yet accepted',
    href: '/organizations/x',
    waitingSince: '2026-10-04T09:00:00Z',
    dueAt: null,
    timeZone: null,
    state: 'no_target',
    escalationLevel: 0,
    owner: 'Ravi',
    mine: true,
  },
];

/**
 * The queue table (F-11.1, doc 21 §6). The wide and stacked renderings are both in the
 * jsdom tree (no media queries), hence `hidden: true` — see `data.spec.tsx`.
 */
describe('QueueTable (F-11.1)', () => {
  it('states where each item stands in words, with its deadline in a labelled zone', () => {
    render(<QueueTable caption="Work queues" items={ITEMS} now={NOW} />);
    const table = screen.getByRole('table', { name: 'Work queues', hidden: true });
    const rows = within(table).getAllByRole('row', { hidden: true }).slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('Overdue, raised with the team');
    expect(rows[0]).toHaveTextContent('3 Oct, 09:30 IST');
    expect(rows[0]).toHaveTextContent('3 d 4 h');
    expect(rows[1]).toHaveTextContent('Due soon');
    expect(rows[1]).toHaveTextContent('Unassigned');
    expect(rows[2]).toHaveTextContent('No target');
    expect(rows[2]).toHaveTextContent('You');
    // The reference is the link to the record, in the column that stays in view.
    expect(within(rows[0]!).getByRole('link', { name: 'ENQ-2026-0001, Impeller housing', hidden: true })).toHaveAttribute('href', '/intake/a');
  });

  it('offers only the actions the caller gives each row', () => {
    render(
      <QueueTable
        caption="Work queues"
        items={ITEMS}
        now={NOW}
        actions={(item) => (item.owner === null ? <Button size="sm">Take {item.reference}</Button> : null)}
      />,
    );
    const table = screen.getByRole('table', { name: 'Work queues', hidden: true });
    expect(within(table).getAllByRole('button', { hidden: true }).map((b) => b.textContent)).toEqual(['Take ENQ-2026-0002']);
  });

  it('hides the queue name when one queue is shown, and says so when nothing waits', () => {
    const { rerender } = render(<QueueTable caption="Work queues" items={ITEMS.slice(0, 1)} now={NOW} showQueue={false} />);
    expect(screen.getByRole('table', { name: 'Work queues', hidden: true })).not.toHaveTextContent('Enquiries awaiting triage');
    rerender(<QueueTable caption="Work queues" items={[]} now={NOW} />);
    expect(screen.getByText('Nothing waiting')).toBeInTheDocument();
  });

  it('formats ages and zone-labelled deadlines', () => {
    expect(formatAge('2026-10-05T08:48:00Z', NOW)).toBe('12 min');
    expect(formatAge('2026-10-05T03:40:00Z', NOW)).toBe('5 h 20 min');
    expect(formatAge('2026-10-02T09:00:00Z', NOW)).toBe('3 d');
    expect(formatDue('2026-10-05T13:00:00Z', 'Asia/Kolkata')).toBe('5 Oct, 18:30 IST');
    expect(formatDue('2026-10-05T13:00:00Z', 'Europe/London')).toBe('5 Oct, 14:00 GMT+1');
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <QueueTable caption="Work queues" items={ITEMS} now={NOW} actions={(item) => <Button size="sm">Open {item.reference}</Button>} />,
    );
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
});

describe('QueueTable stacked rendering (F-11.1)', () => {
  it('heads each card with the reference and says the title once', () => {
    render(<QueueTable caption="Work queues" items={ITEMS.slice(0, 1)} now={NOW} />);
    const card = screen.getAllByRole('listitem', { hidden: true })[0]!;
    expect(within(card).getByRole('link', { name: 'ENQ-2026-0001, Impeller housing', hidden: true })).toBeInTheDocument();
    // Once for sight (the Item row), once in the link's hidden name — never twice on screen.
    expect(card.textContent?.match(/Impeller housing/g)).toHaveLength(2);
    expect(within(card).getAllByText('Impeller housing')).toHaveLength(1);
  });
});
