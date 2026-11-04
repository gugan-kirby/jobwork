'use client';

import { useMemo, useState } from 'react';
import type { DocumentSummary, EnquiryDocumentInput } from '@jobwork/contracts';
import { FileUpload, Icon, LiveRegion, Select, TextArea, type UploadFormats, type VersionState } from '@jobwork/ui';
import { createUploadApi } from '../../../../lib/upload-api';
import type { DraftApi } from './useDraft';
import { emptyItem, extensionOf, fileName } from './types';

/**
 * Stage 2 — Requirements (VF-17, reference screen 06): upload the drawing, specifications
 * or comments, surface finish, tolerance. A file attaches itself as soon as its scan
 * clears, so nobody uploads a drawing and then forgets to tick it.
 */

const MB = 1024 * 1024;

/** What the box takes; the extension decides the purpose, so the customer never classifies a file. */
const DRAWING_FORMATS: UploadFormats = {
  purposeByExtension: {
    pdf: 'drawing_2d',
    dwg: 'drawing_2d',
    step: 'cad_3d',
    stp: 'cad_3d',
    jpg: 'image',
    jpeg: 'image',
  },
  caption: 'PDF, DWG, STEP, JPG',
  maxBytes: 10 * MB,
};

const SURFACE_FINISHES = ['As machined', 'Anodized', 'Powder coated', 'Zinc plated', 'Nickel plated', 'Black oxide', 'Painted', 'Polished'];
const TOLERANCES = ['±0.01 mm', '±0.05 mm', '±0.1 mm', '±0.2 mm', '±0.5 mm', 'ISO 2768-f', 'ISO 2768-m', 'ISO 2768-c'];

/** The list, plus a value saved before the list existed, so an old draft keeps showing it. */
function choices(list: string[], current: string | undefined): Array<{ value: string; label: string }> {
  return [...(current && !list.includes(current) ? [current] : []), ...list].map((value) => ({ value, label: value }));
}

/** With several files the first governs, so a drawing and a CAD model never read as a conflict. */
function withRoles(documents: EnquiryDocumentInput[]): EnquiryDocumentInput[] {
  return documents.map((doc, index) => ({
    ...doc,
    role: documents.length > 1 && index === 0 ? 'governing' : 'reference',
  }));
}

export interface RequirementsStageProps {
  api: DraftApi;
  documents: DocumentSummary[];
  reloadDocuments: () => Promise<DocumentSummary[]>;
  issueFor: (prefix: string) => string | undefined;
}

export function RequirementsStage({
  api: draftApi,
  documents,
  reloadDocuments,
  issueFor,
}: RequirementsStageProps): React.JSX.Element {
  const { draft, editItem, update } = draftApi;
  const [uploadNotice, setUploadNotice] = useState<string | null>(null);
  const uploadApi = useMemo(() => createUploadApi(), []);
  const item = draft.items[0] ?? emptyItem(1);

  /** Attaching is a draft edit like any other, so it saves the same way. */
  function attach(documentVersionId: string): void {
    update((current) =>
      current.documents.some((d) => d.documentVersionId === documentVersionId)
        ? current
        : { ...current, documents: withRoles([...current.documents, { documentVersionId, role: 'reference', note: '' }]) },
    );
  }

  function detach(documentVersionId: string): void {
    update((current) => ({
      ...current,
      documents: withRoles(current.documents.filter((d) => d.documentVersionId !== documentVersionId)),
    }));
  }

  async function onUploadSettled(settled: VersionState): Promise<void> {
    await reloadDocuments();
    if (settled.status === 'available') {
      attach(settled.documentVersionId);
      setUploadNotice('Scanned clean and attached to this enquiry.');
    } else {
      setUploadNotice('The scan refused that file, so it was not attached. Upload a clean copy instead.');
    }
  }

  const documentsIssue = issueFor('documents');

  return (
    <div>
      <div style={{ marginBottom: 'var(--space-4)' }}>
        <p className="jw-field-heading">Upload Drawing</p>
        <FileUpload
          purpose="drawing_2d"
          formats={DRAWING_FORMATS}
          api={uploadApi}
          onSettled={(settled) => void onUploadSettled(settled)}
          resumeKey="jobwork.upload.resume.enquiry"
        />
        {uploadNotice ? <LiveRegion message={uploadNotice} /> : null}
        {draft.documents.length > 0 ? (
          <ul className="jw-attached" aria-label="Attached files">
            {draft.documents.map((entry) => {
              const title = fileName(documents.find((doc) => doc.currentVersionId === entry.documentVersionId));
              return (
                <li key={entry.documentVersionId}>
                  <span className="jw-file-badge" aria-hidden="true">
                    <span>{extensionOf(title)}</span>
                  </span>
                  {title}
                  <button type="button" aria-label={`Remove ${title}`} onClick={() => detach(entry.documentVersionId)}>
                    <Icon name="close" size={1.2} />
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
        {documentsIssue ? (
          <p style={{ font: 'var(--text-caption)', color: 'var(--status-blocked-fg)', marginTop: 'var(--space-2)' }}>{documentsIssue}</p>
        ) : null}
      </div>

      <TextArea
        label="Specifications / Comments"
        placeholder="Enter specifications or any special requirements..."
        rows={4}
        value={item.description}
        onChange={(event) => editItem(item.lineNo, { description: event.target.value })}
      />
      <Select
        label="Surface Finish"
        placeholder="Select finish"
        value={item.surfaceFinish ?? ''}
        options={choices(SURFACE_FINISHES, item.surfaceFinish)}
        onChange={(event) => editItem(item.lineNo, { surfaceFinish: event.target.value })}
      />
      <Select
        label="Tolerance"
        placeholder="Select tolerance"
        value={item.toleranceClass ?? ''}
        options={choices(TOLERANCES, item.toleranceClass)}
        onChange={(event) => editItem(item.lineNo, { toleranceClass: event.target.value })}
      />
    </div>
  );
}
