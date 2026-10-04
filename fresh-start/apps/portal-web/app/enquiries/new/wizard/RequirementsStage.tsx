'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import type {
  DocumentPurpose,
  DocumentSummary,
  EnquiryDocumentInput,
  EnquiryItemInput,
  Measurement,
} from '@jobwork/contracts';
import {
  Card,
  Checkbox,
  FileUpload,
  LiveRegion,
  MeasurementInput,
  Select,
  Stack,
  TextArea,
  TextInput,
  type VersionState,
} from '@jobwork/ui';
import { createUploadApi } from '../../../../lib/upload-api';
import type { DraftApi } from './useDraft';
import { attachability } from './types';

/**
 * Stage 2 — Requirements (prototype tile 6): the drawing, the specifications, and the
 * quality and delivery requirements. Upload stays inside the enquiry: a file attaches
 * itself as soon as the scan clears, so nobody uploads a drawing and then forgets to
 * tick it.
 */

const UPLOAD_PURPOSES: DocumentPurpose[] = ['drawing_2d', 'cad_3d', 'bom', 'specification', 'certificate'];

export interface RequirementsStageProps {
  api: DraftApi;
  documents: DocumentSummary[];
  reloadDocuments: () => Promise<DocumentSummary[]>;
  libraryHref: string;
  issueFor: (prefix: string) => string | undefined;
}

export function RequirementsStage({
  api: draftApi,
  documents,
  reloadDocuments,
  libraryHref,
  issueFor,
}: RequirementsStageProps): React.JSX.Element {
  const { draft, edit, editItem, update } = draftApi;
  const [uploadPurpose, setUploadPurpose] = useState<DocumentPurpose>('drawing_2d');
  const [uploadNotice, setUploadNotice] = useState<string | null>(null);
  const uploadApi = useMemo(() => createUploadApi(), []);

  /** Attaching is a draft edit like any other, so it saves the same way. */
  function setAttached(documentVersionId: string, attached: boolean): void {
    update((current) => ({
      ...current,
      documents: attached
        ? current.documents.some((d) => d.documentVersionId === documentVersionId)
          ? current.documents
          : [...current.documents, { documentVersionId, role: 'reference', note: '' }]
        : current.documents.filter((d) => d.documentVersionId !== documentVersionId),
    }));
  }

  async function onUploadSettled(settled: VersionState): Promise<void> {
    await reloadDocuments();
    if (settled.status === 'available') {
      setAttached(settled.documentVersionId, true);
      setUploadNotice('Scanned clean and attached to this enquiry.');
    } else {
      setUploadNotice('The scan refused that file, so it was not attached. Upload a clean copy instead.');
    }
  }

  const multi = draft.items.length > 1;

  return (
    <Stack gap={4}>
      <Card
        title="Upload drawing"
        description="PDF, DWG, STEP or an image. Every file is scanned before it can be shared, and it attaches itself to this enquiry as soon as the scan clears."
      >
        <Select
          label="What are you uploading?"
          value={uploadPurpose}
          options={UPLOAD_PURPOSES.map((purpose) => ({ value: purpose, label: purpose.replace(/_/g, ' ') }))}
          onChange={(event) => setUploadPurpose(event.target.value as DocumentPurpose)}
        />
        <FileUpload
          purpose={uploadPurpose}
          api={uploadApi}
          onSettled={(settled) => void onUploadSettled(settled)}
          resumeKey="jobwork.upload.resume.enquiry"
        />
        {uploadNotice ? <LiveRegion message={uploadNotice} /> : null}

        {documents.length > 0 ? (
          <ul style={{ listStyle: 'none', marginTop: 'var(--space-3)' }}>
            {documents.map((doc) => {
              const { versionId, reason } = attachability(doc);
              const attached = versionId ? draft.documents.find((d) => d.documentVersionId === versionId) : undefined;
              return (
                <li
                  key={doc.documentId}
                  style={{
                    display: 'flex',
                    gap: 'var(--space-3)',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    padding: 'var(--space-2) 0',
                    borderTop: 'var(--hairline) solid var(--color-border)',
                  }}
                >
                  <Checkbox
                    label={`${doc.title} (${doc.logicalType.replace(/_/g, ' ')})`}
                    checked={Boolean(attached)}
                    disabled={versionId === null}
                    onChange={(event) => {
                      if (!versionId) return;
                      setAttached(versionId, event.target.checked);
                    }}
                  />
                  {reason ? (
                    <span style={{ font: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>{reason}</span>
                  ) : null}
                  {attached ? (
                    <Select
                      label="Role"
                      value={attached.role}
                      options={[
                        { value: 'reference', label: 'Reference' },
                        { value: 'governing', label: 'Governing document' },
                        { value: 'assisted_photo', label: 'Photo (assisted intake)' },
                      ]}
                      onChange={(event) =>
                        update((current) => ({
                          ...current,
                          documents: current.documents.map((d) =>
                            d.documentVersionId === attached.documentVersionId
                              ? { ...d, role: event.target.value as EnquiryDocumentInput['role'] }
                              : d,
                          ),
                        }))
                      }
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}
        <p style={{ font: 'var(--text-caption)', marginTop: 'var(--space-2)' }}>
          Older versions and downloads live in your <Link href={libraryHref}>document library</Link>.
          If you attach both a 3D model and a 2D drawing, mark which one governs.
        </p>
        {issueFor('documents') ? (
          <p style={{ font: 'var(--text-caption)', color: 'var(--status-blocked-fg)' }}>{issueFor('documents')}</p>
        ) : null}
      </Card>

      {draft.items.map((item) => {
        return (
          <Card key={item.lineNo} title={multi ? `Part ${item.lineNo} — ${item.partName || 'unnamed'}` : 'Specifications'}>
            <TextArea
              label="Specifications / comments"
              placeholder="Enter specifications or any special requirements…"
              value={item.description}
              onChange={(event) => editItem(item.lineNo, { description: event.target.value })}
            />
            <TextInput
              label="Surface finish"
              placeholder="e.g. Anodised, Ra 1.6"
              value={item.surfaceFinish ?? ''}
              onChange={(event) => editItem(item.lineNo, { surfaceFinish: event.target.value })}
            />
            <TextInput
              label="Tolerance class"
              placeholder="e.g. IT8, ISO 2768-m"
              value={item.toleranceClass ?? ''}
              onChange={(event) => editItem(item.lineNo, { toleranceClass: event.target.value })}
            />
            <MeasurementInput
              label="Tightest tolerance"
              hint="Stored exactly as you write it. We never convert units silently."
              value={(item.criticalTolerance as Measurement | undefined) ?? null}
              onChange={(value) => editItem(item.lineNo, { criticalTolerance: value ?? undefined })}
            />
            <Select
              label="Inspection needed"
              hint="Asking for inspection now is cheaper than arguing about it at delivery."
              value={item.inspectionLevel}
              options={[
                { value: 'standard', label: 'Standard checks' },
                { value: 'dimensional_report', label: 'Dimensional report' },
                { value: 'first_article', label: 'First-article inspection' },
                { value: 'third_party', label: 'Third-party inspection' },
              ]}
              onChange={(event) =>
                editItem(item.lineNo, { inspectionLevel: event.target.value as EnquiryItemInput['inspectionLevel'] })
              }
            />
            <details>
              <summary style={{ cursor: 'pointer', font: 'var(--text-caption)', color: 'var(--color-action)' }}>
                Heat treatment, coating and material sourcing
              </summary>
              <TextInput
                label="Heat treatment"
                value={item.heatTreatment ?? ''}
                onChange={(event) => editItem(item.lineNo, { heatTreatment: event.target.value })}
              />
              <TextInput
                label="Coating"
                value={item.coating ?? ''}
                onChange={(event) => editItem(item.lineNo, { coating: event.target.value })}
              />
              <TextInput
                label="Material source restrictions"
                hint="Anything a supplier must honour about where the material comes from."
                placeholder="e.g. mill test certificate required"
                value={item.materialSourceRestriction ?? ''}
                onChange={(event) => editItem(item.lineNo, { materialSourceRestriction: event.target.value })}
              />
              <TextArea
                label="Quality notes"
                value={item.qualityNote}
                onChange={(event) => editItem(item.lineNo, { qualityNote: event.target.value })}
              />
            </details>
          </Card>
        );
      })}

      <Card title="When and how">
        <TextInput
          label="Required by"
          type="date"
          required
          value={draft.requiredByDate}
          error={issueFor('requiredByDate')}
          onChange={(event) => edit({ requiredByDate: event.target.value })}
        />
        <Select
          label="Confidentiality"
          value={draft.confidentiality}
          onChange={(event) => edit({ confidentiality: event.target.value as typeof draft.confidentiality })}
          options={[
            { value: 'standard', label: 'Standard' },
            { value: 'confidential', label: 'Confidential' },
            { value: 'nda_required', label: 'NDA required before any supplier sees it' },
          ]}
        />
        <details>
          <summary style={{ cursor: 'pointer', font: 'var(--text-caption)', color: 'var(--color-action)' }}>
            Partial delivery and packaging
          </summary>
          <Select
            label="Partial delivery"
            value={draft.partialDelivery}
            options={[
              { value: 'not_allowed', label: 'Deliver complete' },
              { value: 'allowed', label: 'Partial deliveries are acceptable' },
            ]}
            onChange={(event) => edit({ partialDelivery: event.target.value as typeof draft.partialDelivery })}
          />
          <TextArea
            label="Packaging notes"
            value={draft.packagingNote}
            onChange={(event) => edit({ packagingNote: event.target.value })}
          />
        </details>
      </Card>
    </Stack>
  );
}
