'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import type { Certification, SupplierSelfView, VerificationItem } from '@jobwork/contracts';
import {
  Callout,
  Card,
  CommandButton,
  ErrorState,
  FileUpload,
  Inline,
  LiveRegion,
  LoadingState,
  Page,
  Stack,
  StatusChip,
  TextInput,
  type Tone,
  type VersionState,
} from '@jobwork/ui';
import { api, ApiError } from '../../../lib/api';
import { createUploadApi } from '../../../lib/upload-api';

/**
 * Evidence (F-SO.6, doc 06 §14). Each item is uploaded, submitted and decided in place:
 * nothing here sends the supplier to another page to find a file, because a compliance
 * step that leaves the flow is a compliance step that does not get finished.
 *
 * The wording is deliberately concrete about Indian practice — GST, PAN, a cancelled
 * cheque, Udyam — because "supporting documentation" tells a workshop nothing.
 */

interface EvidenceKind {
  kind: string;
  label: string;
  detail: string;
  mandatory: boolean;
  referenceLabel: string | null;
  referenceHint?: string;
}

const EVIDENCE: EvidenceKind[] = [
  {
    kind: 'gst',
    label: 'GST registration',
    detail: 'Your GST registration certificate. We check the GSTIN against the certificate.',
    mandatory: true,
    referenceLabel: 'GSTIN',
    referenceHint: '15 characters, e.g. 33AABCU9603R1ZM',
  },
  {
    kind: 'pan',
    label: 'PAN',
    detail: 'The company PAN card. The PAN must belong to the same legal entity as the GSTIN.',
    mandatory: true,
    referenceLabel: 'PAN',
    referenceHint: '10 characters, e.g. AABCU9603R',
  },
  {
    kind: 'bank_account',
    label: 'Bank account',
    detail: 'A cancelled cheque or bank letter showing the account payments will reach.',
    mandatory: true,
    referenceLabel: 'Account number',
  },
  {
    kind: 'udyam',
    label: 'Udyam (MSME) registration',
    detail:
      'Optional, but worth sending: a registered micro or small enterprise is paid under the 45-day MSME rule.',
    mandatory: false,
    referenceLabel: 'Udyam number',
  },
  {
    kind: 'address_proof',
    label: 'Address proof',
    detail: 'Electricity bill, rent agreement or property document for the works address.',
    mandatory: false,
    referenceLabel: null,
  },
];

function statusTone(status: VerificationItem['status']): Tone {
  if (status === 'verified') return 'positive';
  if (status === 'expiring') return 'attention';
  if (['expired', 'revoked', 'returned_for_evidence'].includes(status)) return 'blocked';
  return 'progress';
}

/** Whole days from now until an ISO date; negative once it has passed. */
function daysLeft(expiresAt: string): number {
  return Math.floor((new Date(expiresAt).getTime() - Date.now()) / 86_400_000);
}

function statusLabel(item: VerificationItem | undefined): string {
  if (!item) return 'Not sent';
  return item.status.replace(/_/g, ' ');
}

export default function SupplierCompliancePage(): React.JSX.Element {
  const [view, setView] = useState<SupplierSelfView | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [references, setReferences] = useState<Record<string, string>>({});
  const [uploaded, setUploaded] = useState<Record<string, VersionState>>({});
  const [certificate, setCertificate] = useState({
    certificationType: 'ISO 9001',
    certificateNumber: '',
    issuer: '',
    expiresOn: '',
  });
  const [certificateEvidence, setCertificateEvidence] = useState<VersionState | null>(null);

  const uploadApi = useMemo(() => createUploadApi(), []);

  const load = useCallback(async () => {
    setError(null);
    try {
      const next = await api<SupplierSelfView>('/suppliers/me');
      setView(next);
      setReferences((current) => {
        const merged = { ...current };
        for (const item of next.verification) {
          if (item.referenceValue && !merged[item.kind]) merged[item.kind] = item.referenceValue;
        }
        return merged;
      });
    } catch (err) {
      if (err instanceof ApiError) setError(err);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error && !view) {
    return (
      <Page title="Compliance">
        <ErrorState message={error.problem.detail ?? error.problem.title} code={error.problem.code} />
      </Page>
    );
  }

  if (!view) {
    return (
      <Page title="Compliance">
        <Card>
          <LoadingState label="Loading your evidence" />
        </Card>
      </Page>
    );
  }

  // Newest version per kind: the list arrives ordered, so the first is current.
  const latest = new Map<string, VerificationItem>();
  for (const item of view.verification) if (!latest.has(item.kind)) latest.set(item.kind, item);

  const certifications: Certification[] = view.certifications;

  return (
    <Page
      title="Compliance"
      breadcrumb={<Link href="/supplier">← Your account</Link>}
      description="Upload each document here and send it for checking. Files are scanned before anyone can open them, and only JobWork sees them."
    >
      <Stack gap={4}>
        {notice ? <LiveRegion message={notice} /> : null}
        {error ? (
          <Callout tone="blocked" assertive title={error.problem.title}>
            {error.problem.detail ?? 'That did not go through.'} ({error.problem.code})
          </Callout>
        ) : null}

        {EVIDENCE.map((evidence) => {
          const item = latest.get(evidence.kind);
          const pending = item?.status === 'submitted' || item?.status === 'under_review';
          const staged = uploaded[evidence.kind];
          return (
            <Card
              key={evidence.kind}
              title={`${evidence.label}${evidence.mandatory ? '' : ' (optional)'}`}
              description={evidence.detail}
            >
              <Inline gap={3}>
                <StatusChip tone={item ? statusTone(item.status) : 'neutral'}>
                  {statusLabel(item)}
                </StatusChip>
                {item?.expiresAt ? (
                  <span
                    style={{
                      font: 'var(--text-caption)',
                      color:
                        daysLeft(item.expiresAt) <= 45
                          ? 'var(--status-attention-fg)'
                          : 'var(--color-text-muted)',
                    }}
                  >
                    {daysLeft(item.expiresAt) < 0
                      ? `expired ${item.expiresAt.slice(0, 10)}`
                      : `valid to ${item.expiresAt.slice(0, 10)} · ${daysLeft(item.expiresAt)} days left`}
                  </span>
                ) : null}
              </Inline>

              {item?.expiresAt && daysLeft(item.expiresAt) <= 45 ? (
                <Callout
                  tone={daysLeft(item.expiresAt) < 0 ? 'blocked' : 'attention'}
                  title={
                    daysLeft(item.expiresAt) < 0
                      ? 'This has lapsed — you are out of matching until it is renewed'
                      : 'Renew this before it lapses'
                  }
                >
                  Upload the renewed document below and send it. Renewing before the date means
                  you never leave matching; renewing after it means a gap.
                </Callout>
              ) : null}

              {item?.status === 'returned_for_evidence' && item.reviewReason ? (
                <Callout tone="attention" title="Returned for better evidence">
                  {item.reviewReason}
                </Callout>
              ) : null}

              {evidence.referenceLabel ? (
                <TextInput
                  label={evidence.referenceLabel}
                  {...(evidence.referenceHint ? { hint: evidence.referenceHint } : {})}
                  value={references[evidence.kind] ?? ''}
                  onChange={(e) =>
                    setReferences({ ...references, [evidence.kind]: e.target.value })
                  }
                />
              ) : null}

              <FileUpload
                purpose="certificate"
                api={uploadApi}
                resumeKey={`jobwork.upload.resume.${evidence.kind}`}
                onSettled={(version) => {
                  if (version.status === 'available') {
                    setUploaded((current) => ({ ...current, [evidence.kind]: version }));
                    setNotice(`${evidence.label}: scanned clean and ready to send.`);
                  } else {
                    setNotice(
                      `${evidence.label}: the scan refused that file. Upload a clean copy.`,
                    );
                  }
                }}
              />

              <CommandButton
                receiptLabel="Sent"
                // Sending an item with nothing attached costs the supplier a round trip
                // and the reviewer a queue entry they can only return. The document is
                // the submission.
                disabled={pending || (!staged && !item?.evidenceDocumentVersionId)}
                onCommand={async () => {
                  setError(null);
                  try {
                    await api('/suppliers/me/verification', {
                      method: 'POST',
                      body: {
                        kind: evidence.kind,
                        ...(references[evidence.kind]
                          ? { referenceValue: references[evidence.kind] }
                          : {}),
                        ...(staged
                          ? { evidenceDocumentVersionId: staged.documentVersionId }
                          : {}),
                      },
                      idempotencyKey: crypto.randomUUID(),
                    });
                    setNotice(`${evidence.label} sent to JobWork.`);
                    await load();
                  } catch (err) {
                    if (err instanceof ApiError) setError(err);
                    throw err;
                  }
                }}
              >
                {item ? 'Send again' : 'Send for checking'}
              </CommandButton>
              {pending ? (
                <p style={{ font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>
                  A reviewer has this one. You can send a replacement once they respond.
                </p>
              ) : !staged && !item?.evidenceDocumentVersionId ? (
                <p style={{ font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>
                  Upload the document above, then send it.
                </p>
              ) : null}
            </Card>
          );
        })}

        <Card
          title="Certifications"
          description="ISO 9001, IATF 16949, AS9100 and the like. A certification counts only once JobWork has verified the certificate."
        >
          {certifications.length > 0 ? (
            <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 var(--space-4) 0' }}>
              {certifications.map((cert) => (
                <li
                  key={cert.certificationId}
                  style={{
                    display: 'flex',
                    gap: 'var(--space-3)',
                    alignItems: 'baseline',
                    padding: 'var(--space-2) 0',
                    borderBottom: 'var(--hairline) solid var(--color-border)',
                  }}
                >
                  <StatusChip tone={cert.status === 'verified' ? 'positive' : 'progress'}>
                    {cert.status}
                  </StatusChip>
                  <span style={{ font: 'var(--text-body-strong)' }}>{cert.certificationType}</span>
                  <span style={{ color: 'var(--color-text-muted)' }}>
                    {cert.certificateNumber ?? '—'}
                    {cert.expiresOn ? ` · expires ${cert.expiresOn}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          <TextInput
            label="Certification"
            required
            value={certificate.certificationType}
            onChange={(e) => setCertificate({ ...certificate, certificationType: e.target.value })}
          />
          <TextInput
            label="Certificate number"
            value={certificate.certificateNumber}
            onChange={(e) => setCertificate({ ...certificate, certificateNumber: e.target.value })}
          />
          <TextInput
            label="Issued by"
            value={certificate.issuer}
            onChange={(e) => setCertificate({ ...certificate, issuer: e.target.value })}
          />
          <TextInput
            label="Expires on"
            hint="YYYY-MM-DD. We warn you before it lapses; an expired certificate stops matching."
            value={certificate.expiresOn}
            onChange={(e) => setCertificate({ ...certificate, expiresOn: e.target.value })}
          />
          <FileUpload
            purpose="certificate"
            api={uploadApi}
            resumeKey="jobwork.upload.resume.certification"
            onSettled={(version) => {
              if (version.status === 'available') {
                setCertificateEvidence(version);
                setNotice('Certificate scanned clean and ready to send.');
              } else {
                setNotice('The scan refused that certificate. Upload a clean copy.');
              }
            }}
          />
          <CommandButton
            receiptLabel="Sent"
            onCommand={async () => {
              setError(null);
              try {
                await api('/suppliers/me/certifications', {
                  method: 'POST',
                  body: {
                    certificationType: certificate.certificationType,
                    ...(certificate.certificateNumber
                      ? { certificateNumber: certificate.certificateNumber }
                      : {}),
                    ...(certificate.issuer ? { issuer: certificate.issuer } : {}),
                    ...(certificate.expiresOn ? { expiresOn: certificate.expiresOn } : {}),
                    ...(certificateEvidence
                      ? { evidenceDocumentVersionId: certificateEvidence.documentVersionId }
                      : {}),
                  },
                  idempotencyKey: crypto.randomUUID(),
                });
                setNotice('Certification sent to JobWork.');
                await load();
              } catch (err) {
                if (err instanceof ApiError) setError(err);
                throw err;
              }
            }}
          >
            Send certification
          </CommandButton>
        </Card>
      </Stack>
    </Page>
  );
}
