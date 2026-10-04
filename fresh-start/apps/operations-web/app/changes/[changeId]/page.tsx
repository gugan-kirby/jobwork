'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { ChangeRequest, ProductionView } from '@jobwork/contracts';
import {
  ButtonLink,
  Callout,
  Card,
  Checkbox,
  CommandButton,
  DataTable,
  DescriptionList,
  ErrorState,
  Inline,
  LoadingState,
  Page,
  ReasonField,
  Select,
  SplitPane,
  Stack,
  StatusChip,
  TextArea,
  TextInput,
  formatDue,
  formatMoney,
  type Column,
} from '@jobwork/ui';
import { api, ApiError } from '../../../lib/api';
import { CHANGE_TONE, ORIGIN } from '../labels';
import { ImpactEditor } from './impact-editor';

const OPEN = ['proposed', 'triage', 'clarification', 'impact_analysis', 'commercial_approval', 'approved'];

const shift = (days: number): string => (days === 0 ? 'no change' : `${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ${days > 0 ? 'later' : 'earlier'}`);

/**
 * One engineering change (IN-13; doc 06 §9): the step it is at and the action that moves
 * it, the interim stop/continue decisions in force, the impact, the baseline it will
 * release against the one in force, and the amendments the suppliers acknowledge.
 */
export default function ChangePage(): React.JSX.Element {
  const changeId = useParams<{ changeId: string }>().changeId;
  const [change, setChange] = useState<ChangeRequest | null>(null);
  const [production, setProduction] = useState<ProductionView | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [text, setText] = useState('');
  const [brief, setBrief] = useState('');
  const [classification, setClassification] = useState('scope');
  const [interim, setInterim] = useState<{ pos: string[]; decision: 'stop' | 'continue'; reason: string; until: string }>({ pos: [], decision: 'stop', reason: '', until: '' });

  const load = useCallback(async () => {
    try {
      const c = await api<ChangeRequest>(`/changes/${changeId}`);
      setChange(c);
      setProduction(await api<ProductionView>(`/sales-orders/${c.salesOrderId}/production`));
      setError(null);
    } catch (err) {
      if (err instanceof ApiError) setError(err);
    }
  }, [changeId]);

  useEffect(() => {
    void load();
  }, [load]);

  const post = useCallback(
    async (path: string, body: Record<string, unknown> = {}): Promise<void> => {
      await api(`/changes/${changeId}${path}`, { method: 'POST', body, idempotencyKey: crypto.randomUUID() });
      setText('');
      await load();
    },
    [changeId, load],
  );

  if (!change || !production) {
    return (
      <Page title="Change" breadcrumb={<Link href="/changes">← Changes</Link>}>
        {error ? <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} /> : <Card><LoadingState label="Loading the change" /></Card>}
      </Page>
    );
  }

  const v = { expectedVersion: change.aggregateVersion };
  const money = (minor: number): string => formatMoney({ amountMinor: minor, currency: 'INR' });
  const candidate = production.baselines.find((b) => b.baselineId === (change.releasedBaselineId ?? change.candidateBaselineId));
  // Before release, compare against what governs now; after it, against what the change replaced.
  const inForce = change.releasedBaselineId
    ? production.baselines
        .filter((b) => b.baselineId !== change.releasedBaselineId && b.releasedAt !== null && candidate?.releasedAt != null && b.releasedAt < candidate.releasedAt)
        .sort((a, b) => (b.releasedAt ?? '').localeCompare(a.releasedAt ?? ''))[0]
    : production.baselines.find((b) => b.status === 'released');
  const awaitingCustomer = change.status === 'approved' && change.customerApprovalRequired === true && change.customerDecision?.decision !== 'approved';

  const amendmentColumns: Array<Column<ChangeRequest['amendments'][number]>> = [
    { key: 'po', header: 'Purchase order', render: (a) => <span className="mono">{a.purchaseOrderNumber}</span> },
    { key: 'cost', header: 'Supplier cost change', numeric: true, render: (a) => money(a.costDeltaMinor) },
    { key: 'lead', header: 'Lead time change', numeric: true, render: (a) => `${a.leadTimeDeltaDays} days` },
    { key: 'ack', header: 'Supplier', render: (a) => (a.acknowledgedAt ? <StatusChip tone="positive">acknowledged</StatusChip> : <StatusChip tone="attention">to acknowledge</StatusChip>) },
  ];

  return (
    <Page
      title={`${change.number} — ${change.title}`}
      breadcrumb={<Link href="/changes">← Changes</Link>}
      width="wide"
      meta={
        <>
          <StatusChip tone={CHANGE_TONE[change.status]}>{change.status.replace(/_/g, ' ')}</StatusChip>
          <Link href={`/sales-orders/${change.salesOrderId}/production`} className="mono">{change.salesOrderNumber}</Link>
          {change.urgency === 'urgent' ? <StatusChip tone="attention">urgent</StatusChip> : null}
        </>
      }
    >
      <SplitPane
        main={
          <Stack gap={4}>
            <Card title="The change">
              <DescriptionList
                columns={2}
                items={[
                  { label: 'From', value: ORIGIN[change.origin] },
                  { label: 'Classification', value: change.classification ?? 'not yet' },
                  { label: 'Why', value: change.reason },
                  { label: 'Customer decides', value: change.customerApprovalRequired === null ? 'decided at impact' : change.customerApprovalRequired ? 'yes' : 'no' },
                  ...(change.infoRequest ? [{ label: 'Asked', value: change.infoRequest }] : []),
                  ...(change.infoResponse ? [{ label: 'Answered', value: change.infoResponse }] : []),
                  ...(change.supplierBrief ? [{ label: 'Suppliers are told', value: change.supplierBrief }] : []),
                  ...(change.outcomeNote ? [{ label: 'Outcome', value: change.outcomeNote }] : []),
                ]}
              />
            </Card>

            {change.status === 'impact_analysis' ? (
              <ImpactEditor change={change} production={production} onSave={(body) => post('/impact', body)} onComplete={() => post('/complete-impact', v)} />
            ) : change.impact ? (
              <Card title={`Impact (version ${change.impact.versionNo})`}>
                <DescriptionList
                  columns={2}
                  items={[
                    { label: 'Customer price', value: money(change.impact.customerPriceDeltaMinor) },
                    { label: 'Delivery date', value: shift(change.impact.deliveryDateDeltaDays) },
                    ...change.impact.purchaseOrders
                      .filter((p) => p.costDeltaMinor !== 0 || p.leadTimeDeltaDays !== 0)
                      .map((p) => ({ label: production.purchaseOrders.find((po) => po.purchaseOrderId === p.purchaseOrderId)?.number ?? 'Purchase order', value: `supplier cost ${money(p.costDeltaMinor)}, lead time ${shift(p.leadTimeDeltaDays)}` })),
                    ...change.impact.wip.map((w, i) => ({ label: `WIP ${i + 1}`, value: `${w.quantity} ${w.disposition}, ${money(w.costMinor)}` })),
                  ]}
                />
                <details style={{ marginTop: 'var(--space-3)' }}>
                  <summary>Answers by area</summary>
                  <DescriptionList
                    items={Object.entries(change.impact.areas).map(([area, a]) => ({ label: area.replace(/_/g, ' '), value: a.applicable ? a.answer : `Not applicable — ${a.reason}` }))}
                  />
                </details>
              </Card>
            ) : null}

            {change.supplierImpacts.length > 0 ? (
              <Card title="Supplier estimates" description="Advisory: what each supplier says the change costs it.">
                <Stack gap={2}>
                  {change.supplierImpacts.map((s, i) => (
                    <p key={i}>
                      {s.supplierDisplayName}: {money(s.costDeltaMinor)}, {s.leadTimeDeltaDays} days{s.note ? ` — ${s.note}` : ''}
                    </p>
                  ))}
                </Stack>
              </Card>
            ) : null}

            {inForce || candidate ? (
              <Card title="Baseline" description="What governs now, against what this change releases.">
                <SplitPane
                  main={
                    <div>
                      <h3 style={{ font: 'var(--text-body-strong)' }}>{inForce ? `${change.releasedBaselineId ? 'Replaced' : 'In force'}: ${inForce.number}` : 'Nothing released'}</h3>
                      <ul>
                        {inForce?.items.map((i) => (
                          <li key={i.documentVersionId}>
                            {i.title} v{i.versionNo} ({i.purpose}){candidate && candidate.baselineId !== inForce.baselineId && !candidate.items.some((c) => c.documentVersionId === i.documentVersionId) ? <StatusChip tone="blocked">removed</StatusChip> : null}
                          </li>
                        ))}
                      </ul>
                    </div>
                  }
                  side={
                    <div>
                      <h3 style={{ font: 'var(--text-body-strong)' }}>{candidate ? `${candidate.status === 'draft' ? 'Candidate' : 'Released by this change'}: ${candidate.number}` : 'No candidate yet'}</h3>
                      <ul>
                        {candidate?.items.map((i) => (
                          <li key={i.documentVersionId}>
                            {i.title} v{i.versionNo} ({i.purpose}){inForce && candidate.baselineId !== inForce.baselineId && !inForce.items.some((c) => c.documentVersionId === i.documentVersionId) ? <StatusChip tone="progress">added</StatusChip> : null}
                          </li>
                        ))}
                      </ul>
                    </div>
                  }
                />
              </Card>
            ) : null}

            {change.amendments.length > 0 ? (
              <Card title="Purchase order amendments" flush>
                <DataTable caption="Amendments this change made" columns={amendmentColumns} rows={change.amendments} rowKey={(a) => a.purchaseOrderId} stackTitle={(a) => a.purchaseOrderNumber} empty={{ title: 'None', detail: '' }} />
              </Card>
            ) : null}
          </Stack>
        }
        side={
          <Stack gap={4}>
            <Card title="Next step">
              <Stack gap={3}>
                {change.status === 'proposed' ? (
                  <CommandButton receiptLabel="Triage started" onCommand={() => post('/triage', v)}>
                    Start triage
                  </CommandButton>
                ) : null}
                {change.status === 'triage' ? (
                  <>
                    <TextArea label="Question for the proposer" rows={2} value={text} onChange={(event) => setText(event.target.value)} />
                    <CommandButton variant="secondary" receiptLabel="Asked" disabled={text.trim().length < 3} disabledReason="Write the question" onCommand={() => post('/request-info', { ...v, question: text.trim() })}>
                      Ask for more information
                    </CommandButton>
                    <Select label="Classify as" value={classification} options={[{ value: 'clarification', label: 'Clarification — closes here' }, { value: 'correction', label: 'Correction' }, { value: 'scope', label: 'Scope or configuration change' }]} onChange={(event) => setClassification(event.target.value)} />
                    <TextArea label="What suppliers are told (no customer names)" rows={2} value={brief} onChange={(event) => setBrief(event.target.value)} />
                    {classification === 'clarification' ? <ReasonField label="What the clarification settled" audience="internal" value={text} onChange={setText} /> : null}
                    <CommandButton receiptLabel="Classified" onCommand={() => post('/classify', { ...v, classification, supplierBrief: brief.trim(), note: text.trim() })}>
                      Classify
                    </CommandButton>
                  </>
                ) : null}
                {change.status === 'clarification' ? <p>Waiting for the proposer to answer: “{change.infoRequest}”</p> : null}
                {change.status === 'commercial_approval' ? (
                  <ButtonLink href="/approvals" variant="secondary">
                    Waiting for approval — open approvals
                  </ButtonLink>
                ) : null}
                {change.status === 'approved' ? (
                  <>
                    {awaitingCustomer ? <Callout tone="attention" title="Waiting for the customer">Its price, date or scope moves; the customer decides before release.</Callout> : null}
                    <CommandButton receiptLabel="Released" disabled={awaitingCustomer} disabledReason="The customer has not approved this change yet" onCommand={() => post('/release', v)}>
                      Release the new baseline
                    </CommandButton>
                  </>
                ) : null}
                {change.status === 'released' ? <p>Waiting for every supplier to acknowledge the new baseline and its amendment.</p> : null}
                {change.status === 'implemented' ? (
                  <>
                    <ReasonField label="How the change was verified" audience="internal" value={text} onChange={setText} />
                    <CommandButton receiptLabel="Verified" disabled={text.trim().length < 3} disabledReason="Say how it was verified" onCommand={() => post('/verify', { ...v, note: text.trim() })}>
                      Verify
                    </CommandButton>
                  </>
                ) : null}
                {change.status === 'verified' ? (
                  <CommandButton receiptLabel="Closed" onCommand={() => post('/close', v)}>
                    Close the change
                  </CommandButton>
                ) : null}
                {['rejected', 'closed', 'withdrawn'].includes(change.status) ? <p>This change is {change.status}.</p> : null}
                {OPEN.includes(change.status) && change.status !== 'commercial_approval' && change.status !== 'approved' ? (
                  <details>
                    <summary>Withdraw this change</summary>
                    <ReasonField label="Why it is withdrawn" audience="internal" value={text} onChange={setText} />
                    <CommandButton variant="danger" receiptLabel="Withdrawn" disabled={text.trim().length < 3} disabledReason="Say why" onCommand={() => post('/withdraw', { ...v, reason: text.trim() })}>
                      Withdraw
                    </CommandButton>
                  </details>
                ) : null}
              </Stack>
            </Card>

            <Card title="Interim decisions" description="Stop or continue affected work while the change is decided (doc 09 §7). Each expires; the release lifts them.">
              <Stack gap={3}>
                {change.interimDecisions.length === 0 ? <p style={{ color: 'var(--color-text-muted)' }}>None issued.</p> : null}
                {change.interimDecisions.map((d) => (
                  <div key={d.interimDecisionId}>
                    <Inline gap={2}>
                      <StatusChip tone={d.active ? (d.decision === 'stop' ? 'blocked' : 'progress') : 'neutral'}>{d.decision}</StatusChip>
                      <span className="mono">{d.purchaseOrderNumber}</span>
                      <span>{d.active ? `until ${formatDue(d.expiresAt, null)}` : d.liftedAt ? `lifted: ${d.liftReason ?? ''}` : 'expired'}</span>
                    </Inline>
                    <p style={{ font: 'var(--text-caption)' }}>{d.reason}</p>
                    {d.active ? (
                      <CommandButton size="sm" variant="secondary" receiptLabel="Lifted" onCommand={() => post(`/interim-decisions/${d.interimDecisionId}/lift`, { reason: 'Lifted by JobWork' })}>
                        Lift
                      </CommandButton>
                    ) : null}
                  </div>
                ))}
                {OPEN.includes(change.status) ? (
                  <>
                    {production.purchaseOrders.map((po) => (
                      <Checkbox key={po.purchaseOrderId} label={`${po.number} — ${po.supplierDisplayName}`} checked={interim.pos.includes(po.purchaseOrderId)} onChange={(event) => setInterim({ ...interim, pos: event.target.checked ? [...interim.pos, po.purchaseOrderId] : interim.pos.filter((x) => x !== po.purchaseOrderId) })} />
                    ))}
                    <Select label="Decision" value={interim.decision} options={[{ value: 'stop', label: 'Stop affected work' }, { value: 'continue', label: 'Continue as planned' }]} onChange={(event) => setInterim({ ...interim, decision: event.target.value as 'stop' | 'continue' })} />
                    <TextInput label="Until (date)" type="date" value={interim.until} onChange={(event) => setInterim({ ...interim, until: event.target.value })} />
                    <TextArea label="Reason (the supplier sees the decision, not this text)" rows={2} value={interim.reason} onChange={(event) => setInterim({ ...interim, reason: event.target.value })} />
                    <CommandButton
                      variant="secondary"
                      receiptLabel="Issued"
                      disabled={interim.pos.length === 0 || interim.reason.trim().length < 3 || !interim.until}
                      disabledReason="Choose purchase orders, a reason and an end date"
                      onCommand={async () => {
                        await post('/interim-decisions', { purchaseOrderIds: interim.pos, decision: interim.decision, reason: interim.reason.trim(), expiresAt: new Date(`${interim.until}T23:59:59+05:30`).toISOString() });
                        setInterim({ pos: [], decision: 'stop', reason: '', until: '' });
                      }}
                    >
                      Issue interim decision
                    </CommandButton>
                  </>
                ) : null}
              </Stack>
            </Card>
          </Stack>
        }
      />
    </Page>
  );
}
