'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { Ncr } from '@jobwork/contracts';
import { Callout, Card, CommandButton, DescriptionList, ErrorState, LoadingState, Page, Stack, StatusChip, TextArea, TextInput, type Tone } from '@jobwork/ui';
import { api, ApiError } from '../../../../lib/api';
import { STAGE } from '../../inspection-labels';

const STATUS: Record<Ncr['status'], { label: string; tone: Tone }> = {
  open: { label: 'contain the parts', tone: 'blocked' },
  containment: { label: 'contained', tone: 'attention' },
  disposition_pending: { label: 'JobWork deciding', tone: 'progress' },
  rework: { label: 'rework approved', tone: 'attention' },
  reinspection: { label: 'reinspection', tone: 'progress' },
  deviation_pending: { label: 'JobWork deciding', tone: 'progress' },
  accepted_under_deviation: { label: 'accepted as is', tone: 'special' },
  rejected: { label: 'rejected', tone: 'neutral' },
  verified: { label: 'rework verified', tone: 'positive' },
  closed: { label: 'closed', tone: 'positive' },
};
const day = (iso: string): string => new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));

/**
 * A supplier's NCR (IN-15 F-15.5; UC-19): contain the parts, carry out the rework JobWork
 * approved and record it, and answer the corrective action with the real causes. JobWork
 * decides dispositions and closes; the supplier never releases its own output (BR-QLT-03).
 */
export default function SupplierNcrPage(): React.JSX.Element {
  const ncrId = useParams<{ ncrId: string }>().ncrId;
  const [ncr, setNcr] = useState<Ncr | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [contain, setContain] = useState({ action: '', location: '' });
  const [rework, setRework] = useState('');
  const [ca, setCa] = useState({ problem: '', occurrence: '', escape: '', actions: [{ action: '', owner: '', dueDate: '' }] });

  const load = useCallback(async () => {
    try {
      setNcr(await api<Ncr>(`/supplier/ncrs/${ncrId}`));
      setError(null);
    } catch (err) {
      if (err instanceof ApiError) setError(err);
    }
  }, [ncrId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!ncr) {
    return (
      <Page title="NCR" breadcrumb={<Link href="/supplier/quality">← Quality</Link>}>
        {error ? <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} /> : <Card><LoadingState label="Loading the NCR" /></Card>}
      </Page>
    );
  }

  const n = ncr;
  const post = async (path: string, body: Record<string, unknown>): Promise<void> => {
    setNcr(await api<Ncr>(`/supplier/ncrs/${n.ncrId}${path}`, { method: 'POST', body, idempotencyKey: crypto.randomUUID() }));
  };
  const latest = n.dispositions.at(-1);
  const action = n.correctiveAction;

  return (
    <Page title={`${n.number} — ${n.title}`} breadcrumb={<Link href={`/supplier/orders/${n.purchaseOrderId}`}>← {n.purchaseOrderNumber}</Link>} meta={<StatusChip tone={STATUS[n.status].tone}>{STATUS[n.status].label}</StatusChip>}>
      <Stack gap={4}>
        <Card>
          <DescriptionList
            columns={2}
            items={[
              { label: 'Parts affected', value: `${Number(n.affectedQuantity)}${n.lots.length ? ` · lots ${n.lots.join(', ')}` : ''}` },
              { label: 'Found at', value: `${n.inspectionNumber} (${STAGE[n.stage as keyof typeof STAGE] ?? n.stage})` },
              { label: 'What', value: n.description },
              { label: 'Respond by', value: day(n.dueAt) },
            ]}
          />
          <ul style={{ marginTop: 'var(--space-2)' }}>
            {n.defects.map((d) => (
              <li key={d.resultId}>
                {d.characteristicName}, piece {d.sampleNo}: <span className="numeric">{d.original.value} {d.original.unit ?? ''}</span> — {d.outcomeReason}
              </li>
            ))}
          </ul>
        </Card>

        <Card title="Containment" description="Keep the affected parts apart until JobWork decides. Record each step.">
          <Stack gap={2}>
            {n.containment.map((c, i) => (
              <p key={i}>
                {day(c.recordedAt)} · {c.by === 'jobwork' ? 'JobWork' : 'You'}: {c.action}
                {c.location ? ` · ${c.location}` : ''}
              </p>
            ))}
            {n.status !== 'closed' ? (
              <>
                <TextInput label="What you did" value={contain.action} onChange={(e) => setContain({ ...contain, action: e.target.value })} />
                <TextInput label="Where the parts are" value={contain.location} onChange={(e) => setContain({ ...contain, location: e.target.value })} />
                <CommandButton size="sm" receiptLabel="Recorded" disabled={contain.action.trim().length < 3} disabledReason="Say what you did" onCommand={async () => { await post('/containment', { action: contain.action.trim(), location: contain.location.trim() }); setContain({ action: '', location: '' }); }}>
                  Record containment
                </CommandButton>
              </>
            ) : null}
          </Stack>
        </Card>

        {latest && latest.disposition !== 'use_as_is' ? (
          <Card title={`Attempt ${latest.attemptNo}: ${latest.disposition}`}>
            <Stack gap={2}>
              <p>{latest.plan}</p>
              {n.status === 'rework' && !latest.reworkRecordedAt ? (
                <>
                  <TextArea label="What you did, and when" rows={2} value={rework} onChange={(e) => setRework(e.target.value)} />
                  <CommandButton receiptLabel="Recorded" disabled={rework.trim().length < 3} disabledReason="Describe the rework" onCommand={() => post('/rework', { expectedVersion: n.aggregateVersion, note: rework.trim() })}>
                    Rework done
                  </CommandButton>
                </>
              ) : null}
              {latest.reworkRecordedAt ? <p style={{ font: 'var(--text-caption)' }}>You recorded: {latest.reworkNote}</p> : null}
              {latest.reinspection ? (
                <p>
                  Reinspection <Link href={`/supplier/inspections/${latest.reinspection.inspectionId}`}>{latest.reinspection.number}</Link> — {latest.reinspection.status.replace(/_/g, ' ')}
                </p>
              ) : null}
            </Stack>
          </Card>
        ) : null}
        {n.status === 'accepted_under_deviation' ? <Callout tone="neutral" title="Accepted as they are">JobWork accepted the affected parts under a deviation, for the stated quantity and period. Ship only what it names.</Callout> : null}

        {action ? (
          <Card title="Corrective action" description={`Due ${day(action.dueAt)}. Name what made it happen and what let it get through, not who.`}>
            {action.status === 'requested' ? (
              <Stack gap={2}>
                {action.reviewNote ? <Callout tone="attention" title="JobWork asked for more">{action.reviewNote}</Callout> : null}
                <TextArea label="The problem" rows={2} value={ca.problem} onChange={(e) => setCa({ ...ca, problem: e.target.value })} />
                <TextArea label="Why it happened" rows={2} value={ca.occurrence} onChange={(e) => setCa({ ...ca, occurrence: e.target.value })} />
                <TextArea label="Why it was not caught" rows={2} value={ca.escape} onChange={(e) => setCa({ ...ca, escape: e.target.value })} />
                {ca.actions.map((a, i) => (
                  <Stack key={i} gap={1}>
                    <TextInput label={`Action ${i + 1}`} value={a.action} onChange={(e) => setCa({ ...ca, actions: ca.actions.map((x, j) => (j === i ? { ...x, action: e.target.value } : x)) })} />
                    <TextInput label="Owner" value={a.owner} onChange={(e) => setCa({ ...ca, actions: ca.actions.map((x, j) => (j === i ? { ...x, owner: e.target.value } : x)) })} />
                    <TextInput label="By" type="date" value={a.dueDate} onChange={(e) => setCa({ ...ca, actions: ca.actions.map((x, j) => (j === i ? { ...x, dueDate: e.target.value } : x)) })} />
                  </Stack>
                ))}
                <CommandButton size="sm" variant="secondary" receiptLabel="Added" onCommand={async () => setCa({ ...ca, actions: [...ca.actions, { action: '', owner: '', dueDate: '' }] })}>
                  Add an action
                </CommandButton>
                <CommandButton
                  receiptLabel="Sent"
                  disabled={[ca.problem, ca.occurrence, ca.escape].some((x) => x.trim().length < 3) || ca.actions.some((a) => a.action.trim().length < 3 || a.owner.trim().length < 2 || !a.dueDate)}
                  disabledReason="Answer each part and give every action an owner and a date"
                  onCommand={() => post('/corrective-action', { expectedVersion: action.aggregateVersion, problemDefinition: ca.problem.trim(), occurrenceCause: ca.occurrence.trim(), escapeCause: ca.escape.trim(), actions: ca.actions.map((a) => ({ action: a.action.trim(), owner: a.owner.trim(), dueDate: a.dueDate })) })}
                >
                  Send corrective action
                </CommandButton>
              </Stack>
            ) : (
              <DescriptionList
                items={[
                  { label: 'Status', value: action.status },
                  { label: 'Why it happened', value: action.occurrenceCause ?? '' },
                  { label: 'Why it was not caught', value: action.escapeCause ?? '' },
                  { label: 'Actions', value: <ul>{action.actions.map((a, i) => <li key={i}>{a.action} — {a.owner}, by {a.dueDate}</li>)}</ul> },
                ]}
              />
            )}
          </Card>
        ) : null}
      </Stack>
    </Page>
  );
}
