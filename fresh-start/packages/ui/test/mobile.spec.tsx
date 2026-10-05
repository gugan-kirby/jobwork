import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Icon, ICON_NAMES } from '../src/primitives/Icon';
import { TabBar } from '../src/layout/TabBar';
import { AppShell } from '../src/layout/AppShell';
import { Page } from '../src/layout/Page';
import { Hero } from '../src/layout/Hero';
import { activeHref, isActivePath } from '../src/layout/paths';
import { QuickAction, QuickActionGrid } from '../src/status/QuickAction';
import { FilterChips } from '../src/data/FilterChips';
import { RecordCard } from '../src/data/RecordCard';
import { ChoiceCards } from '../src/forms/ChoiceCards';
import { StatusChip } from '../src/status/StatusChip';

/**
 * The phone layer (F-MX.2). What these assert is the accessibility contract each
 * component makes in its own doc comment — landmarks, names, current-page marking,
 * spoken counts — because on a phone the visual affordance is often just an icon.
 */

describe('Icon', () => {
  it.each(ICON_NAMES)('%s is decorative and never in the tab order', (name) => {
    const { container } = render(<Icon name={name} />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('focusable')).toBe('false');
    expect(svg.querySelector('path')?.getAttribute('d')).toBeTruthy();
  });
});

describe('isActivePath', () => {
  it('matches by prefix except for the root, which matches only itself', () => {
    expect(isActivePath('/', '/')).toBe(true);
    expect(isActivePath('/enquiries', '/')).toBe(false);
    expect(isActivePath('/enquiries/abc', '/enquiries')).toBe(true);
    expect(isActivePath('/enquiries-old', '/enquiries')).toBe(false);
    expect(isActivePath(undefined, '/enquiries')).toBe(false);
  });

  it('lights only the most specific item when a section home prefixes its pages', () => {
    const hrefs = ['/supplier', '/supplier/orders', '/supplier/shipments'];
    expect(activeHref('/supplier/shipments/abc', hrefs)).toBe('/supplier/shipments');
    expect(activeHref('/supplier', hrefs)).toBe('/supplier');
    expect(activeHref('/rfqs', hrefs)).toBeUndefined();
  });
});

const TABS = [
  { href: '/', label: 'Home', icon: 'home' as const },
  { href: '/enquiries', label: 'Enquiries', icon: 'enquiries' as const, badge: 2 },
  { href: '/orders', label: 'Orders', icon: 'orders' as const },
  { href: '/profile', label: 'Profile', icon: 'profile' as const },
];

describe('TabBar (doc 21 §9, §12)', () => {
  it('is its own landmark, marks the current page, and speaks a badge as a count', () => {
    render(
      <TabBar
        items={TABS}
        currentPath="/enquiries/abc"
        primary={{ href: '/enquiries/new', label: 'Create enquiry' }}
      />,
    );
    const nav = screen.getByRole('navigation', { name: 'Primary, bottom bar' });
    expect(nav).toBeInTheDocument();
    const current = screen.getByRole('link', { current: 'page' });
    expect(current).toHaveTextContent('Enquiries');
    // "2 waiting", not a red dot.
    expect(current.textContent).toContain('2 waiting');
    // The raised action shows only an icon, so it names itself.
    expect(screen.getByRole('link', { name: 'Create enquiry' })).toHaveAttribute(
      'href',
      '/enquiries/new',
    );
  });

  it('places the primary action in the middle of the items', () => {
    render(
      <TabBar items={TABS} primary={{ href: '/enquiries/new', label: 'Create enquiry' }} />,
    );
    const links = screen.getAllByRole('link');
    expect(links.map((l) => l.getAttribute('href'))).toEqual([
      '/',
      '/enquiries',
      '/enquiries/new',
      '/orders',
      '/profile',
    ]);
  });
});

describe('AppShell with tabs', () => {
  it('renders both navigations with distinct names and a named bell with its count', () => {
    render(
      <AppShell
        productName="JobWork"
        navigation={[{ href: '/', label: 'Home' }, { href: '/enquiries', label: 'Enquiries' }]}
        currentPath="/"
        tabs={TABS}
        primaryAction={{ href: '/enquiries/new', label: 'Create enquiry' }}
        notifications={{ href: '/notifications', count: 3 }}
      >
        <p>content</p>
      </AppShell>,
    );
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Primary, bottom bar' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Notifications, 3 waiting' })).toHaveAttribute(
      'href',
      '/notifications',
    );
    expect(screen.getByRole('main')).toHaveTextContent('content');
    // The menu button is an icon: it must name itself and announce its state.
    const menu = screen.getByRole('button', { name: 'Menu' });
    expect(menu).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(menu);
    expect(menu).toHaveAttribute('aria-expanded', 'true');
  });

  it('renders no tab bar when no tabs are given', () => {
    render(
      <AppShell productName="JobWork" navigation={[]} currentPath="/">
        <p>content</p>
      </AppShell>,
    );
    expect(screen.queryByRole('navigation', { name: 'Primary, bottom bar' })).toBeNull();
  });
});

describe('Page back header', () => {
  it('keeps the h1 and names the back chevron', () => {
    render(
      <Page title="New enquiry" back={{ href: '/enquiries', label: 'Back to enquiries' }}>
        <p>form</p>
      </Page>,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'New enquiry' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to enquiries' })).toHaveAttribute(
      'href',
      '/enquiries',
    );
  });

  it('keeps a hidden h1 when the hero carries the visible heading', () => {
    render(
      <Page title="Home" titleHidden>
        <Hero headline="Precision work." subline="On time." />
      </Page>,
    );
    const heading = screen.getByRole('heading', { level: 1, name: 'Home' });
    expect(heading.className).toContain('jw-visually-hidden');
  });
});

describe('QuickAction', () => {
  it('speaks the count as part of the link and hides a zero', () => {
    render(
      <QuickActionGrid>
        <QuickAction href="/invoices" icon="invoice" label="Invoices" count={2} countLabel="unpaid" />
        <QuickAction href="/orders" icon="orders" label="Orders" count={0} countLabel="in progress" />
      </QuickActionGrid>,
    );
    expect(screen.getByRole('link', { name: /Invoices\s*2\s*unpaid/ })).toBeInTheDocument();
    const orders = screen.getByRole('link', { name: 'Orders' });
    expect(orders.textContent).not.toContain('0');
  });
});

describe('FilterChips (radio group semantics)', () => {
  const options = [
    { value: 'all', label: 'All', count: 4 },
    { value: 'review', label: 'In review', count: 2 },
    { value: 'closed', label: 'Closed' },
  ] as const;

  it('is a labelled radio group with exactly one checked chip', () => {
    render(
      <FilterChips label="Filter enquiries by status" value="review" options={options} onChange={() => undefined} />,
    );
    expect(screen.getByRole('radiogroup', { name: 'Filter enquiries by status' })).toBeInTheDocument();
    const checked = screen.getAllByRole('radio', { checked: true });
    expect(checked).toHaveLength(1);
    expect(checked[0]).toHaveTextContent('In review');
    // Roving tabindex: only the checked chip is a tab stop.
    expect(checked[0]).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('radio', { name: /^All/ })).toHaveAttribute('tabindex', '-1');
  });

  it('moves with the arrow keys and wraps', () => {
    const onChange = vi.fn();
    render(<FilterChips label="Filter" value="closed" options={options} onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Closed' }), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('all');
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Closed' }), { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith('review');
    fireEvent.click(screen.getByRole('radio', { name: /^All/ }));
    expect(onChange).toHaveBeenLastCalledWith('all');
  });
});

describe('RecordCard', () => {
  it('is one link named by reference and title, with status inside', () => {
    render(
      <RecordCard
        href="/enquiries/1"
        reference="ENQ-2026-0001"
        title="Bracket support"
        caption="CNC machining"
        status={<StatusChip tone="progress">Requirement review</StatusChip>}
        meta="10 Aug 2026"
      />,
    );
    const link = screen.getByRole('link', { name: /ENQ-2026-0001.*Bracket support/ });
    expect(link).toHaveAttribute('href', '/enquiries/1');
    expect(link).toHaveTextContent('Requirement review');
    expect(link).toHaveTextContent('10 Aug 2026');
  });
});

describe('ChoiceCards (real radios drawn as cards)', () => {
  const options = [
    { value: 'job_work', label: 'Job work', description: 'Process on your material', icon: 'settings' as const },
    { value: 'new_model', label: 'New model', description: 'A part we have not made before' },
    { value: 'correction_ecn', label: 'Correction / ECN', disabled: true, disabledReason: 'Needs an enquiry on file' },
  ] as const;

  it('groups under a legend, reflects the value, and changes on selection', () => {
    const onChange = vi.fn();
    render(
      <ChoiceCards
        legend="What kind of work is this?"
        hint="You can change it until you submit."
        name="jobType"
        value="job_work"
        options={options}
        onChange={onChange}
      />,
    );
    expect(screen.getByRole('group', { name: 'What kind of work is this?' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Job work/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /Correction/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('radio', { name: /New model/ }));
    expect(onChange).toHaveBeenCalledWith('new_model');
    expect(screen.getByText('Needs an enquiry on file')).toBeInTheDocument();
  });

  it('announces an error against the group', () => {
    render(
      <ChoiceCards legend="Job type" name="jobType" value={null} options={options} onChange={() => undefined} error="Choose one" />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Choose one');
    expect(screen.getByRole('group', { name: 'Job type' })).toHaveAttribute('aria-invalid', 'true');
  });
});
