'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DownloadResponse, SupplierMilestone, SupplierProduction } from '@jobwork/contracts';
import { Button, Callout, Card, CommandButton, CopyableId, FileUpload, Inline, Select, Stack, StatusChip, TextArea, TextInput, type Tone, type VersionState, useCommandTick } from '@jobwork/ui';
import { api, ApiError } from '../../../../lib/api';
import { createUploadApi } from '../../../../lib/upload-api';

/**
 * The supplier's production half of a purchase order (IN-09): the exact drawing pack
 * JobWork transmitted and its acknowledgment, then the checkpoints — start, upload the
 * evidence, report a delay. Nothing here marks a checkpoint done; JobWork verifies it.
 */

const TONE: Record<SupplierMilestone['status'], Tone> = {
  not_ready: 'neutral',
  ready: 'progress',
  in_progress: 'progress',
  evidence_submitted: 'attention',
  verified: 'positive',
  rejected_evidence: 'blocked',
  blocked: 'blocked',
  waived: 'neutral',
};

const WORDS: Record<SupplierMilestone['status'], string> = {
  not_ready: 'Waiting for the previous step',
  ready: 'Ready to start',
  in_progress: 'In progress',
  evidence_submitted: 'With JobWork for verification',
  verified: 'Verified by JobWork',
  rejected_evidence: 'More evidence needed',
  blocked: 'Blocked',
  waived: 'Waived by JobWork',
};

export function ProductionPanel({ purchaseOrderId }: { purchaseOrderId: string }): React.JSX.Element | null {
  const [view, setView] = useState<SupplierProduction | null>(null);
  const [notice, setNotice] = useState<ApiError | null>(null);
  const [ackNote, setAckNote] = useState('');
  const [uploaded, setUploaded] = useState<Record<string, string[]>>({});
  const [delay, setDelay] = useState<Record<string, { date: string; code: string; reason: string }>>({});
  const uploadApi = useMemo(() => createUploadApi(), []);

  const load = useCallback(async () => {
    try {
      setView(await api<SupplierProduction>(`/supplier/purchase-orders/${purchaseOrderId}/production`));
    } catch (err) {
      if (err instanceof ApiError) setNotice(err);
    }
  }, [purchaseOrderId]);

  // Acknowledging a change acknowledges its transmittal too: refresh after any command on the page.
  const tick = useCommandTick();
  useEffect(() => {
    void load();
  }, [load, tick]);

  if (!view) return null;

  const act = async (path: string, body: Record<string, unknown>): Promise<void> => {
    setNotice(null);
    try {
      setView(await api<SupplierProduction>(path, { method: 'POST', body, idempotencyKey: `${path}-${JSON.stringify(body)}` }));
    } catch (err) {
      if (err instanceof ApiError) {
        setNotice(err);
        // A refused start is recorded by JobWork; reload so the page shows the truth.
        void load();
      }
      throw err;
    }
  };

  async function download(versionId: string): Promise<void> {
    const res = await api<DownloadResponse>(`/documents/versions/${versionId}/download`);
    window.location.assign(res.url);
  }

  const t = view.transmittal;
  const wp = view.workPackage;

  const milestoneCard = (m: SupplierMilestone): React.JSX.Element => {
    const files = uploaded[m.milestoneId] ?? [];
    const d = delay[m.milestoneId] ?? { date: m.forecastDate, code: 'machine', reason: '' };
    const open = ['ready', 'in_progress', 'rejected_evidence', 'not_ready', 'evidence_submitted'].includes(m.status);
    return (
      <div key={m.milestoneId} style={{ borderTop: 'var(--hairline) solid var(--color-border)', paddingTop: 'var(--space-3)' }}>
        <Stack gap={2}>
          <Inline gap={2}>
            <strong>{m.seq}. {m.title}</strong>
            <StatusChip tone={TONE[m.status]}>{WORDS[m.status]}</StatusChip>
          </Inline>
          <p style={{ font: 'var(--text-caption)', color: m.forecastDate > m.plannedDate ? 'var(--status-attention-fg)' : 'var(--color-text-muted)' }}>
            Planned {m.plannedDate}
            {m.forecastDate !== m.plannedDate ? ` · now forecast ${m.forecastDate}` : ''}
            {m.actualDate ? ` · done ${m.actualDate}` : ''} · evidence: {m.evidencePolicy === 'none' ? 'not required' : `${m.minEvidence} ${m.evidencePolicy}${m.minEvidence === 1 ? '' : 's'}`}
          </p>
          {m.status === 'rejected_evidence' && m.decisionReason ? <Callout tone="blocked" title="JobWork asked for more">{m.decisionReason}</Callout> : null}
          {m.evidence.length > 0 ? (
            <ul style={{ listStyle: 'none', font: 'var(--text-caption)' }}>
              {m.evidence.map((e) => (
                <li key={e.evidenceId}>
                  {e.filename} · submitted {e.submittedAt.slice(0, 10)}
                  {e.flagged ? ' · under review' : ''}
                </li>
              ))}
            </ul>
          ) : null}
          {m.status === 'ready' ? (
            <CommandButton size="sm" receiptLabel="Started" onCommand={() => act(`/supplier/milestones/${m.milestoneId}/start`, { expectedVersion: m.aggregateVersion })}>
              Start
            </CommandButton>
          ) : null}
          {m.status === 'in_progress' || m.status === 'rejected_evidence' ? (
            <Stack gap={2}>
              {m.evidencePolicy !== 'none' ? (
                <FileUpload
                  purpose={m.evidencePolicy === 'photo' ? 'image' : 'certificate'}
                  api={uploadApi}
                  resumeKey={`evidence-${m.milestoneId}`}
                  onSettled={(v: VersionState) => {
                    if (v.status === 'available') setUploaded((u) => ({ ...u, [m.milestoneId]: [...(u[m.milestoneId] ?? []), v.documentVersionId] }));
                  }}
                />
              ) : null}
              <CommandButton
                size="sm"
                receiptLabel="Submitted"
                disabled={m.evidencePolicy !== 'none' && files.length + m.evidence.length < m.minEvidence}
                disabledReason="Upload the evidence first"
                onCommand={async () => {
                  await act(`/supplier/milestones/${m.milestoneId}/evidence`, {
                    expectedVersion: m.aggregateVersion,
                    items: files.length > 0 ? files.map((documentVersionId) => ({ documentVersionId })) : [],
                  });
                  setUploaded((u) => ({ ...u, [m.milestoneId]: [] }));
                }}
              >
                Submit for verification
              </CommandButton>
            </Stack>
          ) : null}
          {open && wp?.released ? (
            <details>
              <summary style={{ font: 'var(--text-caption)', cursor: 'pointer' }}>Report a delay</summary>
              <Stack gap={2}>
                <Inline gap={2}>
                  <TextInput label="New forecast date" type="date" value={d.date} onChange={(e) => setDelay({ ...delay, [m.milestoneId]: { ...d, date: e.target.value } })} />
                  <Select
                    label="Cause"
                    value={d.code}
                    options={[
                      { value: 'machine', label: 'Machine' },
                      { value: 'material', label: 'Material' },
                      { value: 'labour', label: 'Labour' },
                      { value: 'quality', label: 'Quality' },
                      { value: 'other', label: 'Other' },
                    ]}
                    onChange={(e) => setDelay({ ...delay, [m.milestoneId]: { ...d, code: e.target.value } })}
                  />
                </Inline>
                <TextArea label="What happened" rows={2} value={d.reason} onChange={(e) => setDelay({ ...delay, [m.milestoneId]: { ...d, reason: e.target.value } })} />
                <CommandButton
                  size="sm"
                  variant="secondary"
                  receiptLabel="Reported"
                  disabled={d.reason.trim().length < 3}
                  disabledReason="Say what happened"
                  onCommand={async () => {
                    await api(`/milestones/${m.milestoneId}/delay`, { method: 'POST', body: { expectedVersion: m.aggregateVersion, forecastDate: d.date, reasonCode: d.code, reason: d.reason.trim() } });
                    await load();
                  }}
                >
                  Report delay
                </CommandButton>
              </Stack>
            </details>
          ) : null}
        </Stack>
      </div>
    );
  };

  return (
    <Stack gap={4}>
      {notice ? (
        <Callout tone="blocked" assertive title={notice.problem.title}>
          {notice.problem.detail ?? ''}
        </Callout>
      ) : null}

      <Card title="Drawing pack" description="The exact files JobWork released for this order. Make the parts to these versions only.">
        {!t ? (
          <p style={{ color: 'var(--color-text-muted)' }}>JobWork has not transmitted the technical baseline yet.</p>
        ) : (
          <Stack gap={3}>
            <Inline gap={2}>
              <span className="mono">{t.number}</span>
              <StatusChip tone={t.status === 'acknowledged' ? 'positive' : 'attention'}>{t.status === 'acknowledged' ? 'Acknowledged' : `Acknowledge by ${t.acknowledgmentDueAt.slice(0, 10)}`}</StatusChip>
            </Inline>
            <ul style={{ listStyle: 'none', display: 'grid', gap: 'var(--space-2)' }}>
              {t.items.map((item) => (
                <li key={item.documentVersionId} style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-3)', alignItems: 'center' }}>
                  <span>
                    <strong>{item.title}</strong> v{item.versionNo}
                    <span style={{ display: 'block', font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>
                      {item.purpose} · {item.filename}
                    </span>
                  </span>
                  <Button size="sm" variant="secondary" onClick={() => void download(item.documentVersionId).catch(() => undefined)}>
                    Download
                  </Button>
                </li>
              ))}
            </ul>
            <CopyableId label="Manifest hash" value={t.manifestHash} />
            {t.status === 'issued' ? (
              <Stack gap={2}>
                <p style={{ font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>Downloading is not acknowledgment. Acknowledge to confirm you will manufacture to exactly these versions.</p>
                <TextArea label="Note to JobWork (optional)" rows={2} value={ackNote} onChange={(e) => setAckNote(e.target.value)} />
                <CommandButton receiptLabel="Acknowledged" onCommand={() => act(`/supplier/transmittals/${t.transmittalId}/acknowledge`, { expectedVersion: t.aggregateVersion, note: ackNote.trim() })}>
                  Acknowledge drawing pack
                </CommandButton>
              </Stack>
            ) : null}
          </Stack>
        )}
      </Card>

      <Card title="Production checkpoints" description="Start each step, upload its evidence, and JobWork verifies it.">
        {!wp ? (
          <p style={{ color: 'var(--color-text-muted)' }}>JobWork has not planned this work yet.</p>
        ) : (
          <Stack gap={3}>
            {!wp.released ? (
              <Callout tone="attention" title="Not released to production">
                Do not cut material or run parts yet. JobWork releases the work once the drawing pack is acknowledged and every check passes. An attempt to start before release is recorded.
              </Callout>
            ) : (
              <p style={{ font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>
                {wp.number} · {wp.plannedStart} to {wp.plannedFinish} · {wp.status.replace(/_/g, ' ')}
              </p>
            )}
            {wp.milestones.map(milestoneCard)}
          </Stack>
        )}
      </Card>
    </Stack>
  );
}
