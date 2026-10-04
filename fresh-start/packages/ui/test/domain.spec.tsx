import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { STATUS_TONES } from '../src/tokens';
import { StatusChip } from '../src/status/StatusChip';
import { ActionNeededCard } from '../src/status/ActionNeededCard';
import { QueueCard, describeAge } from '../src/status/QueueCard';
import { MoneyInput, formatMoney } from '../src/forms/MoneyInput';
import { MeasurementInput } from '../src/forms/MeasurementInput';

describe('StatusChip (DS-04, DS-07)', () => {
  it.each([...STATUS_TONES])('%s pairs its colour with a mark and a spoken meaning', (tone) => {
    render(<StatusChip tone={tone}>Some state</StatusChip>);
    const chip = screen.getByText('Some state').parentElement!;
    // Colour is never the only carrier: there is a glyph beside the label...
    expect(chip.querySelector('[aria-hidden]')?.textContent?.trim()).toBeTruthy();
    // ...and the tone is spelled out for anyone who cannot see either.
    expect(chip.textContent).toMatch(/—/);
  });

  it('does not dress a deviation-accepted result as a clean pass (DS-04)', () => {
    render(<StatusChip tone="special">Accepted under deviation</StatusChip>);
    const chip = screen.getByText('Accepted under deviation').parentElement!;
    expect(chip.textContent).toContain('passed with a deviation');
    expect(chip.textContent).not.toMatch(/— passed$/);
  });
});

describe('ActionNeededCard (doc 21 §6)', () => {
  it('states owner and due time, and shows a blocking reason when there is one', () => {
    render(
      <ActionNeededCard
        title="Answer structured questions"
        detail="Two questions need answers before sourcing can start."
        owner="Your team"
        due="12 Sep 2026, 17:00 IST"
        blockedReason="A drawing is still being scanned"
      />,
    );
    expect(screen.getByText(/Owner: Your team/)).toBeInTheDocument();
    // A deadline without a timezone is a dispute waiting to happen (doc 21 §10).
    expect(screen.getByText(/Due 12 Sep 2026, 17:00 IST/)).toBeInTheDocument();
    expect(screen.getByText(/Blocked: A drawing is still being scanned/)).toBeInTheDocument();
  });
});

describe('MoneyInput (BR-FIN-01, doc 21 §7)', () => {
  it('formats INR with lakh/crore grouping while the wire value stays minor units', () => {
    expect(formatMoney({ amountMinor: 123456700, currency: 'INR' })).toBe('₹12,34,567.00');
    expect(formatMoney({ amountMinor: 50, currency: 'INR' })).toBe('₹0.50');
    expect(formatMoney({ amountMinor: -50, currency: 'INR' })).toBe('-₹0.50');
  });

  it('emits integer minor units, never a float of rupees', () => {
    const onChange = vi.fn();
    render(<MoneyInput label="Target price" value={null} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Target price'), { target: { value: '1234.50' } });
    // ₹1,234.50 leaves as 123450 minor units — the decimal point is resolved once,
    // here, and never travels as a float.
    expect(onChange).toHaveBeenCalledWith({ amountMinor: 123450, currency: 'INR' });
  });
});

describe('MeasurementInput (doc 09 §10)', () => {
  it('relabels the unit without rescaling the number', () => {
    const onChange = vi.fn();
    render(
      <MeasurementInput
        label="Tightest tolerance"
        value={{ value: 0.05, unit: 'mm' }}
        onChange={onChange}
      />,
    );

    fireEvent.change(screen.getByLabelText('Tightest tolerance unit'), {
      target: { value: 'inch' },
    });

    // 0.05 mm becoming 0.05 inch is the caller's problem to notice; 0.05 silently
    // becoming 0.00197 is the failure this asserts against.
    expect(onChange).toHaveBeenCalledWith({ value: 0.05, unit: 'inch' });
  });
});

describe('QueueCard (F-OPS.3)', () => {
  it('states the size of the queue and the age of its oldest item', () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString();
    render(
      <QueueCard
        label="Evidence awaiting review"
        detail="GST, PAN and bank documents."
        count={4}
        oldestWaitingSince={threeDaysAgo}
        href="/suppliers/verification"
      />,
    );
    const link = screen.getByRole('link', { name: /Evidence awaiting review/ });
    expect(link).toHaveAttribute('href', '/suppliers/verification');
    expect(link.textContent).toContain('4');
    expect(link.textContent).toContain('oldest waiting 3 days');
  });

  it('says nothing about age when there is no date to age against', () => {
    render(<QueueCard label="Sent back to you" detail="A reviewer replied." count={2} href="/x" />);
    // "waiting" beside a queue with no date is filler; the count already said it.
    expect(screen.getByRole('link').textContent).not.toContain('waiting');
  });

  it('says an empty queue is empty rather than rendering nothing', () => {
    render(<QueueCard label="Nothing here" detail="All clear." count={0} href="/intake" />);
    expect(screen.getByRole('link').textContent).toContain('Nothing waiting.');
  });

  it('measures age in whole days, hours, or "within the hour"', () => {
    const now = new Date('2026-09-06T12:00:00Z');
    expect(describeAge('2026-09-04T12:00:00Z', now)).toMatchObject({ days: 2 });
    expect(describeAge('2026-09-06T09:00:00Z', now).text).toBe('oldest waiting 3 hours');
    expect(describeAge('2026-09-06T11:40:00Z', now).text).toBe('all arrived within the hour');
  });
});
