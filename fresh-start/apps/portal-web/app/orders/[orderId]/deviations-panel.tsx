'use client';

import { useCallback, useEffect, useState } from 'react';
import type { CustomerDeviation } from '@jobwork/contracts';
import { Callout, Card, Checkbox, CommandButton, DescriptionList, Inline, Stack, StatusChip, TextArea } from '@jobwork/ui';
import { api } from '../../../lib/api';

const day = (iso: string): string => new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));

/**
 * Quality decisions on this order (IN-15 F-15.5; UC-06; doc 14 §4): parts that miss one of the
 * customer's requirements, which JobWork proposes to deliver as they are within an exact scope
 * and period. The customer's approver decides with the requirement, the actual values and the
 * effects in front of them; nothing is accepted without that recorded decision.
 */
export function DeviationsPanel({ orderId }: { orderId: string }): React.JSX.Element | null {
  const [rows, setRows] = useState<CustomerDeviation[]>([]);
  const [ack, setAck] = useState<Record<string, boolean>>({});
  const [reason, setReason] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setRows(await api<CustomerDeviation[]>(`/orders/${orderId}/deviations`).catch(() => []));
  }, [orderId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (rows.length === 0) return null;
  const decide = async (d: CustomerDeviation, decision: 'approved' | 'rejected'): Promise<void> => {
    await api(`/customer/deviations/${d.deviationId}/decide`, { method: 'POST', body: { expectedVersion: d.aggregateVersion, decision, reason: (reason[d.deviationId] ?? '').trim(), acknowledgeScope: true }, idempotencyKey: crypto.randomUUID() });
    await load();
  };

  return (
    <Card title="Quality decisions" description="Parts that miss a requirement, proposed for delivery as they are within a stated quantity and period.">
      <Stack gap={4}>
        {rows.map((d) => (
          <div key={d.deviationId} style={{ borderTop: 'var(--hairline) solid var(--color-border)', paddingTop: 'var(--space-3)' }}>
            <Stack gap={2}>
              <Inline gap={2}>
                <span className="mono">{d.number}</span>
                <StatusChip tone={d.decisionNeeded ? 'attention' : d.status === 'approved' ? 'special' : 'neutral'}>{d.decisionNeeded ? 'decision needed' : d.status === 'approved' ? 'accepted as is' : d.status}</StatusChip>
              </Inline>
              {d.requirements.map((r) => (
                <p key={r.name}>
                  <strong>{r.name}</strong>
                  {r.drawingReference ? ` (balloon ${r.drawingReference})` : ''}: required {r.limits}; measured{' '}
                  <span className="numeric">{r.actual.map((a) => `${a.value} ${a.unit ?? ''}`.trim()).join(', ')}</span>
                </p>
              ))}
              <DescriptionList
                columns={2}
                items={[
                  { label: 'Parts', value: `${Number(d.quantity)}${d.lots.length ? ` · lots ${d.lots.join(', ')}` : ''}` },
                  { label: 'Valid until', value: day(d.expiresAt) },
                  { label: 'Why they can be used', value: d.rationale },
                  { label: 'Fit, function, safety', value: d.fitFunctionSafety },
                  ...(d.effects.price ? [{ label: 'Price', value: d.effects.price }] : []),
                  ...(d.effects.warranty ? [{ label: 'Warranty', value: d.effects.warranty }] : []),
                  ...(d.effects.labeling ? [{ label: 'Labelling', value: d.effects.labeling }] : []),
                  ...(d.effects.traceability ? [{ label: 'Traceability', value: d.effects.traceability }] : []),
                ]}
              />
              {d.decisionNeeded ? (
                d.canDecide ? (
                  <>
                    <Checkbox
                      label={`I accept ${Number(d.quantity)} parts${d.lots.length ? ` in ${d.lots.join(', ')}` : ''} as they are, until ${day(d.expiresAt)}, with the effects above.`}
                      checked={ack[d.deviationId] ?? false}
                      onChange={(e) => setAck({ ...ack, [d.deviationId]: e.target.checked })}
                    />
                    <TextArea label="Note to JobWork (needed to reject)" rows={2} value={reason[d.deviationId] ?? ''} onChange={(e) => setReason({ ...reason, [d.deviationId]: e.target.value })} />
                    <Inline gap={2}>
                      <CommandButton receiptLabel="Accepted" disabled={!ack[d.deviationId]} disabledReason="Confirm the scope first" onCommand={() => decide(d, 'approved')}>
                        Accept as is
                      </CommandButton>
                      <CommandButton variant="secondary" receiptLabel="Rejected" disabled={!ack[d.deviationId] || (reason[d.deviationId] ?? '').trim().length < 3} disabledReason="Confirm the scope and say why" onCommand={() => decide(d, 'rejected')}>
                        Reject
                      </CommandButton>
                    </Inline>
                  </>
                ) : (
                  <Callout tone="neutral" title="Your approver decides">A colleague with approval authority accepts or rejects it.</Callout>
                )
              ) : null}
              {d.decision ? <p style={{ font: 'var(--text-caption)' }}>Decided {day(d.decision.decidedAt)}: {d.decision.decision}{d.decision.reason ? ` — ${d.decision.reason}` : ''}</p> : null}
            </Stack>
          </div>
        ))}
      </Stack>
    </Card>
  );
}
