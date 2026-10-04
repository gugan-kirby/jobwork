'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  Card,
  EmptyState,
  FileUpload,
  LiveRegion,
  LoadingState,
  ManifestHeader,
  ManifestRow,
  Page,
  Select,
  Stack,
  type VersionState,
} from '@jobwork/ui';
import type {
  DocumentManifest,
  DocumentPurpose,
  DocumentSummary,
  DocumentVersionSummary,
  DownloadResponse,
} from '@jobwork/contracts';
import { api, ApiError } from '../../lib/api';
import { createUploadApi } from '../../lib/upload-api';
import { safeReturnTo } from '../../lib/return-to';

const PURPOSES: DocumentPurpose[] = ['drawing_2d', 'cad_3d', 'bom', 'specification', 'certificate'];

export default function DocumentsPage(): React.JSX.Element {
  // useSearchParams needs a boundary: without it the whole route opts out of
  // prerendering (Next.js App Router rule).
  return (
    <Suspense fallback={<Page title="Documents" width="narrow"><LoadingState label="Loading" /></Page>}>
      <DocumentsLibrary />
    </Suspense>
  );
}

function DocumentsLibrary(): React.JSX.Element {
  const returnTo = safeReturnTo(useSearchParams().get('returnTo'));
  const [documents, setDocuments] = useState<DocumentSummary[] | null>(null);
  const [manifests, setManifests] = useState<Record<string, DocumentManifest>>({});
  const [purpose, setPurpose] = useState<DocumentPurpose>('drawing_2d');
  const [anonymous, setAnonymous] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadManifest = useCallback(async (documentId: string) => {
    const manifest = await api<DocumentManifest>(`/documents/${documentId}/manifest`);
    setManifests((current) => ({ ...current, [documentId]: manifest }));
  }, []);

  const refresh = useCallback(async () => {
    try {
      const { documents: list } = await api<{ documents: DocumentSummary[] }>('/documents');
      setDocuments(list);
      await Promise.all(list.map((doc) => loadManifest(doc.documentId)));
    } catch (err) {
      if (err instanceof ApiError && err.problem.status === 401) setAnonymous(true);
      else throw err;
    }
  }, [loadManifest]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // One upload surface for the whole portal; the manifest the poll already fetched is
  // reused so this page stays current without a second round trip.
  const uploadApi = createUploadApi((manifest) =>
    setManifests((current) => ({ ...current, [manifest.document.documentId]: manifest })),
  );

  async function download(version: DocumentVersionSummary): Promise<void> {
    setDownloading(version.documentVersionId);
    setNotice(null);
    try {
      const grant = await api<DownloadResponse>(
        `/documents/versions/${version.documentVersionId}/download`,
      );
      // The capability points at storage, not at this origin, and carries an
      // attachment disposition — the browser saves it rather than rendering it.
      window.location.assign(grant.url);
    } catch (err) {
      setNotice(
        err instanceof ApiError
          ? `${err.problem.title} (${err.problem.code})`
          : 'Download could not be prepared.',
      );
    } finally {
      setDownloading(null);
    }
  }

  function onSettled(version: VersionState): void {
    void refresh();
    setNotice(
      version.status === 'available'
        ? 'Upload complete and scanned clean.'
        : 'The scan refused that file; it is quarantined and cannot be shared.',
    );
  }

  if (anonymous) {
    return (
      <Page title="Documents" width="narrow" {...(returnTo ? { breadcrumb: backLink(returnTo) } : {})}>
        <Card>
          <p>
            <Link href="/login">Sign in</Link> to see your documents.
          </p>
        </Card>
      </Page>
    );
  }

  return (
    <Page
      title="Documents"
      description="Every file is scanned before it can be shared or downloaded, and each upload becomes a new immutable version."
      {...(returnTo ? { breadcrumb: backLink(returnTo) } : {})}
    >
      <Stack gap={4}>
        <Card title="Upload a file">
          <Select
            label="What are you uploading?"
            value={purpose}
            options={PURPOSES.map((p) => ({ value: p, label: p.replace(/_/g, ' ') }))}
            onChange={(event) => setPurpose(event.target.value as DocumentPurpose)}
          />
          <FileUpload purpose={purpose} api={uploadApi} onSettled={onSettled} />
        </Card>

        {notice ? <LiveRegion message={notice} /> : null}

        {documents === null ? (
          <Card>
            <LoadingState label="Loading your documents" />
          </Card>
        ) : documents.length === 0 ? (
          <Card>
            <EmptyState
              title="No documents yet"
              detail="Upload a drawing, model or specification above. It appears here once the safety scan finishes — until then it cannot be shared or attached to an enquiry."
            />
          </Card>
        ) : (
          documents.map((doc) => (
            <Card
              key={doc.documentId}
              title={doc.title}
              description={`${doc.logicalType.replace(/_/g, ' ')} · ${doc.classification}`}
              flush
            >
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <caption className="jw-visually-hidden">
                    Versions of {doc.title}, newest first
                  </caption>
                  <thead>
                    <ManifestHeader />
                  </thead>
                  <tbody>
                    {(manifests[doc.documentId]?.versions ?? []).map((version) => (
                      <ManifestRow
                        key={version.documentVersionId}
                        version={version}
                        onDownload={(v) => void download(v)}
                        downloading={downloading === version.documentVersionId}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ))
        )}
      </Stack>
    </Page>
  );
}

/** Whoever sent the reader here said where they came from; this takes them back. */
function backLink(returnTo: string): React.JSX.Element {
  return <Link href={returnTo}>← Back to your enquiry</Link>;
}
