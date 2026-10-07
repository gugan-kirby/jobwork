'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import type { CustomerCase } from '@jobwork/contracts';
import {
  Callout,
  Card,
  CommandButton,
  DescriptionList,
  ErrorState,
  Inline,
  LoadingState,
  Page,
  Stack,
  StatusChip,
  TextArea,
  TextInput,
  formatMoney,
} from '@jobwork/ui';
import { api, ApiError } from '../../../lib/api';
import { CASE_KIND, CASE_TONE, REMEDY } from '../labels';

/**
 * One case (customer; IN-18 F-18.4). The customer's own words and JobWork's replies, the agreed
 * remedies once JobWork has approved them, and — while JobWork has not started — a way to withdraw.
 */
export default function CustomerCasePage(): React.JSX.Element {
  const caseId = useParams<{ caseId: string }>().caseId;
  const [c, setCase] = useState<CustomerCase | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<ApiError | null>(null);
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    try {
      setCase(await api<CustomerCase>(`/support/cases/${caseId}`));
      setError(null);
    } catch (err) {
      if (err instanceof ApiError) setError(err);
    }
  }, [caseId]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (path: string, body: Record<string, unknown>): Promise<void> => {
    setNotice(null);
    try {
      await api(path, { method: 'POST', body, idempotencyKey: `${path}-${JSON.stringify(body)}` });
      await load();
    } catch (err) {
      if (err instanceof ApiError) setNotice(err);
      throw err;
    }
  };

  if (error) return <Page title="Case" back={{ href: '/support', label: 'Support' }}><ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} /></Page>;
  if (!c) return <Page title="Case" back={{ href: '/support', label: 'Support' }}><Card><LoadingState label="Loading your case" /></Card></Page>;
  const closed = ['closed', 'rejected', 'withdrawn'].includes(c.status);

  return (
    <Page title={c.title} back={{ href: '/support', label: 'Support' }} description={`${c.number} · ${CASE_KIND[c.kind]} on ${c.orderNumber}`}>
      <Stack gap={4}>
        {notice ? <Callout tone="blocked" assertive title={notice.problem.title}>{notice.problem.detail ?? ''}</Callout> : null}
        <Card>
          <Stack gap={2}>
            <Inline gap={2}>
              <StatusChip tone={CASE_TONE[c.status]}>{c.statusLabel}</StatusChip>
              {c.closedAt ? <span>on {c.closedAt.slice(0, 10)}</span> : null}
            </Inline>
            <DescriptionList items={[{ label: 'Order', value: c.orderNumber, mono: true }, { label: 'Delivery', value: c.shipmentNumber || '—', mono: true }, { label: 'What you reported', value: c.description }]} />
          </Stack>
        </Card>

        {c.remedies.length > 0 ? (
          <Card title="How JobWork is putting it right">
            <Stack gap={2}>
              {c.remedies.map((r, i) => (
                <Inline key={i} gap={2}>
                  <strong>{REMEDY[r.kind]}</strong>
                  <span>{r.description}</span>
                  {r.amountMinor ? <span className="numeric">{formatMoney({ amountMinor: r.amountMinor, currency: 'INR' })}</span> : null}
                  <StatusChip tone={r.status === 'planned' ? 'attention' : 'positive'}>{r.status === 'planned' ? 'To do' : 'Done'}</StatusChip>
                </Inline>
              ))}
            </Stack>
          </Card>
        ) : null}

        <Card title="Conversation">
          <Stack gap={2}>
            {c.events.map((e, i) => (
              <div key={i}>
                <Inline gap={2}>
                  <strong>{e.authorParty === 'customer' ? 'You' : 'JobWork'}</strong>
                  <span style={{ color: 'var(--color-text-muted)' }}>{e.createdAt.slice(0, 16).replace('T', ' ')}</span>
                </Inline>
                {e.note ? <p>{e.note}</p> : null}
              </div>
            ))}
            {closed ? null : (
              <Stack gap={2}>
                <TextArea label="Add information" value={note} onChange={(e) => setNote(e.target.value)} />
                <div>
                  <CommandButton
                    receiptLabel="Sent"
                    disabled={note.trim().length === 0}
                    disabledReason="Write something first"
                    onCommand={async () => {
                      await act(`/support/cases/${c.caseId}/events`, { note });
                      setNote('');
                    }}
                  >
                    Send
                  </CommandButton>
                </div>
              </Stack>
            )}
          </Stack>
        </Card>

        {c.canWithdraw ? (
          <Card title="Withdraw this case" description="If it is no longer needed. JobWork has not started on it yet.">
            <Inline gap={2}>
              <TextInput label="Why" value={reason} onChange={(e) => setReason(e.target.value)} />
              <CommandButton variant="secondary" receiptLabel="Withdrawn" disabled={reason.trim().length < 3} disabledReason="Say why" onCommand={() => act(`/support/cases/${c.caseId}/withdraw`, { expectedVersion: c.aggregateVersion, reason })}>
                Withdraw
              </CommandButton>
            </Inline>
          </Card>
        ) : null}
      </Stack>
    </Page>
  );
}
