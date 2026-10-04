'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import type { BaselineCandidate, ChangeRequest, Inspection, MeResponse, Milestone, ProductionView, QualityPlan, QualityTemplate, WorkPackage } from '@jobwork/contracts';
import {
  ButtonLink,
  Callout,
  Card,
  Checkbox,
  CommandButton,
  CopyableId,
  ErrorState,
  GateMatrix,
  Inline,
  LoadingState,
  Page,
  ReasonField,
  Select,
  Stack,
  StatusChip,
  TextArea,
  TextInput,
  type Tone,
} from '@jobwork/ui';
import { api, ApiError } from '../../../../lib/api';
import { STAGE } from '../../../quality/labels';

/**
 * Technical baseline and production for one order (IN-09). Assemble the exact versions,
 * release them as a frozen manifest, transmit to each supplier, plan each work package,
 * release it only when every gate is green, then verify milestone evidence. Every button
 * is a named command; nothing here edits a status directly.
 */

const MILESTONE_TONE: Record<Milestone['status'], Tone> = {
  not_ready: 'neutral',
  ready: 'progress',
  in_progress: 'progress',
  evidence_submitted: 'attention',
  verified: 'positive',
  rejected_evidence: 'blocked',
  blocked: 'blocked',
  waived: 'neutral',
};

type Selection = Record<string, { include: boolean; purpose: 'governing' | 'reference' | 'inspection'; priority: string }>;

export default function OrderProductionPage(): React.JSX.Element {
  const salesOrderId = useParams<{ salesOrderId: string }>().salesOrderId;
  const [view, setView] = useState<ProductionView | null>(null);
  const [candidates, setCandidates] = useState<BaselineCandidate[]>([]);
  const [selection, setSelection] = useState<Selection>({});
  const [me, setMe] = useState<MeResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<ApiError | null>(null);
  const [plan, setPlan] = useState<Record<string, { start: string; finish: string }>>({});
  const [reason, setReason] = useState<Record<string, string>>({});
  const [changes, setChanges] = useState<ChangeRequest[]>([]);
  const [quality, setQuality] = useState<Record<string, { plans: QualityPlan[]; inspections: Inspection[] }>>({});
  const [templates, setTemplates] = useState<QualityTemplate[]>([]);
  const router = useRouter();
  const [proposal, setProposal] = useState({ title: '', reason: '', urgent: false });

  const load = useCallback(async () => {
    try {
      const v = await api<ProductionView>(`/sales-orders/${salesOrderId}/production`);
      setView(v);
      setError(null);
      api<ChangeRequest[]>(`/changes?salesOrderId=${salesOrderId}`)
        .then(setChanges)
        .catch(() => setChanges([]));
      // IN-14: each work package's quality plans and inspections.
      Promise.all(
        v.workPackages.map(async (w) => {
          const [plans, inspections] = await Promise.all([
            api<QualityPlan[]>(`/quality-plans?workPackageId=${w.workPackageId}`).catch(() => []),
            api<Inspection[]>(`/inspections?workPackageId=${w.workPackageId}`).catch(() => []),
          ]);
          return [w.workPackageId, { plans, inspections }] as const;
        }),
      )
        .then((entries) => setQuality(Object.fromEntries(entries)))
        .catch(() => setQuality({}));
      api<{ candidates: BaselineCandidate[] }>(`/sales-orders/${salesOrderId}/baseline-candidates`)
        .then((res) => {
          setCandidates(res.candidates);
          const draft = v.baselines.find((b) => b.status === 'draft') ?? v.baselines.find((b) => b.status === 'released');
          setSelection(
            Object.fromEntries(
              res.candidates.map((c) => {
                const item = draft?.items.find((i) => i.documentVersionId === c.documentVersionId);
                return [c.documentVersionId, { include: Boolean(item) || (!draft && c.selectable && c.source !== 'internal'), purpose: item?.purpose ?? (c.source === 'governing' ? 'governing' : 'reference'), priority: String(item?.governingPriority ?? 1) }];
              }),
            ),
          );
        })
        .catch(() => setCandidates([]));
    } catch (err) {
      if (err instanceof ApiError) setError(err);
    }
  }, [salesOrderId]);

  useEffect(() => {
    void load();
    api<MeResponse>('/auth/me').then(setMe).catch(() => setMe(null));
    api<QualityTemplate[]>('/quality-templates').then(setTemplates).catch(() => setTemplates([]));
  }, [load]);

  if (!view) {
    return (
      <Page title="Production" breadcrumb={<Link href={`/sales-orders/${salesOrderId}`}>← Sales order</Link>}>
        {error ? <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} /> : <Card><LoadingState label="Loading production" /></Card>}
      </Page>
    );
  }

  const roles = me?.roles ?? [];
  const canEngineer = roles.includes('jobwork_engineering') || roles.includes('jobwork_sourcing');
  const canVerify = roles.includes('jobwork_quality');
  const canQuality = canVerify;
  const order = view.order;
  const released = view.baselines.find((b) => b.status === 'released') ?? null;
  const draft = view.baselines.find((b) => b.status === 'draft') ?? null;

  const run = async (path: string, body: Record<string, unknown>): Promise<void> => {
    setNotice(null);
    try {
      await api(path, { method: 'POST', body, idempotencyKey: `${path}-${JSON.stringify(body)}` });
      await load();
    } catch (err) {
      if (err instanceof ApiError) setNotice(err);
      throw err;
    }
  };

  const assemble = (): Promise<void> =>
    run(`/sales-orders/${salesOrderId}/baselines`, {
      items: Object.entries(selection)
        .filter(([, s]) => s.include)
        .map(([documentVersionId, s]) => ({ documentVersionId, purpose: s.purpose, governingPriority: Number(s.priority || 1) })),
    });

  const milestoneRow = (m: Milestone): React.JSX.Element => (
    <div key={m.milestoneId} style={{ borderTop: 'var(--hairline) solid var(--color-border)', paddingTop: 'var(--space-2)' }}>
      <Inline gap={3}>
        <strong>{m.seq}. {m.title}</strong>
        <StatusChip tone={MILESTONE_TONE[m.status]}>{m.status.replace(/_/g, ' ')}</StatusChip>
        <span style={{ font: 'var(--text-caption)', color: m.forecastDate > m.plannedDate ? 'var(--status-attention-fg)' : 'var(--color-text-muted)' }}>
          plan {m.plannedDate}
          {m.forecastDate !== m.plannedDate ? ` · forecast ${m.forecastDate}` : ''}
          {m.actualDate ? ` · actual ${m.actualDate}` : ''}
        </span>
        {m.customerLabel ? <span style={{ font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>customer sees “{m.customerLabel}”</span> : null}
      </Inline>
      {m.evidence.length > 0 ? (
        <ul style={{ listStyle: 'none', font: 'var(--text-caption)', marginTop: 'var(--space-1)' }}>
          {m.evidence.map((e) => (
            <li key={e.evidenceId}>
              {e.filename} · scan {e.scanState} · observed {e.observedAt.slice(0, 16).replace('T', ' ')}
              {e.flagged ? <span style={{ color: 'var(--status-attention-fg)' }}> · flagged: {e.flagReason}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {m.forecasts.length > 0 ? (
        <p style={{ font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>
          Delays: {m.forecasts.map((f) => `r${f.revisionNo} → ${f.forecastDate} (${f.reasonCode}: ${f.reason})`).join('; ')}
        </p>
      ) : null}
      {m.backdateReason ? <p style={{ font: 'var(--text-caption)' }}>Backdated: {m.backdateReason}</p> : null}
      {m.decisionReason ? <p style={{ font: 'var(--text-caption)' }}>Decision note: {m.decisionReason}</p> : null}
      {canVerify && m.status === 'evidence_submitted' ? (
        <Stack gap={2}>
          <ReasonField label="Note (required to reject)" audience="internal" value={reason[m.milestoneId] ?? ''} onChange={(v) => setReason({ ...reason, [m.milestoneId]: v })} />
          <Inline gap={2}>
            <CommandButton size="sm" receiptLabel="Verified" onCommand={() => run(`/milestones/${m.milestoneId}/verify`, { expectedVersion: m.aggregateVersion, decision: 'verified', reason: reason[m.milestoneId] ?? '' })}>
              Verify
            </CommandButton>
            <CommandButton size="sm" variant="danger" receiptLabel="Returned" disabled={(reason[m.milestoneId] ?? '').trim().length < 3} disabledReason="Say what is missing" onCommand={() => run(`/milestones/${m.milestoneId}/verify`, { expectedVersion: m.aggregateVersion, decision: 'rejected_evidence', reason: reason[m.milestoneId] ?? '' })}>
              Reject evidence
            </CommandButton>
          </Inline>
        </Stack>
      ) : null}
      {canVerify && ['ready', 'in_progress', 'rejected_evidence', 'blocked'].includes(m.status) ? (
        <Inline gap={2}>
          <TextInput label="Waiver reason" value={reason[`w-${m.milestoneId}`] ?? ''} onChange={(e) => setReason({ ...reason, [`w-${m.milestoneId}`]: e.target.value })} />
          <CommandButton size="sm" variant="secondary" receiptLabel="Waived" disabled={(reason[`w-${m.milestoneId}`] ?? '').trim().length < 10} disabledReason="At least ten characters" onCommand={() => run(`/milestones/${m.milestoneId}/waive`, { expectedVersion: m.aggregateVersion, reason: reason[`w-${m.milestoneId}`] })}>
            Waive
          </CommandButton>
        </Inline>
      ) : null}
    </div>
  );

  const qualitySection = (wp: WorkPackage): React.JSX.Element => {
    const q = quality[wp.workPackageId] ?? { plans: [], inspections: [] };
    const plan = q.plans.find((p) => p.status !== 'superseded');
    return (
      <div style={{ borderTop: 'var(--hairline) solid var(--color-border)', paddingTop: 'var(--space-2)' }}>
        <Inline gap={2}>
          <strong>Quality</strong>
          {plan ? (
            <>
              <Link href={`/quality/plans/${plan.planId}`}>Plan v{plan.versionNo}</Link>
              <StatusChip tone={plan.status === 'approved' && plan.baselineCurrent ? 'positive' : 'attention'}>{plan.status === 'approved' && !plan.baselineCurrent ? 'approved, baseline superseded' : plan.status}</StatusChip>
            </>
          ) : canQuality && released && templates[0] ? (
            <CommandButton
              size="sm"
              variant="secondary"
              receiptLabel="Plan started"
              onCommand={async () => {
                const created = await api<QualityPlan>('/quality-plans', { method: 'POST', body: { workPackageId: wp.workPackageId, templateCode: templates[0]!.code }, idempotencyKey: crypto.randomUUID() });
                router.push(`/quality/plans/${created.planId}`);
              }}
            >
              Write quality plan ({templates[0].label})
            </CommandButton>
          ) : (
            <span style={{ color: 'var(--color-text-muted)' }}>No quality plan yet</span>
          )}
        </Inline>
        {q.inspections.length > 0 ? (
          <Stack gap={1}>
            {q.inspections.map((i) => (
              <Inline key={i.inspectionId} gap={2}>
                <Link href={`/quality/inspections/${i.inspectionId}`} className="mono">
                  {i.number}
                </Link>
                <span>{STAGE[i.stage]}</span>
                <StatusChip tone={i.status === 'passed' ? 'positive' : i.status === 'failed' ? 'blocked' : i.status === 'invalidated' ? 'neutral' : 'attention'}>{i.status.replace(/_/g, ' ')}</StatusChip>
              </Inline>
            ))}
          </Stack>
        ) : null}
      </div>
    );
  };

  const workPackageCard = (poId: string): React.JSX.Element => {
    const po = view.purchaseOrders.find((p) => p.purchaseOrderId === poId)!;
    const wp: WorkPackage | undefined = view.workPackages.find((w) => w.purchaseOrderId === poId);
    const draftPlan = plan[poId] ?? { start: wp?.plannedStart ?? new Date().toISOString().slice(0, 10), finish: wp?.plannedFinish ?? new Date(Date.now() + order.deliveryLeadDays * 86_400_000).toISOString().slice(0, 10) };
    return (
      <Card key={poId} title={`${wp?.number ?? 'Not planned'} · ${po.supplierDisplayName}`} description={`${po.number} · ${po.status} · ${po.leadTimeDays} days`} actions={wp ? <StatusChip tone={wp.status === 'completed' ? 'positive' : wp.status === 'planned' ? 'attention' : 'progress'}>{wp.status.replace(/_/g, ' ')}</StatusChip> : undefined}>
        <Stack gap={3}>
          {!wp || wp.status === 'planned' ? (
            canEngineer ? (
              <Inline gap={2}>
                <TextInput label="Planned start" type="date" value={draftPlan.start} onChange={(e) => setPlan({ ...plan, [poId]: { ...draftPlan, start: e.target.value } })} />
                <TextInput label="Planned finish" type="date" value={draftPlan.finish} onChange={(e) => setPlan({ ...plan, [poId]: { ...draftPlan, finish: e.target.value } })} />
                <CommandButton variant="secondary" receiptLabel="Planned" onCommand={() => run(`/purchase-orders/${poId}/work-package`, { plannedStart: draftPlan.start, plannedFinish: draftPlan.finish })}>
                  {wp ? 'Replan' : 'Plan with standard checkpoints'}
                </CommandButton>
              </Inline>
            ) : null
          ) : null}
          {wp ? (
            <>
              {wp.status === 'planned' ? <GateMatrix gates={wp.gates} label={`Release gates for ${wp.number}`} /> : null}
              {wp.status === 'planned' && canEngineer ? (
                <CommandButton receiptLabel="Released" disabled={!wp.allGreen} disabledReason="Every gate must pass" onCommand={() => run(`/work-packages/${wp.workPackageId}/release`, { expectedVersion: wp.aggregateVersion })}>
                  Release to production
                </CommandButton>
              ) : null}
              {wp.releasedAt ? (
                <p style={{ font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>
                  Released {wp.releasedAt.slice(0, 16).replace('T', ' ')} against baseline {String((wp.releaseSnapshot?.['baseline'] as { number?: string } | undefined)?.number ?? '')}. The snapshot of every gate is kept with the release.
                </p>
              ) : null}
              {qualitySection(wp)}
              {wp.containment.map((c) => (
                <Callout key={c.containmentId} tone="blocked" title={`Containment: ${c.kind.replace(/_/g, ' ')}`}>
                  {c.description} · {c.reportedAt.slice(0, 16).replace('T', ' ')}
                </Callout>
              ))}
              <Stack gap={2}>{wp.milestones.map(milestoneRow)}</Stack>
            </>
          ) : null}
        </Stack>
      </Card>
    );
  };

  return (
    <Page title={`Production — ${order.number}`} breadcrumb={<Link href={`/sales-orders/${salesOrderId}`}>← {order.number}</Link>} description={`${order.customerDisplayName} · ${order.title}`} width="wide">
      <Stack gap={4}>
        {notice ? <Callout tone="blocked" assertive title={notice.problem.title}>{notice.problem.detail ?? ''} ({notice.problem.code})</Callout> : null}

        <Card title="Technical baseline" description="The exact document versions the parts are made to. Frozen once released; a change is a new baseline.">
          <Stack gap={3}>
            {released ? (
              <Callout tone="positive" title={`${released.number} released ${released.releasedAt?.slice(0, 10) ?? ''}`}>
                {released.items.length} document{released.items.length === 1 ? '' : 's'} · <CopyableId label="Manifest hash" value={released.manifestHash ?? ''} />
              </Callout>
            ) : null}
            {canEngineer ? (
              <>
                <table style={{ width: '100%', borderCollapse: 'collapse', font: 'var(--text-caption)' }}>
                  <caption className="jw-visually-hidden">Documents that can go into the baseline</caption>
                  <thead>
                    <tr>
                      <th style={{ textAlign: 'left' }}>Include</th>
                      <th style={{ textAlign: 'left' }}>Document</th>
                      <th style={{ textAlign: 'left' }}>Purpose</th>
                      <th style={{ textAlign: 'left' }}>Priority</th>
                    </tr>
                  </thead>
                  <tbody>
                    {candidates.map((c) => {
                      const s = selection[c.documentVersionId] ?? { include: false, purpose: 'reference' as const, priority: '1' };
                      return (
                        <tr key={c.documentVersionId} style={{ borderTop: 'var(--hairline) solid var(--color-border)' }}>
                          <td>
                            <Checkbox label={c.selectable ? 'Include' : 'Not eligible'} disabled={!c.selectable} checked={s.include} onChange={(e) => setSelection({ ...selection, [c.documentVersionId]: { ...s, include: e.target.checked } })} />
                          </td>
                          <td>
                            <strong>{c.title}</strong> v{c.versionNo} · {c.logicalType.replace(/_/g, ' ')} · {c.source}
                            {c.reason ? <span style={{ display: 'block', color: 'var(--status-blocked-fg)' }}>{c.reason}</span> : null}
                          </td>
                          <td>
                            <Select label="Purpose" value={s.purpose} options={[{ value: 'governing', label: 'Governing' }, { value: 'reference', label: 'Reference' }, { value: 'inspection', label: 'Inspection' }]} onChange={(e) => setSelection({ ...selection, [c.documentVersionId]: { ...s, purpose: e.target.value as 'governing' } })} />
                          </td>
                          <td>
                            <TextInput label="Priority" type="number" numeric value={s.priority} onChange={(e) => setSelection({ ...selection, [c.documentVersionId]: { ...s, priority: e.target.value } })} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <Inline gap={2}>
                  <CommandButton variant="secondary" receiptLabel="Saved" onCommand={assemble}>
                    {draft ? 'Update draft baseline' : 'Assemble draft baseline'}
                  </CommandButton>
                  {draft ? (
                    <CommandButton
                      receiptLabel="Released"
                      disabled={draft.conflicts.length > 0 || released !== null}
                      disabledReason={released ? 'A released baseline is replaced only by releasing an engineering change' : 'Resolve the conflicts first'}
                      onCommand={() => run(`/baselines/${draft.baselineId}/release`, { expectedVersion: draft.aggregateVersion })}>
                      Release {draft.number}
                    </CommandButton>
                  ) : null}
                  {released ? (
                    <CommandButton variant="secondary" receiptLabel="Transmitted" onCommand={() => run(`/sales-orders/${salesOrderId}/transmittals`, { baselineId: released.baselineId })}>
                      Transmit to suppliers
                    </CommandButton>
                  ) : null}
                </Inline>
                {draft && draft.conflicts.length > 0 ? (
                  <Callout tone="blocked" title="Conflicting governing documents (BR-ENG-06)">
                    <ul style={{ paddingLeft: 'var(--space-4)' }}>{draft.conflicts.map((c) => <li key={c}>{c}</li>)}</ul>
                  </Callout>
                ) : null}
              </>
            ) : null}
            {released && released.transmittals.length > 0 ? (
              <Stack gap={1}>
                {released.transmittals.map((t) => (
                  <Inline key={t.transmittalId} gap={3}>
                    <span className="mono">{t.number}</span>
                    <span>{t.recipientDisplayName} · {t.purchaseOrderNumber}</span>
                    <StatusChip tone={t.status === 'acknowledged' ? 'positive' : t.overdue ? 'blocked' : 'attention'}>{t.status === 'issued' ? (t.overdue ? 'acknowledgment overdue' : 'awaiting acknowledgment') : t.status}</StatusChip>
                    <span style={{ font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>due {t.acknowledgmentDueAt.slice(0, 10)}</span>
                  </Inline>
                ))}
              </Stack>
            ) : null}
          </Stack>
        </Card>

        {released ? (
          <Card title="Engineering changes" description="Doc 06 §9. Any change to the released baseline goes through a change: impact, approval, the customer's decision when it moves price or date, then a new baseline.">
            <Stack gap={3}>
              {changes.length === 0 ? <p style={{ color: 'var(--color-text-muted)' }}>No changes on this order.</p> : null}
              {changes.map((c) => (
                <Inline key={c.changeRequestId} gap={3}>
                  <Link href={`/changes/${c.changeRequestId}`} className="mono">
                    {c.number}
                  </Link>
                  <span>{c.title}</span>
                  <StatusChip tone={['closed', 'verified'].includes(c.status) ? 'positive' : ['rejected', 'withdrawn'].includes(c.status) ? 'neutral' : 'attention'}>{c.status.replace(/_/g, ' ')}</StatusChip>
                </Inline>
              ))}
              {canEngineer ? (
                <details>
                  <summary>Propose a change</summary>
                  <Stack gap={2}>
                    <TextInput label="What changes" value={proposal.title} onChange={(e) => setProposal({ ...proposal, title: e.target.value })} />
                    <TextArea label="Why" rows={3} value={proposal.reason} onChange={(e) => setProposal({ ...proposal, reason: e.target.value })} />
                    <Checkbox label="Urgent" checked={proposal.urgent} onChange={(e) => setProposal({ ...proposal, urgent: e.target.checked })} />
                    <CommandButton
                      variant="secondary"
                      receiptLabel="Proposed"
                      disabled={proposal.title.trim().length < 3 || proposal.reason.trim().length < 3}
                      disabledReason="Say what changes and why"
                      onCommand={async () => {
                        await run('/changes', { salesOrderId, title: proposal.title.trim(), reason: proposal.reason.trim(), urgency: proposal.urgent ? 'urgent' : 'normal' });
                        setProposal({ title: '', reason: '', urgent: false });
                      }}
                    >
                      Propose change
                    </CommandButton>
                  </Stack>
                </details>
              ) : null}
            </Stack>
          </Card>
        ) : null}

        {view.purchaseOrders.length === 0 ? (
          <Card>
            <p style={{ color: 'var(--color-text-muted)' }}>Issue purchase orders before planning production.</p>
            <ButtonLink href={`/sales-orders/${salesOrderId}`} variant="secondary">
              Back to the order
            </ButtonLink>
          </Card>
        ) : (
          view.purchaseOrders.map((po) => workPackageCard(po.purchaseOrderId))
        )}
      </Stack>
    </Page>
  );
}
