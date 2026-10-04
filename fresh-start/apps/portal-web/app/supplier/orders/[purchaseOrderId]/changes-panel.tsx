'use client';

import { useCallback, useEffect, useState } from 'react';
import type { SupplierChange } from '@jobwork/contracts';
import { Callout, Card, CommandButton, Inline, Stack, StatusChip, TextArea, TextInput, formatMoney, useCommandTick } from '@jobwork/ui';
import { api } from '../../../../lib/api';

/** "5 Oct 2026" in India time. */
const day = (iso: string): string => new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));

const minor = (value: string): number => Math.round(Number(value || '0') * 100);

/**
 * Engineering changes touching this purchase order, as the supplier sees them (IN-13 F-13.3):
 * JobWork's brief, any stop or continue instruction, the supplier's own cost and lead-time
 * estimate, and the acknowledgment of the new drawing pack and PO amendment.
 */
export function SupplierChangesPanel({ purchaseOrderId }: { purchaseOrderId: string }): React.JSX.Element | null {
  const [changes, setChanges] = useState<SupplierChange[]>([]);
  const [estimate, setEstimate] = useState<Record<string, { cost: string; lead: string; note: string }>>({});
  const [note, setNote] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const all = await api<SupplierChange[]>('/supplier/changes').catch(() => []);
    setChanges(all.filter((c) => c.purchaseOrders.some((p) => p.purchaseOrderId === purchaseOrderId)));
  }, [purchaseOrderId]);

  // Acknowledging a change acknowledges its transmittal too: refresh after any command on the page.
  const tick = useCommandTick();
  useEffect(() => {
    void load();
  }, [load, tick]);

  if (changes.length === 0) return null;

  const post = async (path: string, body: Record<string, unknown>): Promise<void> => {
    await api(path, { method: 'POST', body, idempotencyKey: crypto.randomUUID() });
    await load();
  };

  return (
    <Card title="Engineering changes" description="Changes JobWork is making to what this order is built to. Follow any stop instruction until it is lifted.">
      <Stack gap={4}>
        {changes.map((c) => {
          const mine = c.purchaseOrders.find((p) => p.purchaseOrderId === purchaseOrderId)!;
          const e = estimate[c.changeRequestId] ?? { cost: '0', lead: '0', note: '' };
          const activeStop = mine.interimDecisions.find((d) => d.active && d.decision === 'stop');
          const activeContinue = mine.interimDecisions.find((d) => d.active && d.decision === 'continue');
          return (
            <div key={c.changeRequestId} style={{ borderTop: 'var(--hairline) solid var(--color-border)', paddingTop: 'var(--space-3)' }}>
              <Stack gap={2}>
                <Inline gap={2}>
                  <span className="mono">{c.number}</span>
                  <StatusChip tone={mine.amendment && !mine.amendment.acknowledgedAt ? 'attention' : ['closed', 'verified', 'implemented'].includes(c.status) ? 'positive' : 'progress'}>
                    {mine.amendment ? (mine.amendment.acknowledgedAt ? 'acknowledged' : 'to acknowledge') : c.status.replace(/_/g, ' ')}
                  </StatusChip>
                </Inline>
                <p>{c.brief || 'JobWork will describe this change shortly.'}</p>
                {activeStop ? (
                  <Callout tone="blocked" title={`Stop affected work until ${day(activeStop.expiresAt)}`}>
                    Do not run the affected operations while JobWork decides. Starting a milestone is refused until this is lifted.
                  </Callout>
                ) : activeContinue ? (
                  <Callout tone="neutral" title={`Continue as planned until ${day(activeContinue.expiresAt)}`}>
                    Carry on under the current drawing pack while JobWork decides.
                  </Callout>
                ) : null}
                {c.impactInvited && !mine.impactSubmitted ? (
                  <details>
                    <summary>Send your cost and lead-time estimate</summary>
                    <Stack gap={2}>
                      <Inline gap={2}>
                        <TextInput label="Cost change (₹; negative is a saving)" inputMode="decimal" value={e.cost} onChange={(ev) => setEstimate({ ...estimate, [c.changeRequestId]: { ...e, cost: ev.target.value } })} />
                        <TextInput label="Lead time change (days)" inputMode="numeric" value={e.lead} onChange={(ev) => setEstimate({ ...estimate, [c.changeRequestId]: { ...e, lead: ev.target.value } })} />
                      </Inline>
                      <TextArea label="Work in progress and anything JobWork should know" rows={2} value={e.note} onChange={(ev) => setEstimate({ ...estimate, [c.changeRequestId]: { ...e, note: ev.target.value } })} />
                      <CommandButton
                        variant="secondary"
                        receiptLabel="Sent"
                        onCommand={() => post(`/supplier/changes/${c.changeRequestId}/impact`, { purchaseOrderId, costDeltaMinor: minor(e.cost), leadTimeDeltaDays: Number(e.lead || '0'), note: e.note.trim() })}
                      >
                        Send estimate
                      </CommandButton>
                    </Stack>
                  </details>
                ) : mine.impactSubmitted ? (
                  <p style={{ font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>Your estimate is with JobWork.</p>
                ) : null}
                {mine.amendment ? (
                  <Stack gap={2}>
                    <p>
                      Amendment to {mine.amendment.purchaseOrderNumber}: price {mine.amendment.costDeltaMinor === 0 ? 'unchanged' : `${mine.amendment.costDeltaMinor > 0 ? '+' : '−'}${formatMoney({ amountMinor: Math.abs(mine.amendment.costDeltaMinor), currency: 'INR' })}`}, lead time{' '}
                      {mine.amendment.leadTimeDeltaDays === 0 ? 'unchanged' : `${mine.amendment.leadTimeDeltaDays > 0 ? '+' : ''}${mine.amendment.leadTimeDeltaDays} days`}. A new drawing pack replaces the old one; documents it no longer includes are withdrawn from you.
                    </p>
                    {!mine.amendment.acknowledgedAt && c.status === 'released' ? (
                      <>
                        <TextArea label="Note to JobWork (optional)" rows={2} value={note[c.changeRequestId] ?? ''} onChange={(ev) => setNote({ ...note, [c.changeRequestId]: ev.target.value })} />
                        <CommandButton receiptLabel="Acknowledged" onCommand={() => post(`/supplier/changes/${c.changeRequestId}/acknowledge`, { purchaseOrderId, note: (note[c.changeRequestId] ?? '').trim() })}>
                          Acknowledge the new drawing pack and amendment
                        </CommandButton>
                      </>
                    ) : mine.amendment.acknowledgedAt ? (
                      <p style={{ font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>You acknowledged this on {day(mine.amendment.acknowledgedAt)}.</p>
                    ) : null}
                  </Stack>
                ) : null}
              </Stack>
            </div>
          );
        })}
      </Stack>
    </Card>
  );
}
