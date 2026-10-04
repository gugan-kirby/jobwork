import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { LeakageFinding } from '@jobwork/contracts';
import { HighlightedText, LeakWarning } from '../src/conversation/LeakWarning';

const body = 'Call Anand on 98765 43210 about part no 9123456780.';
const findings: LeakageFinding[] = [
  { kind: 'phone', confidence: 'high', start: 14, end: 25, text: '98765 43210', label: 'Phone number' },
  { kind: 'engineering_number', confidence: 'low', start: 40, end: 50, text: '9123456780', label: 'Number shaped like a phone number (may be a part or drawing number)' },
];

describe('HighlightedText (F-10.4)', () => {
  it('marks exactly the flagged spans and keeps the rest as plain text', () => {
    const { container } = render(<HighlightedText text={body} spans={findings} />);
    const marks = [...container.querySelectorAll('mark')].map((m) => m.textContent);
    expect(marks).toEqual(['98765 43210', '9123456780']);
    expect(container.textContent).toBe(body);
  });

  it('renders markup in a message as text, never as HTML', () => {
    const hostile = '<img src=x onerror=alert(1)> call 98765 43210';
    const { container } = render(<HighlightedText text={hostile} spans={[{ start: 34, end: 45, label: 'Phone number' }]} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toBe(hostile);
  });
});

describe('LeakWarning (F-10.4)', () => {
  it('explains a hold, lists each finding, and offers edit or review', () => {
    const onEdit = vi.fn();
    const onProceed = vi.fn();
    render(<LeakWarning action="quarantine" findings={findings} body={body} onEdit={onEdit} onProceed={onProceed} />);
    expect(screen.getByRole('alert')).toHaveTextContent('This message will be held for review');
    expect(screen.getByRole('alert')).toHaveTextContent('Phone number: 98765 43210');
    fireEvent.click(screen.getByRole('button', { name: 'Send for review' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit message' }));
    expect(onProceed).toHaveBeenCalledTimes(1);
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it('lets a warning be sent anyway', () => {
    const onProceed = vi.fn();
    render(<LeakWarning action="warn" findings={findings.slice(1)} body={body} onEdit={() => undefined} onProceed={onProceed} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Check this message before sending');
    fireEvent.click(screen.getByRole('button', { name: 'Send anyway' }));
    expect(onProceed).toHaveBeenCalledTimes(1);
  });
});
