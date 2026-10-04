'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import type { Instrument, MeResponse, QualityUnit } from '@jobwork/contracts';
import { Card, CommandButton, DataTable, FileUpload, Inline, Page, Select, Stack, StatusChip, TextInput, type Column, type Tone, type VersionState } from '@jobwork/ui';
import { api } from '../../../lib/api';
import { createUploadApi } from '../../../lib/upload-api';

const CALIBRATION: Record<Instrument['calibrationStatus'], { label: string; tone: Tone }> = {
  valid: { label: 'calibrated', tone: 'positive' },
  expired: { label: 'calibration expired', tone: 'attention' },
  uncalibrated: { label: 'not calibrated', tone: 'attention' },
};
const day = (iso: string): string => new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));
const IST_MIDDAY = (date: string): string => new Date(`${date}T12:00:00+05:30`).toISOString();

/**
 * Measuring equipment across the network (IN-14 F-14.4; BR-QLT-05): every supplier's, read
 * here so a reviewer can see what a result was measured with, and JobWork's own, registered
 * and calibrated by JobWork quality with each certificate.
 */
export default function InstrumentsPage(): React.JSX.Element {
  const [rows, setRows] = useState<Instrument[] | null>(null);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [units, setUnits] = useState<QualityUnit[]>([]);
  const [form, setForm] = useState({ assetTag: '', kind: '', unit: 'mm' });
  const [cal, setCal] = useState<{ instrumentId: string; performed: string; due: string; certificate: string | null }>({ instrumentId: '', performed: '', due: '', certificate: null });
  const uploadApi = useMemo(() => createUploadApi(), []);

  const load = useCallback(async () => {
    setRows(await api<Instrument[]>('/instruments').catch(() => []));
  }, []);

  useEffect(() => {
    void load();
    api<MeResponse>('/auth/me').then(setMe).catch(() => setMe(null));
    api<QualityUnit[]>('/quality-units').then(setUnits).catch(() => setUnits([]));
  }, [load]);

  const canManage = me?.roles.includes('jobwork_quality') ?? false;
  const own = (rows ?? []).filter((r) => r.ownerOrganizationId === me?.organizationId && r.status === 'in_service');
  const columns: Array<Column<Instrument>> = [
    { key: 'tag', header: 'Asset tag', render: (r) => <span className="mono">{r.assetTag}</span> },
    { key: 'kind', header: 'Instrument', render: (r) => r.kind },
    { key: 'owner', header: 'Owner', render: (r) => r.ownerDisplayName },
    { key: 'status', header: 'Calibration', render: (r) => (r.status === 'retired' ? <StatusChip tone="neutral">retired</StatusChip> : <StatusChip tone={CALIBRATION[r.calibrationStatus].tone}>{CALIBRATION[r.calibrationStatus].label}</StatusChip>) },
    { key: 'due', header: 'Due', render: (r) => (r.calibrationDueAt ? day(r.calibrationDueAt) : '—') },
    { key: 'certs', header: 'Calibrations', numeric: true, render: (r) => String(r.calibrations.length) },
  ];

  return (
    <Page title="Instruments" breadcrumb={<Link href="/quality">← Quality</Link>} description="Every result keeps whether its instrument was in calibration on the day it was measured." width="wide">
      <Stack gap={4}>
        <Card flush>
          <DataTable caption="Instruments by owner" columns={columns} rows={rows ?? []} rowKey={(r) => r.instrumentId} stackTitle={(r) => `${r.assetTag} — ${r.kind}`} empty={{ title: 'No instruments yet', detail: 'Suppliers register theirs from their portal.' }} />
        </Card>
        {canManage ? (
          <Card title="JobWork’s own equipment">
            <Stack gap={4}>
              <Inline gap={2}>
                <TextInput label="Asset tag" value={form.assetTag} onChange={(e) => setForm({ ...form, assetTag: e.target.value })} />
                <TextInput label="What it is" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} />
                <Select label="Reads in" value={form.unit} options={units.map((u) => ({ value: u.code, label: `${u.code} — ${u.label}` }))} onChange={(e) => setForm({ ...form, unit: e.target.value })} />
                <CommandButton
                  receiptLabel="Registered"
                  disabled={form.assetTag.trim() === '' || form.kind.trim().length < 2}
                  disabledReason="Give the asset tag and what it is"
                  onCommand={async () => {
                    await api('/instruments', { method: 'POST', body: { assetTag: form.assetTag.trim(), kind: form.kind.trim(), unit: form.unit }, idempotencyKey: crypto.randomUUID() });
                    setForm({ assetTag: '', kind: '', unit: 'mm' });
                    await load();
                  }}
                >
                  Register instrument
                </CommandButton>
              </Inline>
              {own.length > 0 ? (
                <Stack gap={2}>
                  <Inline gap={2}>
                    <Select label="Calibrate" value={cal.instrumentId} placeholder="Choose an instrument" options={own.map((r) => ({ value: r.instrumentId, label: `${r.assetTag} — ${r.kind}` }))} onChange={(e) => setCal({ ...cal, instrumentId: e.target.value })} />
                    <TextInput label="Calibrated on" type="date" value={cal.performed} onChange={(e) => setCal({ ...cal, performed: e.target.value })} />
                    <TextInput label="Next due" type="date" value={cal.due} onChange={(e) => setCal({ ...cal, due: e.target.value })} />
                  </Inline>
                  <FileUpload
                    purpose="certificate"
                    api={uploadApi}
                    resumeKey="jobwork-calibration"
                    onSettled={(v: VersionState) => {
                      if (v.status === 'available') setCal((c) => ({ ...c, certificate: v.documentVersionId }));
                    }}
                  />
                  <CommandButton
                    receiptLabel="Recorded"
                    disabled={!cal.instrumentId || !cal.performed || !cal.due || !cal.certificate}
                    disabledReason="Choose the instrument, give both dates and upload the certificate"
                    onCommand={async () => {
                      await api(`/instruments/${cal.instrumentId}/calibrations`, { method: 'POST', body: { performedAt: IST_MIDDAY(cal.performed), dueAt: IST_MIDDAY(cal.due), outcome: 'pass', certificateDocumentVersionId: cal.certificate }, idempotencyKey: crypto.randomUUID() });
                      setCal({ instrumentId: '', performed: '', due: '', certificate: null });
                      await load();
                    }}
                  >
                    Record calibration
                  </CommandButton>
                </Stack>
              ) : null}
            </Stack>
          </Card>
        ) : null}
      </Stack>
    </Page>
  );
}
