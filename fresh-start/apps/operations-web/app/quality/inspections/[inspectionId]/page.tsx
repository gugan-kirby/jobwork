'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import type { Inspection, Ncr } from '@jobwork/contracts';
import { Callout, Card, Checkbox, CommandButton, DescriptionList, ErrorState, Inline, LoadingState, MeasurementGrid, Page, ReasonField, Select, SplitPane, Stack, StatusChip, TextArea, TextInput } from '@jobwork/ui';
import { api, ApiError } from '../../../../lib/api';
import { INSPECTION_TONE, STAGE } from '../../labels';

const places = (value: string): number => (value.includes('.') ? value.split('.')[1]!.length : 0);
const when = (iso: string | null): string => (iso ? new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)) + ' IST' : '—');

/**
 * The independent review of one inspection (IN-14 F-14.4; doc 09 §10; BR-QLT-03, BR-QLT-05):
 * the grid of results as measured and as normalized, what stands in the way of a pass, the
 * disposition of results taken with an instrument past calibration, transcription corrections
 * with a reason (the original stays), and the decision.
 */
export default function InspectionReviewPage(): React.JSX.Element {
  const inspectionId = useParams<{ inspectionId: string }>().inspectionId;
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [reason, setReason] = useState('');
  const [fix, setFix] = useState<Record<string, { value: string; reason: string }>>({});
  const [disposition, setDisposition] = useState<Record<string, string>>({});
  const [ncrs, setNcrs] = useState<Ncr[]>([]);
  const [open, setOpen] = useState({ resultIds: [] as string[], severity: 'major', quantity: '', lots: '', title: '', description: '' });
  const router = useRouter();

  const load = useCallback(async () => {
    try {
      const i = await api<Inspection>(`/inspections/${inspectionId}`);
      setInspection(i);
      setNcrs((await api<Ncr[]>(`/ncrs?workPackageId=${i.workPackageId}`).catch(() => [])).filter((n) => n.inspectionId === i.inspectionId));
      setError(null);
    } catch (err) {
      if (err instanceof ApiError) setError(err);
    }
  }, [inspectionId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!inspection) {
    return (
      <Page title="Inspection" breadcrumb={<Link href="/quality">← Quality</Link>}>
        {error ? <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} /> : <Card><LoadingState label="Loading the inspection" /></Card>}
      </Page>
    );
  }

  const i = inspection;
  const sampleNos = i.samples.length > 0 ? i.samples.map((s) => s.sampleNo) : Array.from({ length: i.sampleSize }, (_, k) => k + 1);
  const post = async (path: string, body: Record<string, unknown>): Promise<void> => {
    setInspection(await api<Inspection>(`/inspections/${i.inspectionId}${path}`, { method: 'POST', body: { expectedVersion: i.aggregateVersion, ...body }, idempotencyKey: crypto.randomUUID() }));
    setReason('');
  };
  const reviewing = i.status === 'under_review' && i.canReview;

  return (
    <Page
      title={`${i.number} — ${STAGE[i.stage]} inspection`}
      breadcrumb={<Link href="/quality">← Quality</Link>}
      width="wide"
      meta={
        <>
          <StatusChip tone={INSPECTION_TONE[i.status]}>{i.status.replace(/_/g, ' ')}</StatusChip>
          <span className="mono">{i.purchaseOrderNumber}</span>
          <span>{i.supplierDisplayName}</span>
        </>
      }
    >
      <SplitPane
        main={
          <Stack gap={4}>
            <Card title="Results" description="As measured, and normalized where the unit differs. Cannot-evaluate is never a fail, and never a pass.">
              {i.results.length === 0 ? (
                <p style={{ color: 'var(--color-text-muted)' }}>No results yet.</p>
              ) : (
                <MeasurementGrid
                  caption={`Results of ${i.number}`}
                  characteristics={i.characteristics.map((c) => ({ ...c, id: c.characteristicId }))}
                  sampleNos={sampleNos}
                  results={i.results}
                  cellAction={
                    reviewing
                      ? (r) => {
                          const f = fix[r.resultId] ?? { value: '', reason: '' };
                          const c = i.characteristics.find((x) => x.characteristicId === r.characteristicId)!;
                          const needsDisposition = (r.calibrationStatus === 'expired' || r.calibrationStatus === 'uncalibrated') && !r.disposition;
                          const instrumentId = i.results.find((x) => x.resultId === r.resultId)?.instrument?.instrumentId ?? null;
                          return (
                            <Stack gap={1}>
                              {needsDisposition ? (
                                <details open>
                                  <summary>Calibration disposition</summary>
                                  <ReasonField label="Why" audience="internal" minLength={3} value={disposition[r.resultId] ?? ''} onChange={(v) => setDisposition({ ...disposition, [r.resultId]: v })} />
                                  <Inline gap={1}>
                                    <CommandButton size="sm" receiptLabel="Accepted" disabled={(disposition[r.resultId] ?? '').trim().length < 3} disabledReason="Say why" onCommand={() => post('/dispositions', { resultId: r.resultId, decision: 'accept', reason: disposition[r.resultId]!.trim() })}>
                                      Accept
                                    </CommandButton>
                                    <CommandButton size="sm" variant="secondary" receiptLabel="Sent back" disabled={(disposition[r.resultId] ?? '').trim().length < 3} disabledReason="Say why" onCommand={() => post('/dispositions', { resultId: r.resultId, decision: 'reinspect', reason: disposition[r.resultId]!.trim() })}>
                                      Reinspect
                                    </CommandButton>
                                  </Inline>
                                </details>
                              ) : null}
                              <details>
                                <summary>Correct</summary>
                                <TextInput label={`Value in ${r.original.unit ?? 'words'}`} value={f.value} onChange={(e) => setFix({ ...fix, [r.resultId]: { ...f, value: e.target.value.trim() } })} />
                                <TextInput label="Why" value={f.reason} onChange={(e) => setFix({ ...fix, [r.resultId]: { ...f, reason: e.target.value } })} />
                                <CommandButton
                                  size="sm"
                                  receiptLabel="Corrected"
                                  disabled={f.value === '' || f.reason.trim().length < 3}
                                  disabledReason="Give the value and the reason"
                                  onCommand={() =>
                                    post('/corrections', {
                                      resultId: r.resultId,
                                      measurement: c.kind === 'attribute' ? { value: f.value, unit: null, declaredPrecision: null } : { value: f.value, unit: r.original.unit, declaredPrecision: places(f.value) },
                                      instrumentId,
                                      reason: f.reason.trim(),
                                    })
                                  }
                                >
                                  Save correction
                                </CommandButton>
                              </details>
                            </Stack>
                          );
                        }
                      : undefined
                  }
                />
              )}
            </Card>
            {i.results.some((r) => r.supersededByResultId !== null) ? (
              <Card title="Corrections on record">
                <ul>
                  {i.results
                    .filter((r) => r.supersededByResultId !== null)
                    .map((r) => {
                      const later = i.results.find((x) => x.resultId === r.supersededByResultId);
                      const c = i.characteristics.find((x) => x.characteristicId === r.characteristicId);
                      return (
                        <li key={r.resultId}>
                          {c?.name}, sample {r.sampleNo}: <span className="numeric">{r.original.value} {r.original.unit ?? ''}</span> ({r.outcome.replace('_', ' ')}) → <span className="numeric">{later?.original.value} {later?.original.unit ?? ''}</span> — {later?.correctionReason}
                        </li>
                      );
                    })}
                </ul>
              </Card>
            ) : null}
          </Stack>
        }
        side={
          <Stack gap={4}>
            <Card title="Decision">
              <Stack gap={3}>
                {i.passBlockers.length > 0 ? (
                  <Callout tone="blocked" title="Cannot pass yet">
                    <ul style={{ paddingLeft: 'var(--space-4)' }}>
                      {i.passBlockers.map((b) => (
                        <li key={b}>{b}</li>
                      ))}
                    </ul>
                  </Callout>
                ) : null}
                {i.status === 'results_submitted' ? (
                  i.canReview ? (
                    <CommandButton receiptLabel="Review started" onCommand={() => post('/review', {})}>
                      Start review
                    </CommandButton>
                  ) : (
                    <Callout tone="neutral" title="Someone else reviews this">You submitted these results; another member of JobWork quality decides.</Callout>
                  )
                ) : null}
                {reviewing ? (
                  <>
                    <TextArea label="Note to the supplier (needed to fail)" hint="The supplier reads this. Be specific enough for them to act on it." rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
                    <Inline gap={2}>
                      <CommandButton receiptLabel="Passed" disabled={i.passBlockers.length > 0} disabledReason="Clear what stands in the way first" onCommand={() => post('/decide', { decision: 'passed', reason: reason.trim() })}>
                        Pass
                      </CommandButton>
                      <CommandButton variant="danger" receiptLabel="Failed" disabled={reason.trim().length < 3} disabledReason="Say why it fails" onCommand={() => post('/decide', { decision: 'failed', reason: reason.trim() })}>
                        Fail
                      </CommandButton>
                    </Inline>
                  </>
                ) : null}
                {i.status === 'passed' || i.status === 'failed' ? <p>Decided {when(i.decidedAt)}{i.decisionReason ? `: ${i.decisionReason}` : '.'}</p> : null}
                {i.status === 'invalidated' ? <p>Invalidated: {i.invalidationReason}</p> : null}
                {i.status !== 'invalidated' ? (
                  <details>
                    <summary>Invalidate this inspection</summary>
                    <ReasonField label="Why it no longer counts" audience="internal" value={reason} onChange={setReason} />
                    <CommandButton variant="danger" size="sm" receiptLabel="Invalidated" disabled={reason.trim().length < 3} disabledReason="Say why" onCommand={() => post('/invalidate', { reason: reason.trim() })}>
                      Invalidate
                    </CommandButton>
                  </details>
                ) : null}
              </Stack>
            </Card>
            {i.status === 'failed' ? (
              <Card title="Nonconformance" description="Open an NCR on the failed results: contain, decide a disposition, close independently.">
                <Stack gap={2}>
                  {ncrs.map((n) => (
                    <Inline key={n.ncrId} gap={2}>
                      <Link href={`/quality/ncrs/${n.ncrId}`} className="mono">{n.number}</Link>
                      <StatusChip tone={n.status === 'closed' ? 'positive' : 'attention'}>{n.status.replace(/_/g, ' ')}</StatusChip>
                    </Inline>
                  ))}
                  <details open={ncrs.length === 0}>
                    <summary>Open an NCR</summary>
                    <Stack gap={2}>
                      {i.results
                        .filter((r) => r.supersededByResultId === null && r.outcome === 'fail')
                        .map((r) => {
                          const c = i.characteristics.find((x) => x.characteristicId === r.characteristicId);
                          return (
                            <Checkbox
                              key={r.resultId}
                              label={`${c?.name ?? ''}, sample ${r.sampleNo}: ${r.original.value} ${r.original.unit ?? ''}`}
                              checked={open.resultIds.includes(r.resultId)}
                              onChange={(e) => setOpen({ ...open, resultIds: e.target.checked ? [...open.resultIds, r.resultId] : open.resultIds.filter((x) => x !== r.resultId) })}
                            />
                          );
                        })}
                      <TextInput label="Title" value={open.title} onChange={(e) => setOpen({ ...open, title: e.target.value })} />
                      <TextArea label="What was found" rows={2} value={open.description} onChange={(e) => setOpen({ ...open, description: e.target.value })} />
                      <Inline gap={2}>
                        <Select label="Severity" value={open.severity} options={[{ value: 'critical', label: 'Critical' }, { value: 'major', label: 'Major' }, { value: 'minor', label: 'Minor' }]} onChange={(e) => setOpen({ ...open, severity: e.target.value })} />
                        <TextInput label="Parts affected" inputMode="decimal" value={open.quantity} onChange={(e) => setOpen({ ...open, quantity: e.target.value.trim() })} />
                        <TextInput label="Lots (comma separated)" value={open.lots || i.lot} onChange={(e) => setOpen({ ...open, lots: e.target.value })} />
                      </Inline>
                      <CommandButton
                        size="sm"
                        receiptLabel="Opened"
                        disabled={open.resultIds.length === 0 || !open.quantity || open.title.trim().length < 3 || open.description.trim().length < 3}
                        disabledReason="Choose the failed results, the parts affected, a title and what was found"
                        onCommand={async () => {
                          const created = await api<Ncr>('/ncrs', {
                            method: 'POST',
                            body: { inspectionId: i.inspectionId, resultIds: open.resultIds, title: open.title.trim(), description: open.description.trim(), severity: open.severity, affectedQuantity: open.quantity, lots: (open.lots || i.lot).split(',').map((x) => x.trim()).filter(Boolean) },
                            idempotencyKey: crypto.randomUUID(),
                          });
                          router.push(`/quality/ncrs/${created.ncrId}`);
                        }}
                      >
                        Open NCR
                      </CommandButton>
                    </Stack>
                  </details>
                </Stack>
              </Card>
            ) : null}
            <Card title="Record">
              <DescriptionList
                items={[
                  { label: 'Pieces', value: String(i.sampleSize) },
                  { label: 'Plan', value: `version ${i.planVersionNo} on ${i.baselineNumber}` },
                  { label: 'Planned', value: when(i.plannedAt) },
                  { label: 'Measured', value: when(i.inspectedAt) },
                  { label: 'Submitted', value: when(i.submittedAt) },
                  ...(i.reinspectionOf ? [{ label: 'Reinspection of', value: <Link href={`/quality/inspections/${i.reinspectionOf}`}>the earlier inspection</Link> }] : []),
                  ...(i.attachments.length > 0 ? [{ label: 'Attachments', value: i.attachments.map((a) => a.filename).join(', ') }] : []),
                ]}
              />
            </Card>
          </Stack>
        }
      />
    </Page>
  );
}
