'use client';

import { useCallback, useEffect, useState } from 'react';
import type { CustomerChange, MeResponse } from '@jobwork/contracts';
import { Callout, Card, Checkbox, CommandButton, Inline, Stack, StatusChip, TextArea, TextInput, formatMoney, type Tone } from '@jobwork/ui';
import { api } from '../../../lib/api';

const STATUS: Record<CustomerChange['status'], { label: string; tone: Tone }> = {
  proposed: { label: 'received', tone: 'progress' },
  triage: { label: 'being reviewed', tone: 'progress' },
  clarification: { label: 'question for you', tone: 'attention' },
  impact_analysis: { label: 'assessing impact', tone: 'progress' },
  commercial_approval: { label: 'assessing impact', tone: 'progress' },
  approved: { label: 'approved', tone: 'progress' },
  rejected: { label: 'not going ahead', tone: 'neutral' },
  released: { label: 'being made', tone: 'progress' },
  implemented: { label: 'being made', tone: 'progress' },
  verified: { label: 'done', tone: 'positive' },
  closed: { label: 'done', tone: 'positive' },
  withdrawn: { label: 'withdrawn', tone: 'neutral' },
};

/** "5 Oct 2026" in India time. */
const day = (iso: string): string => new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));

const shift = (days: number): string => (days === 0 ? 'no change' : `${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ${days > 0 ? 'later' : 'earlier'}`);

/**
 * Changes on one order, as the customer sees them (IN-13 F-13.3): ask for a change, answer
 * JobWork's question, and approve or reject a change by what it does to the price and the
 * delivery date — never the supplier side (doc 14 §4).
 */
export function ChangesPanel({ orderId, currency, open }: { orderId: string; currency: string; open: boolean }): React.JSX.Element {
  const [changes, setChanges] = useState<CustomerChange[]>([]);
  const [request, setRequest] = useState({ title: '', reason: '', urgent: false });
  const [text, setText] = useState<Record<string, string>>({});
  const [acknowledged, setAcknowledged] = useState<Record<string, boolean>>({});
  const [roles, setRoles] = useState<readonly string[]>([]);

  const load = useCallback(async () => {
    setChanges(await api<CustomerChange[]>(`/orders/${orderId}/changes`).catch(() => []));
  }, [orderId]);

  useEffect(() => {
    void load();
    api<MeResponse>('/auth/me')
      .then((me) => setRoles(me.roles))
      .catch(() => setRoles([]));
  }, [load]);

  const canRequest = open && roles.some((r) => r === 'customer_requester' || r === 'customer_approver' || r === 'org_admin');

  const post = async (path: string, body: Record<string, unknown>): Promise<void> => {
    await api(path, { method: 'POST', body, idempotencyKey: crypto.randomUUID() });
    await load();
  };
  const money = (minor: number): string => formatMoney({ amountMinor: Math.abs(minor), currency });

  return (
    <Card title="Changes" description="Changing the drawings or the scope after you ordered. JobWork assesses each one; you decide when it changes the price or the delivery date.">
      <Stack gap={4}>
        {changes.length === 0 ? <p style={{ color: 'var(--color-text-muted)' }}>No changes requested.</p> : null}
        {changes.map((c) => (
          <div key={c.changeRequestId} style={{ borderTop: 'var(--hairline) solid var(--color-border)', paddingTop: 'var(--space-3)' }}>
            <Stack gap={2}>
              <Inline gap={2}>
                <span className="mono">{c.number}</span>
                <strong>{c.title}</strong>
                <StatusChip tone={c.decisionNeeded ? 'attention' : STATUS[c.status].tone}>{c.decisionNeeded ? 'decision needed' : STATUS[c.status].label}</StatusChip>
              </Inline>
              {c.status === 'clarification' && c.infoRequest ? (
                <>
                  <Callout tone="attention" title="JobWork asks">{c.infoRequest}</Callout>
                  <TextArea label="Your answer" rows={2} value={text[c.changeRequestId] ?? ''} onChange={(e) => setText({ ...text, [c.changeRequestId]: e.target.value })} />
                  <CommandButton
                    size="sm"
                    receiptLabel="Sent"
                    disabled={(text[c.changeRequestId] ?? '').trim().length < 3}
                    disabledReason="Write your answer"
                    onCommand={() => post(`/customer/changes/${c.changeRequestId}/provide-info`, { expectedVersion: c.aggregateVersion, answer: (text[c.changeRequestId] ?? '').trim() })}
                  >
                    Send answer
                  </CommandButton>
                </>
              ) : null}
              {c.priceDeltaMinor !== null && c.deliveryDateDeltaDays !== null ? (
                <p>
                  Price: {c.priceDeltaMinor === 0 ? 'no change' : `${c.priceDeltaMinor > 0 ? '+' : '−'}${money(c.priceDeltaMinor)} (tax included)`} · Delivery: {shift(c.deliveryDateDeltaDays)}
                </p>
              ) : null}
              {c.decisionNeeded ? (
                c.canDecide ? (
                  <>
                    <Checkbox
                      label={`I understand this ${c.priceDeltaMinor && c.priceDeltaMinor > 0 ? `adds ${money(c.priceDeltaMinor)} to the order` : c.priceDeltaMinor && c.priceDeltaMinor < 0 ? `takes ${money(c.priceDeltaMinor)} off the order` : 'does not change the price'} and moves delivery: ${shift(c.deliveryDateDeltaDays ?? 0)}.`}
                      checked={acknowledged[c.changeRequestId] ?? false}
                      onChange={(e) => setAcknowledged({ ...acknowledged, [c.changeRequestId]: e.target.checked })}
                    />
                    <TextArea label="Note to JobWork (needed to reject)" rows={2} value={text[c.changeRequestId] ?? ''} onChange={(e) => setText({ ...text, [c.changeRequestId]: e.target.value })} />
                    <Inline gap={2}>
                      <CommandButton
                        receiptLabel="Approved"
                        disabled={!acknowledged[c.changeRequestId]}
                        disabledReason="Confirm the effect first"
                        onCommand={() => post(`/customer/changes/${c.changeRequestId}/decide`, { expectedVersion: c.aggregateVersion, decision: 'approved', reason: (text[c.changeRequestId] ?? '').trim(), acknowledgeEffect: true })}
                      >
                        Approve change
                      </CommandButton>
                      <CommandButton
                        variant="secondary"
                        receiptLabel="Rejected"
                        disabled={!acknowledged[c.changeRequestId] || (text[c.changeRequestId] ?? '').trim().length < 3}
                        disabledReason="Confirm the effect and say why"
                        onCommand={() => post(`/customer/changes/${c.changeRequestId}/decide`, { expectedVersion: c.aggregateVersion, decision: 'rejected', reason: (text[c.changeRequestId] ?? '').trim(), acknowledgeEffect: true })}
                      >
                        Reject change
                      </CommandButton>
                    </Inline>
                  </>
                ) : (
                  <Callout tone="neutral" title="Someone with authority decides">A colleague with approval authority for this amount approves or rejects it.</Callout>
                )
              ) : null}
              {c.decision ? <p style={{ font: 'var(--text-caption)' }}>You {c.decision.decision} this on {day(c.decision.decidedAt)}{c.decision.reason ? `: ${c.decision.reason}` : ''}.</p> : null}
            </Stack>
          </div>
        ))}
        {canRequest ? (
          <details>
            <summary>Request a change</summary>
            <Stack gap={2}>
              <TextInput label="What should change" value={request.title} onChange={(e) => setRequest({ ...request, title: e.target.value })} />
              <TextArea label="Why, and which drawing or part" rows={3} value={request.reason} onChange={(e) => setRequest({ ...request, reason: e.target.value })} />
              <Checkbox label="Urgent" checked={request.urgent} onChange={(e) => setRequest({ ...request, urgent: e.target.checked })} />
              <p style={{ font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>To send a new drawing revision, upload it to the drawing itself; a change opens on its own.</p>
              <CommandButton
                variant="secondary"
                receiptLabel="Requested"
                disabled={request.title.trim().length < 3 || request.reason.trim().length < 3}
                disabledReason="Say what should change and why"
                onCommand={async () => {
                  await post(`/orders/${orderId}/changes`, { title: request.title.trim(), reason: request.reason.trim(), urgency: request.urgent ? 'urgent' : 'normal' });
                  setRequest({ title: '', reason: '', urgent: false });
                }}
              >
                Request change
              </CommandButton>
            </Stack>
          </details>
        ) : null}
      </Stack>
    </Card>
  );
}
