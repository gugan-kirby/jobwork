import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { CommandButton } from '../src/primitives/CommandButton';
import { useCommandTick } from '../src/primitives/command-events';
import { ErrorSummary } from '../src/primitives/ErrorSummary';
import { TextInput } from '../src/primitives/Field';
import { ButtonLink, LinkProvider, type UiLinkProps } from '../src/primitives/Link';
import { AppShell } from '../src/layout/AppShell';
import { Page } from '../src/layout/Page';
import { RecordCard } from '../src/data/RecordCard';
import { QueueCard } from '../src/status/QueueCard';
import { QuickAction } from '../src/status/QuickAction';

describe('command success announcement (F-12.4)', () => {
  function Counter() {
    return <span data-testid="tick">{useCommandTick()}</span>;
  }

  it('lets a shell refresh its counts after a successful command, and only then', async () => {
    let fail = true;
    const command = vi.fn(async () => {
      if (fail) throw new Error('refused');
    });
    render(
      <>
        <Counter />
        <CommandButton onCommand={command}>Approve</CommandButton>
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(command).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('tick').textContent).toBe('0');
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(screen.getByTestId('tick').textContent).toBe('1'));
  });
});

describe('CommandButton (doc 21 §6, DS-13)', () => {
  it('runs the command once however many times it is clicked mid-flight', async () => {
    let release: (() => void) | undefined;
    const command = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    render(<CommandButton onCommand={command}>Approve for sourcing</CommandButton>);
    const button = screen.getByRole('button');

    // An impatient double-click on a money or approval command must not fire twice —
    // the API is idempotent, but the button is the first line, not the last.
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);

    expect(command).toHaveBeenCalledTimes(1);
    expect(button).toHaveAttribute('aria-busy', 'true');

    release?.();
    await waitFor(() => expect(button).not.toHaveAttribute('aria-busy'));
  });

  it('shows the stable problem code on failure and leaves the button usable', async () => {
    const command = vi
      .fn()
      .mockRejectedValue({
        problem: { code: 'SOURCING_BLOCKED', title: 'Not ready', detail: 'Resolve the checklist.' },
      });

    render(<CommandButton onCommand={command}>Approve</CommandButton>);
    fireEvent.click(screen.getByRole('button'));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Resolve the checklist.');
    // Support asks for the code, so the code is on screen — not only in a console.
    expect(alert.textContent).toContain('SOURCING_BLOCKED');
    expect(screen.getByRole('button')).not.toBeDisabled();
  });

  it('never renders success before the server confirms it', async () => {
    let release: (() => void) | undefined;
    const command = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));

    render(
      <CommandButton onCommand={command} receiptLabel="Approved">
        Approve
      </CommandButton>,
    );
    fireEvent.click(screen.getByRole('button'));

    // In flight: still the command label, never the receipt (DS-13, no optimistic UI).
    expect(screen.getByRole('button').textContent).toBe('Approve');
    release?.();
    await waitFor(() => expect(screen.getByRole('button').textContent).toBe('Approved'));
  });
});

describe('Field wiring (doc 21 §9)', () => {
  it('associates label, hint and error with the control', () => {
    render(
      <TextInput
        label="Part name"
        hint="As it appears on the drawing"
        error="Name the part or describe what it is"
        defaultValue=""
      />,
    );

    const input = screen.getByLabelText('Part name');
    expect(input).toHaveAttribute('aria-invalid', 'true');

    const describedBy = input.getAttribute('aria-describedby') ?? '';
    const described = describedBy
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent)
      .join(' ');
    expect(described).toContain('As it appears on the drawing');
    expect(described).toContain('Name the part or describe what it is');
  });

  it('marks a required field for both sighted and assistive readers', () => {
    render(<TextInput label="Required by" required defaultValue="" />);
    expect(screen.getByLabelText(/Required by/)).toBeRequired();
    expect(screen.getByText('(required)')).toBeTruthy();
  });
});

describe('ErrorSummary (doc 21 §7 and §9)', () => {
  it('takes focus when a submit fails and links each issue to its step', () => {
    const onNavigate = vi.fn();
    function Harness(): React.JSX.Element {
      const [issues, setIssues] = useState<Array<{ path: string; message: string }>>([]);
      return (
        <>
          <button type="button" onClick={() => setIssues([{ path: 'title', message: 'Give the enquiry a short title' }])}>
            Submit
          </button>
          <ErrorSummary issues={issues} onNavigate={onNavigate} />
        </>
      );
    }

    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

    const summary = screen.getByRole('alert');
    expect(document.activeElement).toBe(summary);

    fireEvent.click(screen.getByRole('button', { name: 'Give the enquiry a short title' }));
    expect(onNavigate).toHaveBeenCalledWith('title');
  });

  it('renders nothing when there is nothing wrong', () => {
    const { container } = render(<ErrorSummary issues={[]} />);
    expect(container.firstChild).toBeNull();
  });
});

describe('ButtonLink and LinkProvider (F-FE.4)', () => {
  it('is one link with the button’s look, not a button nested in a link', () => {
    const { container } = render(<ButtonLink href="/enquiries/new" variant="secondary">Create enquiry</ButtonLink>);
    const link = screen.getByRole('link', { name: 'Create enquiry' });
    expect(link).toHaveAttribute('href', '/enquiries/new');
    expect(container.querySelector('a button, button a')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(link.style.minHeight).toBe('var(--control-height)');
    expect(link.style.textDecoration).toBe('none');
  });

  it('renders an unavailable navigation as a disabled button with its reason, never a link', () => {
    render(
      <ButtonLink href="/quotations/q-1/accept" disabled disabledReason="This quotation has expired">
        Accept quote
      </ButtonLink>,
    );
    expect(screen.queryByRole('link')).toBeNull();
    const button = screen.getByRole('button', { name: 'Accept quote' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', 'This quotation has expired');
  });

  it('routes every internal link in the system through the injected router link', () => {
    const routed: string[] = [];
    function RouterLink({ href, ...rest }: UiLinkProps): React.JSX.Element {
      routed.push(href);
      return <a href={href} data-router="yes" {...rest} />;
    }
    render(
      <LinkProvider component={RouterLink}>
        <AppShell
          productName="JobWork"
          navigation={[{ href: '/orders', label: 'Orders' }]}
          tabs={[{ href: '/', label: 'Home', icon: 'home' }]}
          primaryAction={{ href: '/enquiries/new', label: 'Create enquiry' }}
          notifications={{ href: '/notifications' }}
        >
          <Page title="Orders" back={{ href: '/', label: 'Back to home' }}>
            <RecordCard href="/orders/o-1" reference="SO-1" title="Brackets" />
            <QueueCard label="Quotes" detail="Awaiting you" count={1} href="/quotations" />
            <QuickAction href="/invoices" icon="orders" label="Invoices" />
            <ButtonLink href="/help">Contact JobWork</ButtonLink>
          </Page>
        </AppShell>
      </LinkProvider>,
    );
    expect(new Set(routed)).toEqual(
      new Set(['/', '/orders', '/notifications', '/enquiries/new', '/orders/o-1', '/quotations', '/invoices', '/help']),
    );
    // The skip link is a fragment, not a navigation: it stays a plain anchor.
    const skip = screen.getAllByRole('link', { hidden: true }).find((link) => link.getAttribute('href') === '#main');
    expect(skip).toBeDefined();
    expect(skip).not.toHaveAttribute('data-router');
  });
});
