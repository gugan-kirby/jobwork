import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CopyableId } from '../src/data/CopyableId';
import { DataTable, type Column } from '../src/data/DataTable';
import { Stepper } from '../src/data/Stepper';
import { EmptyState, LoadingState, RouteError } from '../src/data/States';
import { AppShell } from '../src/layout/AppShell';

interface Row {
  id: string;
  reference: string;
  quantity: number;
}

const columns: ReadonlyArray<Column<Row>> = [
  { key: 'reference', header: 'Reference', render: (row) => row.reference },
  { key: 'quantity', header: 'Quantity', render: (row) => row.quantity, numeric: true },
];

/**
 * The two renderings are chosen by a media query, and jsdom does not evaluate media
 * queries against a viewport — so in these tests both are present but reported as
 * hidden. `hidden: true` is therefore not a loosening of the assertion; it is how you
 * see either rendering at all here. In a browser exactly one is in the a11y tree.
 */
describe('DataTable (doc 21 §6, §9 reflow)', () => {
  const rows: Row[] = [
    { id: 'a', reference: 'ENQ-2026-0001', quantity: 500 },
    { id: 'b', reference: 'ENQ-2026-0002', quantity: 12 },
  ];

  it('renders every row twice — once as a table, once as the stacked reflow alternative', () => {
    render(<DataTable caption="Enquiries" columns={columns} rows={rows} rowKey={(r) => r.id} />);

    // The wide rendering.
    const table = screen.getByRole('table', { name: 'Enquiries', hidden: true });
    expect(within(table).getAllByRole('row', { hidden: true })).toHaveLength(rows.length + 1);

    // The narrow rendering, which doc 21 §9 requires instead of sideways scrolling.
    // Both come from one column definition, so a new column cannot appear in only one.
    const stack = document.querySelector('.jw-table-stack');
    expect(stack?.children).toHaveLength(rows.length);
    expect(stack?.textContent).toContain('ENQ-2026-0002');
  });

  it('marks numeric columns for tabular alignment (DS-08)', () => {
    render(<DataTable caption="Enquiries" columns={columns} rows={rows} rowKey={(r) => r.id} />);
    const header = screen.getByRole('columnheader', { name: 'Quantity', hidden: true });
    expect(header).toHaveClass('numeric');
  });

  it('shows the loading state without any enabled control', () => {
    render(<DataTable caption="Enquiries" columns={columns} rows={null} rowKey={(r) => r.id} />);
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('explains an empty list rather than shrugging at it', () => {
    render(
      <DataTable
        caption="Enquiries"
        columns={columns}
        rows={[]}
        rowKey={(r) => r.id}
        empty={{ title: 'No enquiries yet', detail: 'Create one and it appears here.' }}
      />,
    );
    expect(screen.getByText('No enquiries yet')).toBeInTheDocument();
    expect(screen.getByText('Create one and it appears here.')).toBeInTheDocument();
  });
});

describe('Stepper (doc 21 §7)', () => {
  it('marks the current step and states each step state in words, not colour alone', () => {
    render(
      <Stepper
        steps={[
          { label: 'Job', state: 'complete' },
          { label: 'Items', state: 'error' },
          { label: 'Material', state: 'error' },
          { label: 'Review', state: 'incomplete' },
        ]}
        current={1}
        onSelect={() => undefined}
      />,
    );

    // Position and state are independent facts. A failed submit lands the reader on a
    // step that is current *and* in error, and both have to survive — an earlier draft
    // folded them into one value and dropped "you are here" exactly when it mattered.
    const items = screen.getByRole('button', { name: /Items/ });
    expect(items).toHaveAttribute('aria-current', 'step');
    expect(items.getAttribute('aria-label')).toContain('Needs attention');
    expect(items.getAttribute('aria-label')).toContain('You are here');

    // DS-07: a failing step that is not current still says so, and says nothing about
    // position.
    const material = screen.getByRole('button', { name: /Material/ });
    expect(material).not.toHaveAttribute('aria-current');
    expect(material.getAttribute('aria-label')).toContain('Needs attention');
    expect(screen.getByRole('button', { name: /Job. Completed/ })).toBeInTheDocument();
  });
});

describe('CopyableId (DS-10)', () => {
  it('truncates middle-out on screen but exposes the whole value to assistive tech', () => {
    const hash = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
    render(<CopyableId value={hash} label="SHA-256" />);

    const control = screen.getByRole('button', { name: `SHA-256: ${hash}. Copy` });
    expect(control.textContent).toContain('…');
    expect(control.textContent).not.toBe(hash);
    expect(control).toHaveAttribute('title', hash);
  });
});

describe('AppShell (doc 21 §9 landmarks)', () => {
  it('puts the skip link first and points it at the single main landmark', () => {
    render(
      <AppShell productName="JobWork" navigation={[{ href: '/enquiries', label: 'Enquiries' }]} currentPath="/enquiries">
        <p>Body</p>
      </AppShell>,
    );

    const skip = screen.getByRole('link', { name: 'Skip to content' });
    expect(skip).toHaveAttribute('href', '#main');
    // It must be the first focusable thing on the page, or it cannot do its job.
    const focusable = document.querySelectorAll('a[href], button, [tabindex]');
    expect(focusable[0]).toBe(skip);

    expect(screen.getByRole('main')).toHaveAttribute('id', 'main');
    expect(screen.getByRole('link', { name: 'Enquiries', hidden: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
});

describe('States', () => {
  it('requires an empty state to explain itself', () => {
    render(<EmptyState title="Nothing waiting" detail="New submissions appear here." />);
    expect(screen.getByText('New submissions appear here.')).toBeInTheDocument();
  });

  it('announces loading politely', () => {
    render(<LoadingState label="Loading enquiries" />);
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
  });
});

describe('RouteError (F-FE.5)', () => {
  it('names the support reference and offers retry and home, never the error text', () => {
    const retry = vi.fn();
    render(<RouteError digest="2846135799" onRetry={retry} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('We could not show this page');
    expect(alert).toHaveTextContent('PAGE_ERROR · 2846135799');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('link', { name: 'Go to home' })).toHaveAttribute('href', '/');
  });
});
