'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import type { Inspection, Instrument, QualityUnit } from '@jobwork/contracts';
import { Card, CommandButton, DataTable, FileUpload, Inline, Page, Select, Stack, StatusChip, TextInput, type Column, type Tone, type VersionState } from '@jobwork/ui';
import { api } from '../../../lib/api';
import { createUploadApi } from '../../../lib/upload-api';
import { STAGE } from '../inspection-labels';

const CALIBRATION: Record<Instrument['calibrationStatus'], { label: string; tone: Tone }> = {
  valid: { label: 'calibrated', tone: 'positive' },
  expired: { label: 'calibration expired', tone: 'attention' },
  uncalibrated: { label: 'not calibrated', tone: 'attention' },
};
const INSPECTION: Record<Inspection['status'], { label: string; tone: Tone }> = {
  planned: { label: 'to start', tone: 'attention' },
  in_progress: { label: 'measuring', tone: 'attention' },
  results_submitted: { label: 'with JobWork', tone: 'progress' },
  under_review: { label: 'under review', tone: 'progress' },
  passed: { label: 'passed', tone: 'positive' },
  failed: { label: 'failed', tone: 'blocked' },
  invalidated: { label: 'invalidated', tone: 'neutral' },
};

const day = (iso: string): string => new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));
const IST_MIDDAY = (date: string): string => new Date(`${date}T12:00:00+05:30`).toISOString();

/**
 * A supplier's quality desk (IN-14 F-14.4; UC-18): the inspections JobWork asked it to carry
 * out, and its own measuring equipment with every calibration and its certificate. A result
 * remembers whether its instrument was in calibration on the day it was measured.
 */
export default function SupplierQualityPage(): React.JSX.Element {
  const [inspections, setInspections] = useState<Inspection[] | null>(null);
  const [instruments, setInstruments] = useState<Instrument[]>([]);
  const [units, setUnits] = useState<QualityUnit[]>([]);
  const [form, setForm] = useState({ assetTag: '', kind: '', unit: 'mm' });
  const [cal, setCal] = useState<Record<string, { performed: string; due: string; certificate: string | null }>>({});
  const uploadApi = useMemo(() => createUploadApi(), []);

  const load = useCallback(async () => {
    setInspections(await api<Inspection[]>('/supplier/inspections').catch(() => []));
    setInstruments(await api<Instrument[]>('/supplier/instruments').catch(() => []));
  }, []);

  useEffect(() => {
    void load();
    api<QualityUnit[]>('/quality-units').then(setUnits).catch(() => setUnits([]));
  }, [load]);

  const inspectionColumns: Array<Column<Inspection>> = [
    { key: 'number', header: 'Inspection', render: (i) => <Link href={`/supplier/inspections/${i.inspectionId}`} className="mono">{i.number}</Link> },
    { key: 'po', header: 'Purchase order', render: (i) => <span className="mono">{i.purchaseOrderNumber}</span> },
    { key: 'stage', header: 'Stage', render: (i) => STAGE[i.stage] },
    { key: 'pieces', header: 'Pieces', numeric: true, render: (i) => String(i.sampleSize) },
    { key: 'status', header: 'Status', render: (i) => <StatusChip tone={INSPECTION[i.status].tone}>{INSPECTION[i.status].label}</StatusChip> },
  ];

  return (
    <Page title="Quality" description="Inspections JobWork has planned on your orders, and the instruments you measure with." width="wide">
      <Stack gap={4}>
        <Card title="Inspections" flush>
          <DataTable
            caption="Your inspections, newest first"
            columns={inspectionColumns}
            rows={inspections ?? []}
            rowKey={(i) => i.inspectionId}
            stackTitle={(i) => `${i.number} — ${STAGE[i.stage]}`}
            empty={{ title: 'No inspections yet', detail: 'JobWork plans them on your purchase orders; you are told when one is planned.' }}
          />
        </Card>

        <Card title="Instruments" description="Register each gauge with its asset tag, then record every calibration with its certificate.">
          <Stack gap={4}>
            {instruments.map((t) => {
              const c = cal[t.instrumentId] ?? { performed: '', due: '', certificate: null };
              return (
                <div key={t.instrumentId} style={{ borderTop: 'var(--hairline) solid var(--color-border)', paddingTop: 'var(--space-3)' }}>
                  <Inline gap={2}>
                    <strong className="mono">{t.assetTag}</strong>
                    <span>{t.kind}</span>
                    {t.status === 'retired' ? <StatusChip tone="neutral">retired</StatusChip> : <StatusChip tone={CALIBRATION[t.calibrationStatus].tone}>{CALIBRATION[t.calibrationStatus].label}</StatusChip>}
                    {t.calibrationDueAt ? <span style={{ font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>due {day(t.calibrationDueAt)}</span> : null}
                  </Inline>
                  {t.status === 'in_service' ? (
                    <details>
                      <summary>Record a calibration</summary>
                      <Stack gap={2}>
                        <Inline gap={2}>
                          <TextInput label="Calibrated on" type="date" value={c.performed} onChange={(e) => setCal({ ...cal, [t.instrumentId]: { ...c, performed: e.target.value } })} />
                          <TextInput label="Next due" type="date" value={c.due} onChange={(e) => setCal({ ...cal, [t.instrumentId]: { ...c, due: e.target.value } })} />
                        </Inline>
                        <FileUpload
                          purpose="certificate"
                          api={uploadApi}
                          resumeKey={`calibration-${t.instrumentId}`}
                          onSettled={(v: VersionState) => {
                            if (v.status === 'available') setCal((all) => ({ ...all, [t.instrumentId]: { ...(all[t.instrumentId] ?? c), certificate: v.documentVersionId } }));
                          }}
                        />
                        <CommandButton
                          size="sm"
                          receiptLabel="Recorded"
                          disabled={!c.performed || !c.due || !c.certificate}
                          disabledReason="Give both dates and upload the certificate"
                          onCommand={async () => {
                            await api(`/supplier/instruments/${t.instrumentId}/calibrations`, {
                              method: 'POST',
                              body: { performedAt: IST_MIDDAY(c.performed), dueAt: IST_MIDDAY(c.due), outcome: 'pass', certificateDocumentVersionId: c.certificate },
                              idempotencyKey: crypto.randomUUID(),
                            });
                            await load();
                          }}
                        >
                          Record calibration
                        </CommandButton>
                      </Stack>
                    </details>
                  ) : null}
                </div>
              );
            })}
            <details>
              <summary>Register an instrument</summary>
              <Stack gap={2}>
                <Inline gap={2}>
                  <TextInput label="Asset tag" value={form.assetTag} onChange={(e) => setForm({ ...form, assetTag: e.target.value })} />
                  <TextInput label="What it is" hint="e.g. Outside micrometer 0–25 mm" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} />
                  <Select label="Reads in" value={form.unit} options={units.map((u) => ({ value: u.code, label: `${u.code} — ${u.label}` }))} onChange={(e) => setForm({ ...form, unit: e.target.value })} />
                </Inline>
                <CommandButton
                  size="sm"
                  receiptLabel="Registered"
                  disabled={form.assetTag.trim() === '' || form.kind.trim().length < 2}
                  disabledReason="Give the asset tag and what it is"
                  onCommand={async () => {
                    await api('/supplier/instruments', { method: 'POST', body: { assetTag: form.assetTag.trim(), kind: form.kind.trim(), unit: form.unit }, idempotencyKey: crypto.randomUUID() });
                    setForm({ assetTag: '', kind: '', unit: 'mm' });
                    await load();
                  }}
                >
                  Register
                </CommandButton>
              </Stack>
            </details>
          </Stack>
        </Card>
      </Stack>
    </Page>
  );
}
