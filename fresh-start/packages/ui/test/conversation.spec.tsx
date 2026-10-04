import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  CheckMessageResponse,
  ConversationView,
  LeakageFinding,
  PostMessageResponse,
  PostingOption,
} from '@jobwork/contracts';
import { AudienceBanner } from '../src/conversation/AudienceBanner';
import { Composer } from '../src/conversation/Composer';
import { HighlightedText, LeakWarning } from '../src/conversation/LeakWarning';
import { NotificationList } from '../src/conversation/NotificationList';
import { Thread } from '../src/conversation/Thread';

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

// ------------------------------------------------------------------ F-10.2

const staffOptions: PostingOption[] = [
  { audience: 'internal', label: 'JobWork staff only' },
  { audience: 'supplier', label: 'JobWork and Anand Engineering', supplierOrganizationId: 'org-a' },
  { audience: 'shared_technical', label: 'Every invited supplier (no names shown)' },
];

function setup(options: PostingOption[], check: CheckMessageResponse = { action: 'allow', findings: [] }) {
  const onCheck = vi.fn(async () => check);
  const onPost = vi.fn(async (): Promise<PostMessageResponse> => ({ messageId: 'm1', status: check.action === 'quarantine' ? 'held' : 'visible', action: check.action, findings: check.findings }));
  render(<Composer options={options} onCheck={onCheck} onPost={onPost} />);
  return { onCheck, onPost };
}

function type(text: string): void {
  fireEvent.change(screen.getByRole('textbox'), { target: { value: text } });
}

describe('AudienceBanner (F-10.2)', () => {
  it('says who reads the message, in words', () => {
    render(<AudienceBanner audience="customer" label="JobWork and Kovai Pumps" />);
    expect(screen.getByText(/Writing to:/).parentElement).toHaveTextContent('Writing to: JobWork and Kovai Pumps');
  });

  it('marks an internal note unmistakably', () => {
    render(<AudienceBanner audience="internal" label="JobWork staff only" />);
    expect(screen.getByText(/Internal note\./).parentElement).toHaveTextContent('Internal note. Only JobWork staff can read this.');
  });
});

describe('Composer (F-10.2)', () => {
  it('starts on the outward audience and reaches an internal note only through its button', () => {
    setup(staffOptions);
    expect(screen.getByText(/Writing to:/).parentElement).toHaveTextContent('JobWork and Anand Engineering');
    const box = screen.getByRole('textbox');
    // No shortcut switches mode, whatever modifiers are held.
    for (const key of ['i', 'n', 'Enter', 'Tab']) {
      for (const mods of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { shiftKey: true }]) fireEvent.keyDown(box, { key, ...mods });
    }
    expect(screen.queryByText(/Internal note\./)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Write an internal note instead' }));
    expect(screen.getByText(/Internal note\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back to the message' }));
    expect(screen.queryByText(/Internal note\./)).toBeNull();
  });

  it('checks outward text, then sends it to the chosen supplier', async () => {
    const { onCheck, onPost } = setup(staffOptions);
    type('Only on the drive end.');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(onPost).toHaveBeenCalledTimes(1));
    expect(onCheck).toHaveBeenCalledWith({ audience: 'supplier', supplierOrganizationId: 'org-a', body: 'Only on the drive end.' });
    expect(onPost).toHaveBeenCalledWith({ audience: 'supplier', supplierOrganizationId: 'org-a', body: 'Only on the drive end.' });

    fireEvent.click(screen.getByRole('radio', { name: 'Every invited supplier (no names shown)' }));
    type('Ra 1.6 is fine.');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(onPost).toHaveBeenCalledTimes(2));
    expect(onPost).toHaveBeenLastCalledWith({ audience: 'shared_technical', body: 'Ra 1.6 is fine.' });
  });

  it('shows what would be held and sends nothing until the author chooses review', async () => {
    const finding = { kind: 'party_identity' as const, confidence: 'high' as const, start: 0, end: 17, text: 'Anand Engineering', label: 'Names a supplier' };
    const { onPost } = setup(staffOptions, { action: 'quarantine', findings: [finding] });
    type('Anand Engineering will start Monday.');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('This message will be held for review');
    expect(onPost).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Edit message' }));
    expect(screen.getByRole('textbox')).toHaveValue('Anand Engineering will start Monday.');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Send for review' }));
    await screen.findByText(/Held for review\. A JobWork reviewer decides/);
    expect(onPost).toHaveBeenCalledTimes(1);
  });

  it('saves an internal note without a leakage check', async () => {
    const { onCheck, onPost } = setup([{ audience: 'internal', label: 'JobWork staff only' }]);
    type('Supplier A is usually late.');
    fireEvent.click(screen.getByRole('button', { name: 'Save internal note' }));
    await waitFor(() => expect(onPost).toHaveBeenCalledWith({ audience: 'internal', body: 'Supplier A is usually late.' }));
    expect(onCheck).not.toHaveBeenCalled();
  });

  it('says a closed conversation is closed', () => {
    setup([]);
    expect(screen.getByText('This conversation is closed. You can still read it.')).toBeInTheDocument();
  });
});

describe('Thread (F-10.2)', () => {
  const external: ConversationView = {
    viewer: 'external',
    context: { type: 'enquiry', id: 'e1', label: 'ENQ-2026-0001' },
    canPost: [],
    messages: [
      { messageId: 'a', audience: 'customer', authorLabel: 'JobWork', mine: false, body: 'Which colour?', postedAt: '2026-10-04T05:00:00Z', status: 'visible' },
      { messageId: 'b', audience: 'customer', authorLabel: 'Priya', mine: true, body: 'Natural.', postedAt: '2026-10-04T05:05:00Z', status: 'held' },
    ],
  };

  it('shows an outside reader JobWork, themselves, and nothing about audiences', () => {
    render(<Thread view={external} />);
    const items = screen.getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('JobWork');
    expect(items[1]).toHaveTextContent('You');
    expect(items[1]).toHaveTextContent('Waiting for JobWork');
    expect(screen.queryByText('Internal note')).toBeNull();
  });

  it('labels every audience for JobWork and offers sharing only where allowed', () => {
    const onShare = vi.fn();
    render(
      <Thread
        onShare={onShare}
        view={{
          viewer: 'internal',
          context: { type: 'rfq', id: 'r1', label: 'RFQ-2026-0001-R1' },
          canPost: [],
          messages: [
            { messageId: 'n', audience: 'internal', authorName: 'Ravi', authorParty: 'internal', authorOrganizationName: 'JobWork', counterpartOrganizationId: null, counterpartName: null, body: 'Note', postedAt: '2026-10-04T05:00:00Z', status: 'visible', derivedFromMessageId: null, derivation: null, review: null, shareable: false },
            { messageId: 'q', audience: 'supplier', authorName: 'Kumar', authorParty: 'supplier', authorOrganizationName: 'Anand Engineering', counterpartOrganizationId: 'org-a', counterpartName: 'Anand Engineering', body: 'Ra 1.6?', postedAt: '2026-10-04T05:01:00Z', status: 'visible', derivedFromMessageId: null, derivation: null, review: null, shareable: true },
          ],
        }}
      />,
    );
    const items = screen.getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Internal note');
    expect(items[1]).toHaveTextContent('Supplier: Anand Engineering');
    expect(screen.getAllByRole('button', { name: 'Answer for every supplier…' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Answer for every supplier…' }));
    expect(onShare).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'q' }));
  });
});

describe('NotificationList (F-10.3)', () => {
  const items = [
    { notificationId: 'n1', title: 'Your quotation QUO-2026-0001 is ready', body: 'Valid until 31 Oct 2026.', link: '/quotations/q1', createdAt: '2026-10-04T05:00:00Z', readAt: null },
    { notificationId: 'n2', title: 'Invoice INV-2026-0001 issued', body: 'Due 15 Nov 2026.', link: '/invoices/i1', createdAt: '2026-10-03T05:00:00Z', readAt: '2026-10-03T06:00:00Z' },
  ];

  it('links each update to its record and says which are unread, in words', () => {
    const onOpen = vi.fn();
    render(<NotificationList notifications={items} onOpen={onOpen} />);
    const unread = screen.getByRole('link', { name: /Unread: Your quotation QUO-2026-0001 is ready/ });
    expect(unread).toHaveAttribute('href', '/quotations/q1');
    expect(screen.getByRole('link', { name: /^Invoice INV-2026-0001 issued/ })).toHaveAttribute('href', '/invoices/i1');
    fireEvent.click(unread);
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ notificationId: 'n1' }));
  });

  it('says when there is nothing yet', () => {
    render(<NotificationList notifications={[]} />);
    expect(screen.getByText('No updates yet')).toBeInTheDocument();
  });
});
