'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { Deviation, Ncr } from '@jobwork/contracts';
import {
  ButtonLink,
  Callout,
  Card,
  Checkbox,
  CommandButton,
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
} from '@jobwork/ui';
import { api, ApiError } from '../../../../lib/api';
import { NCR_TONE, STAGE } from '../../labels';

const day = (iso: string): string => new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));
const qty = (q: string): string => String(Number(q));
const list = (v: string): string[] => v.split(',').map((x) => x.trim()).filter(Boolean);

/**
 * One NCR (IN-15 F-15.5; doc 06 §10; doc 09 §§11–13): its scope and failed results, the
 * containment log, the disposition the status allows next (rework, a deviation, rejection), the
 * attempts so far, the supplier's corrective action, and closure with whatever still stands
 * in its way.
 */
export default function NcrPage(): React.JSX.Element {
  const ncrId = useParams<{ ncrId: string }>().ncrId;
  const [ncr, setNcr] = useState<Ncr | null>(null);
  const [deviations, setDeviations] = useState<Deviation[]>([]);
  const [error, setError] = useState<ApiError | null>(null);
  const [contain, setContain] = useState({ action: '', location: '' });
  const [rework, setRework] = useState({ disposition: 'rework', plan: '' });
  const [reject, setReject] = useState({ disposition: 'scrap', costResponsibility: 'supplier', reason: '' });
  const [dev, setDev] = useState({ characteristicIds: [] as string[], quantity: '', lots: '', expires: '', rationale: '', risk: '', ffs: '', price: '', warranty: '', traceability: '', labeling: '' });
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    try {
      const n = await api<Ncr>(`/ncrs/${ncrId}`);
      setNcr(n);
      setDeviations(await api<Deviation[]>(`/ncrs/${ncrId}/deviations`).catch(() => []));
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
      <Page title="NCR" breadcrumb={<Link href="/quality/ncrs">← NCRs</Link>}>
        {error ? <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} /> : <Card><LoadingState label="Loading the NCR" /></Card>}
      </Page>
    );
  }

  const n = ncr;
  const post = async (path: string, body: Record<string, unknown>): Promise<void> => {
    await api(`/ncrs/${n.ncrId}${path}`, { method: 'POST', body, idempotencyKey: crypto.randomUUID() });
    await load();
  };
  const v = { expectedVersion: n.aggregateVersion };
  const latest = n.dispositions.at(-1);
  const ca = n.correctiveAction;

  return (
    <Page
      title={`${n.number} — ${n.title}`}
      breadcrumb={<Link href="/quality/ncrs">← NCRs</Link>}
      width="wide"
      meta={
        <>
          <StatusChip tone={NCR_TONE[n.status] ?? 'neutral'}>{n.status.replace(/_/g, ' ')}</StatusChip>
          <StatusChip tone={n.severity === 'critical' ? 'blocked' : n.severity === 'major' ? 'attention' : 'neutral'}>{n.severity}</StatusChip>
          <span className="mono">{n.purchaseOrderNumber}</span>
          <span>{n.supplierDisplayName}</span>
        </>
      }
    >
      <SplitPane
        main={
          <Stack gap={4}>
            <Card title="Scope">
              <DescriptionList
                columns={2}
                items={[
                  { label: 'Affected', value: `${qty(n.affectedQuantity)} parts${n.lots.length ? ` · lots ${n.lots.join(', ')}` : ''}${n.serials.length ? ` · serials ${n.serials.join(', ')}` : ''}` },
                  { label: 'Found at', value: <Link href={`/quality/inspections/${n.inspectionId}`}>{n.inspectionNumber} ({STAGE[n.stage as keyof typeof STAGE] ?? n.stage})</Link> },
                  { label: 'What', value: n.description },
                  { label: 'Due', value: day(n.dueAt) },
                  { label: 'Cost responsibility', value: n.costResponsibility },
                  ...(n.parent ? [{ label: 'Branched from', value: <Link href={`/quality/ncrs/${n.parent.ncrId}`}>{n.parent.number}</Link> }] : []),
                  ...(n.children.length ? [{ label: 'Branches', value: <Inline gap={2}>{n.children.map((c) => <Link key={c.ncrId} href={`/quality/ncrs/${c.ncrId}`}>{c.number} ({c.status.replace(/_/g, ' ')})</Link>)}</Inline> }] : []),
                ]}
              />
            </Card>
            <Card title="Failed results">
              <ul>
                {n.defects.map((d) => (
                  <li key={d.resultId}>
                    {d.characteristicName}, sample {d.sampleNo}: <span className="numeric">{d.original.value} {d.original.unit ?? ''}</span> <StatusChip tone="blocked">fail</StatusChip> {d.outcomeReason}
                  </li>
                ))}
              </ul>
            </Card>
            <Card title="Containment">
              <Stack gap={2}>
                {n.containment.length === 0 ? <p style={{ color: 'var(--color-text-muted)' }}>Nothing contained yet.</p> : null}
                {n.containment.map((c, i) => (
                  <p key={i}>
                    <strong>{c.by === 'jobwork' ? 'JobWork' : 'Supplier'}</strong> · {day(c.recordedAt)}: {c.action}
                    {c.location ? ` · ${c.location}` : ''}
                    {c.quantity ? ` · ${qty(c.quantity)} parts` : ''}
                  </p>
                ))}
                {n.status !== 'closed' ? (
                  <details>
                    <summary>Record containment</summary>
                    <Stack gap={2}>
                      <TextInput label="What was done" value={contain.action} onChange={(e) => setContain({ ...contain, action: e.target.value })} />
                      <TextInput label="Where the parts are" value={contain.location} onChange={(e) => setContain({ ...contain, location: e.target.value })} />
                      <CommandButton size="sm" receiptLabel="Recorded" disabled={contain.action.trim().length < 3} disabledReason="Say what was done" onCommand={async () => { await post('/containment', { action: contain.action.trim(), location: contain.location.trim() }); setContain({ action: '', location: '' }); }}>
                        Record
                      </CommandButton>
                    </Stack>
                  </details>
                ) : null}
              </Stack>
            </Card>
            {n.dispositions.length > 0 ? (
              <Card title="Attempts">
                <Stack gap={2}>
                  {n.dispositions.map((d) => (
                    <div key={d.attemptNo}>
                      <strong>
                        {d.attemptNo}. {d.disposition.replace(/_/g, ' ')}
                      </strong>{' '}
                      <StatusChip tone={d.outcome === 'verified' || d.outcome === 'deviation_approved' ? 'positive' : d.outcome === 'pending' ? 'progress' : 'neutral'}>{d.outcome.replace(/_/g, ' ')}</StatusChip>
                      <p style={{ font: 'var(--text-caption)' }}>{d.plan}</p>
                      {d.reworkRecordedAt ? <p style={{ font: 'var(--text-caption)' }}>Supplier: {d.reworkNote} ({day(d.reworkRecordedAt)})</p> : null}
                      {d.reinspection ? (
                        <p style={{ font: 'var(--text-caption)' }}>
                          Reinspection <Link href={`/quality/inspections/${d.reinspection.inspectionId}`}>{d.reinspection.number}</Link> — {d.reinspection.status.replace(/_/g, ' ')}
                        </p>
                      ) : null}
                    </div>
                  ))}
                </Stack>
              </Card>
            ) : null}
            {deviations.length > 0 ? (
              <Card title="Deviations">
                <Stack gap={2}>
                  {deviations.map((d) => (
                    <div key={d.deviationId}>
                      <Inline gap={2}>
                        <strong className="mono">{d.number}</strong>
                        <StatusChip tone={d.active ? 'special' : d.status === 'approved' ? 'neutral' : d.status.startsWith('pending') ? 'attention' : 'neutral'}>{d.active ? 'active' : d.status.replace(/_/g, ' ')}</StatusChip>
                        <span>
                          {qty(d.quantity)} parts{d.lots.length ? ` · ${d.lots.join(', ')}` : ''} · until {day(d.expiresAt)}
                        </span>
                      </Inline>
                      <p style={{ font: 'var(--text-caption)' }}>
                        {d.characteristics.map((c) => c.name).join(', ')} — {d.rationale}
                        {d.customerApprovalRequired ? ` · customer ${d.customerDecision ? d.customerDecision.decision : 'to decide'}` : ' · JobWork only'}
                      </p>
                      {d.status === 'pending_internal' ? <ButtonLink href="/approvals" variant="secondary" size="sm">Waiting for approval</ButtonLink> : null}
                      {d.status === 'pending_internal' || d.status === 'pending_customer' ? (
                        <details>
                          <summary>Withdraw</summary>
                          <ReasonField label="Why" audience="internal" value={note} onChange={setNote} />
                          <CommandButton size="sm" variant="danger" receiptLabel="Withdrawn" disabled={note.trim().length < 3} disabledReason="Say why" onCommand={async () => { await api(`/deviations/${d.deviationId}/withdraw`, { method: 'POST', body: { expectedVersion: d.aggregateVersion, reason: note.trim() }, idempotencyKey: crypto.randomUUID() }); setNote(''); await load(); }}>
                            Withdraw deviation
                          </CommandButton>
                        </details>
                      ) : null}
                    </div>
                  ))}
                </Stack>
              </Card>
            ) : null}
          </Stack>
        }
        side={
          <Stack gap={4}>
            <Card title="Next step">
              <Stack gap={3}>
                {n.status === 'open' ? <p>Record how the parts are contained first.</p> : null}
                {n.status === 'containment' ? (
                  <CommandButton receiptLabel="Ready" onCommand={() => post('/to-disposition', v)}>
                    Contained — decide the disposition
                  </CommandButton>
                ) : null}
                {n.status === 'disposition_pending' ? (
                  <>
                    <details>
                      <summary>Rework, remake or sort</summary>
                      <Stack gap={2}>
                        <Select label="Disposition" value={rework.disposition} options={[{ value: 'rework', label: 'Rework' }, { value: 'remake', label: 'Remake' }, { value: 'sort', label: 'Sort' }]} onChange={(e) => setRework({ ...rework, disposition: e.target.value })} />
                        <TextArea label="Plan the supplier follows" rows={3} value={rework.plan} onChange={(e) => setRework({ ...rework, plan: e.target.value })} />
                        <CommandButton size="sm" receiptLabel="Approved" disabled={rework.plan.trim().length < 3} disabledReason="Write the plan" onCommand={() => post('/approve-rework', { ...v, disposition: rework.disposition, plan: rework.plan.trim() })}>
                          Approve
                        </CommandButton>
                      </Stack>
                    </details>
                    <details>
                      <summary>Use as is under a deviation</summary>
                      <Stack gap={2}>
                        {[...new Map(n.defects.map((d) => [d.characteristicId, d.characteristicName])).entries()].map(([id, name]) => (
                          <Checkbox key={id} label={name} checked={dev.characteristicIds.includes(id)} onChange={(e) => setDev({ ...dev, characteristicIds: e.target.checked ? [...dev.characteristicIds, id] : dev.characteristicIds.filter((x) => x !== id) })} />
                        ))}
                        <Inline gap={2}>
                          <TextInput label={`Parts (≤ ${qty(n.affectedQuantity)})`} inputMode="decimal" value={dev.quantity} onChange={(e) => setDev({ ...dev, quantity: e.target.value.trim() })} />
                          <TextInput label={n.lots.length ? `Lots (of ${n.lots.join(', ')})` : 'Lots'} value={dev.lots} onChange={(e) => setDev({ ...dev, lots: e.target.value })} />
                          <TextInput label="Until" type="date" value={dev.expires} onChange={(e) => setDev({ ...dev, expires: e.target.value })} />
                        </Inline>
                        <TextArea label="Why the parts can be used" rows={2} value={dev.rationale} onChange={(e) => setDev({ ...dev, rationale: e.target.value })} />
                        <TextArea label="Risk" rows={2} value={dev.risk} onChange={(e) => setDev({ ...dev, risk: e.target.value })} />
                        <TextArea label="Fit, function and safety" rows={2} value={dev.ffs} onChange={(e) => setDev({ ...dev, ffs: e.target.value })} />
                        <Inline gap={2}>
                          <TextInput label="Price effect" value={dev.price} onChange={(e) => setDev({ ...dev, price: e.target.value })} />
                          <TextInput label="Warranty effect" value={dev.warranty} onChange={(e) => setDev({ ...dev, warranty: e.target.value })} />
                          <TextInput label="Traceability" value={dev.traceability} onChange={(e) => setDev({ ...dev, traceability: e.target.value })} />
                          <TextInput label="Labelling" value={dev.labeling} onChange={(e) => setDev({ ...dev, labeling: e.target.value })} />
                        </Inline>
                        <CommandButton
                          size="sm"
                          receiptLabel="Requested"
                          disabled={dev.characteristicIds.length === 0 || !dev.quantity || !dev.expires || [dev.rationale, dev.risk, dev.ffs].some((x) => x.trim().length < 3)}
                          disabledReason="Choose characteristics, parts and an end date, and give the rationale, risk and fit/function/safety"
                          onCommand={() =>
                            post('/deviations', {
                              ...v,
                              characteristicIds: dev.characteristicIds,
                              quantity: dev.quantity,
                              lots: list(dev.lots),
                              expiresAt: new Date(`${dev.expires}T23:59:59+05:30`).toISOString(),
                              rationale: dev.rationale.trim(),
                              riskAssessment: dev.risk.trim(),
                              fitFunctionSafety: dev.ffs.trim(),
                              priceEffect: dev.price.trim(),
                              warrantyEffect: dev.warranty.trim(),
                              traceabilityEffect: dev.traceability.trim(),
                              labelingEffect: dev.labeling.trim(),
                            })
                          }
                        >
                          Request deviation
                        </CommandButton>
                      </Stack>
                    </details>
                    <details>
                      <summary>Return or scrap</summary>
                      <Stack gap={2}>
                        <Select label="Disposition" value={reject.disposition} options={[{ value: 'scrap', label: 'Scrap' }, { value: 'return', label: 'Return' }]} onChange={(e) => setReject({ ...reject, disposition: e.target.value })} />
                        <Select label="Cost borne by" value={reject.costResponsibility} options={['supplier', 'jobwork', 'customer', 'undetermined'].map((x) => ({ value: x, label: x }))} onChange={(e) => setReject({ ...reject, costResponsibility: e.target.value })} />
                        <ReasonField label="Why" audience="supplier" value={reject.reason} onChange={(r) => setReject({ ...reject, reason: r })} />
                        <CommandButton size="sm" variant="danger" receiptLabel="Rejected" disabled={reject.reason.trim().length < 3} disabledReason="Say why" onCommand={() => post('/reject', { ...v, disposition: reject.disposition, costResponsibility: reject.costResponsibility, reason: reject.reason.trim() })}>
                          Reject lot
                        </CommandButton>
                      </Stack>
                    </details>
                  </>
                ) : null}
                {n.status === 'rework' ? (
                  latest?.reworkRecordedAt ? (
                    <CommandButton receiptLabel="Planned" onCommand={() => post('/reinspection', v)}>
                      Plan the reinspection
                    </CommandButton>
                  ) : (
                    <p>Waiting for the supplier to record the {latest?.disposition}.</p>
                  )
                ) : null}
                {n.status === 'reinspection' && latest?.reinspection ? (
                  <ButtonLink href={`/quality/inspections/${latest.reinspection.inspectionId}`} variant="secondary">
                    Reinspection {latest.reinspection.number}
                  </ButtonLink>
                ) : null}
                {n.status === 'deviation_pending' ? <p>The deviation is with its approvers.</p> : null}
                {['verified', 'accepted_under_deviation', 'rejected'].includes(n.status) ? (
                  <>
                    {n.closeBlockers.length > 0 ? (
                      <Callout tone="attention" title="Not yet">
                        <ul style={{ paddingLeft: 'var(--space-4)' }}>{n.closeBlockers.map((b) => <li key={b}>{b}</li>)}</ul>
                      </Callout>
                    ) : null}
                    <ReasonField label="Closure note" audience="internal" value={note} onChange={setNote} />
                    <CommandButton receiptLabel="Closed" disabled={n.closeBlockers.length > 0 || note.trim().length < 3} disabledReason={n.closeBlockers.length > 0 ? 'Clear what stands in the way' : 'Write the closure note'} onCommand={async () => { await post('/close', { ...v, note: note.trim() }); setNote(''); }}>
                      Close NCR
                    </CommandButton>
                  </>
                ) : null}
                {n.status === 'closed' ? <p>Closed {n.closedAt ? day(n.closedAt) : ''}: {n.closureNote}</p> : null}
              </Stack>
            </Card>
            {ca ? (
              <Card title="Corrective action" description={`Due ${day(ca.dueAt)}`}>
                <Stack gap={2}>
                  <StatusChip tone={ca.status === 'verified' ? 'positive' : ca.status === 'requested' ? 'attention' : 'progress'}>{ca.status}</StatusChip>
                  {ca.problemDefinition ? (
                    <DescriptionList
                      items={[
                        { label: 'Problem', value: ca.problemDefinition },
                        { label: 'Why it happened', value: ca.occurrenceCause ?? '' },
                        { label: 'Why it escaped', value: ca.escapeCause ?? '' },
                        { label: 'Actions', value: <ul>{ca.actions.map((a, i) => <li key={i}>{a.action} — {a.owner}, by {a.dueDate}</li>)}</ul> },
                        ...(ca.effectivenessEvidence ? [{ label: 'Effective because', value: ca.effectivenessEvidence }] : []),
                      ]}
                    />
                  ) : (
                    <p style={{ color: 'var(--color-text-muted)' }}>Waiting for the supplier’s response.</p>
                  )}
                  {ca.status === 'responded' ? (
                    <Inline gap={2}>
                      <CommandButton size="sm" receiptLabel="Accepted" onCommand={() => post('/corrective-action/review', { expectedVersion: ca.aggregateVersion, decision: 'accept', note: '' })}>
                        Accept
                      </CommandButton>
                      <CommandButton size="sm" variant="secondary" receiptLabel="Returned" disabled={note.trim().length < 3} disabledReason="Write what is missing in the note below" onCommand={() => post('/corrective-action/review', { expectedVersion: ca.aggregateVersion, decision: 'return', note: note.trim() })}>
                        Return
                      </CommandButton>
                    </Inline>
                  ) : null}
                  {ca.status === 'accepted' ? (
                    <>
                      <ReasonField label="Evidence it worked" audience="internal" value={note} onChange={setNote} />
                      <CommandButton size="sm" receiptLabel="Verified" disabled={note.trim().length < 3} disabledReason="Give the evidence" onCommand={async () => { await post('/corrective-action/verify', { expectedVersion: ca.aggregateVersion, evidence: note.trim() }); setNote(''); }}>
                        Verify effective
                      </CommandButton>
                    </>
                  ) : null}
                </Stack>
              </Card>
            ) : null}
          </Stack>
        }
      />
    </Page>
  );
}
