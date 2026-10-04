'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { Inspection, Instrument, QualityUnit } from '@jobwork/contracts';
import {
  Callout,
  Card,
  CommandButton,
  DescriptionList,
  ErrorState,
  FileUpload,
  Inline,
  LoadingState,
  MeasurementGrid,
  Page,
  Stack,
  StatusChip,
  TextInput,
  describeLimits,
  type Tone,
  type VersionState,
} from '@jobwork/ui';
import { api, ApiError } from '../../../../lib/api';
import { createUploadApi } from '../../../../lib/upload-api';
import { STAGE } from '../../inspection-labels';

const STATUS: Record<Inspection['status'], { label: string; tone: Tone }> = {
  planned: { label: 'to start', tone: 'attention' },
  in_progress: { label: 'measuring', tone: 'progress' },
  results_submitted: { label: 'with JobWork quality', tone: 'progress' },
  under_review: { label: 'under review', tone: 'progress' },
  passed: { label: 'passed', tone: 'positive' },
  failed: { label: 'failed', tone: 'blocked' },
  invalidated: { label: 'invalidated', tone: 'neutral' },
};

/** Decimal places as written: "12.70" → 2. The value's declared precision is what was read, never rounded. */
const places = (value: string): number => (value.includes('.') ? value.split('.')[1]!.length : 0);

const cellStyle: React.CSSProperties = { width: '100%', minWidth: '7rem', padding: 'var(--space-2)', border: 'var(--hairline) solid var(--color-border)', borderRadius: 'var(--radius-sm)', font: 'var(--text-body)' };

/**
 * A supplier records an inspection JobWork planned (IN-14 F-14.4; UC-18): every sample against
 * every characteristic of the stage, with the instrument used and the unit as read. A unit
 * change relabels the value and never converts it (doc 21 §7); JobWork's engine judges it.
 * Until JobWork's review starts, a transcription can be corrected with a reason.
 */
export default function SupplierInspectionPage(): React.JSX.Element {
  const inspectionId = useParams<{ inspectionId: string }>().inspectionId;
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [units, setUnits] = useState<QualityUnit[]>([]);
  const [instruments, setInstruments] = useState<Instrument[]>([]);
  const [error, setError] = useState<ApiError | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [unitFor, setUnitFor] = useState<Record<string, string>>({});
  const [toolFor, setToolFor] = useState<Record<string, string>>({});
  const [serials, setSerials] = useState<Record<number, string>>({});
  const [attachments, setAttachments] = useState<string[]>([]);
  const [fix, setFix] = useState<Record<string, { value: string; reason: string }>>({});
  const uploadApi = useMemo(() => createUploadApi(), []);

  const load = useCallback(async () => {
    try {
      setInspection(await api<Inspection>(`/supplier/inspections/${inspectionId}`));
      setError(null);
    } catch (err) {
      if (err instanceof ApiError) setError(err);
    }
  }, [inspectionId]);

  useEffect(() => {
    void load();
    api<QualityUnit[]>('/quality-units').then(setUnits).catch(() => setUnits([]));
    api<Instrument[]>('/supplier/instruments').then((all) => setInstruments(all.filter((i) => i.status === 'in_service'))).catch(() => setInstruments([]));
  }, [load]);

  if (!inspection) {
    return (
      <Page title="Inspection" breadcrumb={<Link href="/supplier/quality">← Quality</Link>}>
        {error ? <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} /> : <Card><LoadingState label="Loading the inspection" /></Card>}
      </Page>
    );
  }

  const i = inspection;
  const sampleNos = Array.from({ length: i.sampleSize }, (_, k) => k + 1);
  const key = (n: number, c: string): string => `${n}:${c}`;
  const unitOf = (c: Inspection['characteristics'][number]): string => unitFor[c.characteristicId] ?? c.unit ?? '';
  const dimensionOf = (code: string | null): string | undefined => units.find((u) => u.code === code)?.dimension;
  const complete = i.characteristics.every((c) => sampleNos.every((n) => (values[key(n, c.characteristicId)] ?? '').trim() !== '') && (c.kind === 'attribute' || toolFor[c.characteristicId]));
  const post = async (path: string, body: Record<string, unknown>): Promise<void> => {
    setInspection(await api<Inspection>(`/supplier/inspections/${i.inspectionId}${path}`, { method: 'POST', body, idempotencyKey: crypto.randomUUID() }));
  };

  return (
    <Page
      title={`${i.number} — ${STAGE[i.stage]} inspection`}
      breadcrumb={<Link href={`/supplier/orders/${i.purchaseOrderId}`}>← {i.purchaseOrderNumber}</Link>}
      width="wide"
      meta={<StatusChip tone={STATUS[i.status].tone}>{STATUS[i.status].label}</StatusChip>}
    >
      <Stack gap={4}>
        <Card>
          <DescriptionList
            columns={2}
            items={[
              { label: 'Pieces to measure', value: String(i.sampleSize) },
              { label: 'Drawing pack', value: i.baselineNumber },
              { label: 'Planned', value: new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium' }).format(new Date(i.plannedAt)) },
              ...(i.note ? [{ label: 'From JobWork', value: i.note }] : []),
              ...(i.decisionReason ? [{ label: 'Reviewer’s note', value: i.decisionReason }] : []),
              ...(i.invalidationReason ? [{ label: 'Invalidated', value: i.invalidationReason }] : []),
            ]}
          />
        </Card>

        {i.status === 'planned' ? (
          <Card title="Start" description="Start when the pieces are on the bench. Measure every characteristic below on each piece.">
            <CommandButton receiptLabel="Started" onCommand={() => post('/start', { expectedVersion: i.aggregateVersion })}>
              Start inspection
            </CommandButton>
          </Card>
        ) : null}

        {i.status === 'in_progress' ? (
          <Card title="Record results" description="Enter each value as read, in the unit you read it in. It is judged by JobWork when you submit; nothing is rounded.">
            <Stack gap={4}>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <caption className="jw-visually-hidden">Results to record</caption>
                  <thead>
                    <tr style={{ textAlign: 'left', font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>
                      <th scope="col" style={{ padding: 'var(--space-2)' }}>Characteristic</th>
                      <th scope="col" style={{ padding: 'var(--space-2)' }}>Unit and instrument</th>
                      {sampleNos.map((n) => (
                        <th key={n} scope="col" style={{ padding: 'var(--space-2)' }}>
                          Piece {n}
                          <input aria-label={`Serial of piece ${n}`} placeholder="serial" value={serials[n] ?? ''} onChange={(e) => setSerials({ ...serials, [n]: e.target.value })} style={{ ...cellStyle, font: 'var(--text-caption)', marginTop: 'var(--space-1)' }} />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {i.characteristics.map((c) => (
                      <tr key={c.characteristicId} style={{ borderTop: 'var(--hairline) solid var(--color-border)', verticalAlign: 'top' }}>
                        <th scope="row" style={{ padding: 'var(--space-2)', textAlign: 'left', fontWeight: 'normal' }}>
                          <strong>
                            {c.seq}. {c.name}
                          </strong>
                          <span className="numeric" style={{ display: 'block', font: 'var(--text-caption)' }}>
                            {describeLimits({ ...c, id: c.characteristicId })}
                          </span>
                          <span style={{ display: 'block', font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>
                            {[c.drawingReference ? `balloon ${c.drawingReference}` : null, c.method || null].filter(Boolean).join(' · ')}
                          </span>
                        </th>
                        <td style={{ padding: 'var(--space-2)' }}>
                          {c.kind === 'variable' ? (
                            <Stack gap={1}>
                              <select aria-label={`Unit for ${c.name}`} value={unitOf(c)} onChange={(e) => setUnitFor({ ...unitFor, [c.characteristicId]: e.target.value })} style={cellStyle}>
                                {units
                                  .filter((u) => u.dimension === dimensionOf(c.unit))
                                  .map((u) => (
                                    <option key={u.code} value={u.code}>
                                      {u.code} — {u.label}
                                    </option>
                                  ))}
                              </select>
                              <select aria-label={`Instrument for ${c.name}`} value={toolFor[c.characteristicId] ?? ''} onChange={(e) => setToolFor({ ...toolFor, [c.characteristicId]: e.target.value })} style={cellStyle}>
                                <option value="">Instrument used…</option>
                                {instruments.map((t) => (
                                  <option key={t.instrumentId} value={t.instrumentId}>
                                    {t.assetTag} — {t.kind}
                                    {t.calibrationStatus !== 'valid' ? ` (${t.calibrationStatus})` : ''}
                                  </option>
                                ))}
                              </select>
                            </Stack>
                          ) : (
                            <span style={{ font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>Visual or go/no-go</span>
                          )}
                        </td>
                        {sampleNos.map((n) => (
                          <td key={n} style={{ padding: 'var(--space-2)' }}>
                            {c.kind === 'attribute' ? (
                              <select aria-label={`${c.name}, piece ${n}`} value={values[key(n, c.characteristicId)] ?? ''} onChange={(e) => setValues({ ...values, [key(n, c.characteristicId)]: e.target.value })} style={cellStyle}>
                                <option value="">Choose…</option>
                                {c.acceptedValues.map((v) => (
                                  <option key={v} value={v}>
                                    {v}
                                  </option>
                                ))}
                                <option value="not conforming">not conforming</option>
                              </select>
                            ) : (
                              <input
                                aria-label={`${c.name}, piece ${n}, in ${unitOf(c)}`}
                                inputMode="decimal"
                                className="numeric"
                                value={values[key(n, c.characteristicId)] ?? ''}
                                onChange={(e) => setValues({ ...values, [key(n, c.characteristicId)]: e.target.value.trim() })}
                                style={cellStyle}
                              />
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {instruments.some((t) => t.calibrationStatus !== 'valid') ? (
                <Callout tone="attention" title="An instrument is out of calibration">
                  You can still record with it. JobWork quality then decides whether to accept those results or ask for a re-measure.
                </Callout>
              ) : null}
              {instruments.length === 0 ? (
                <Callout tone="attention" title="Register your instruments first">
                  Add the gauges you measure with, and their calibration certificates, under <Link href="/supplier/quality">Quality</Link>.
                </Callout>
              ) : null}
              <FileUpload
                purpose="certificate"
                api={uploadApi}
                resumeKey={`inspection-${i.inspectionId}`}
                onSettled={(v: VersionState) => {
                  if (v.status === 'available') setAttachments((a) => [...a, v.documentVersionId]);
                }}
              />
              <CommandButton
                receiptLabel="Submitted"
                disabled={!complete}
                disabledReason="Every piece needs every characteristic, and each measured value its instrument"
                onCommand={() =>
                  post('/results', {
                    expectedVersion: i.aggregateVersion,
                    inspectedAt: new Date().toISOString(),
                    samples: sampleNos.map((n) => ({ sampleNo: n, serial: serials[n] ?? '' })),
                    results: i.characteristics.flatMap((c) =>
                      sampleNos.map((n) => {
                        const value = values[key(n, c.characteristicId)] ?? '';
                        return {
                          sampleNo: n,
                          characteristicId: c.characteristicId,
                          measurement: c.kind === 'attribute' ? { value, unit: null, declaredPrecision: null } : { value, unit: unitOf(c), declaredPrecision: places(value) },
                          instrumentId: c.kind === 'variable' ? toolFor[c.characteristicId] : null,
                        };
                      }),
                    ),
                    attachments: attachments.map((documentVersionId) => ({ documentVersionId })),
                  })
                }
              >
                Submit results
              </CommandButton>
            </Stack>
          </Card>
        ) : null}

        {i.results.length > 0 ? (
          <Card title="Results" description={i.status === 'results_submitted' ? 'With JobWork quality. Until review starts, you can correct a transcription; the original stays on record.' : undefined}>
            <MeasurementGrid
              caption={`Results of ${i.number}`}
              characteristics={i.characteristics.map((c) => ({ ...c, id: c.characteristicId }))}
              sampleNos={sampleNos}
              results={i.results}
              cellAction={
                i.status === 'results_submitted'
                  ? (r) => {
                      const c = i.characteristics.find((x) => x.characteristicId === r.characteristicId)!;
                      const f = fix[r.resultId] ?? { value: '', reason: '' };
                      return (
                        <details>
                          <summary>Correct</summary>
                          <Stack gap={1}>
                            <TextInput label={`Value in ${r.original.unit ?? 'words'}`} value={f.value} onChange={(e) => setFix({ ...fix, [r.resultId]: { ...f, value: e.target.value.trim() } })} />
                            <TextInput label="Why" value={f.reason} onChange={(e) => setFix({ ...fix, [r.resultId]: { ...f, reason: e.target.value } })} />
                            <CommandButton
                              size="sm"
                              receiptLabel="Corrected"
                              disabled={f.value === '' || f.reason.trim().length < 3}
                              disabledReason="Give the value and the reason"
                              onCommand={() =>
                                post('/corrections', {
                                  expectedVersion: i.aggregateVersion,
                                  resultId: r.resultId,
                                  measurement: c.kind === 'attribute' ? { value: f.value, unit: null, declaredPrecision: null } : { value: f.value, unit: r.original.unit, declaredPrecision: places(f.value) },
                                  instrumentId: i.results.find((x) => x.resultId === r.resultId)?.instrument?.instrumentId ?? null,
                                  reason: f.reason.trim(),
                                })
                              }
                            >
                              Save correction
                            </CommandButton>
                          </Stack>
                        </details>
                      );
                    }
                  : undefined
              }
            />
            {i.attachments.length > 0 ? (
              <Inline gap={2}>
                {i.attachments.map((a) => (
                  <span key={a.documentVersionId} style={{ font: 'var(--text-caption)' }}>
                    {a.filename}
                  </span>
                ))}
              </Inline>
            ) : null}
          </Card>
        ) : null}
      </Stack>
    </Page>
  );
}
