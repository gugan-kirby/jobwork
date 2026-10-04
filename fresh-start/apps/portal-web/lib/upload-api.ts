'use client';

import type {
  DocumentManifest,
  InitiateUploadResponse,
  UploadSessionStatus,
} from '@jobwork/contracts';
import type { FileUploadApi } from '@jobwork/ui';
import { api } from './api';

/**
 * The narrow surface `FileUpload` talks to, in one place: the documents library and the
 * enquiry wizard upload the same way, so an upload started inside a flow is the same
 * document — same session, same scan, same version lineage — as one started outside it.
 *
 * `onManifest` lets a caller keep whatever it renders in step with the version poll it
 * is already paying for, instead of listing documents again on every tick.
 */
export function createUploadApi(
  onManifest?: (manifest: DocumentManifest) => void,
): FileUploadApi {
  return {
    initiate: (body, idempotencyKey) =>
      api<InitiateUploadResponse>('/documents/uploads', {
        method: 'POST',
        body,
        idempotencyKey,
      }),
    finalize: (uploadSessionId, body, idempotencyKey) =>
      api<{ documentId: string; documentVersionId: string; versionNo: number }>(
        `/documents/uploads/${uploadSessionId}/finalize`,
        { method: 'POST', body, idempotencyKey },
      ),
    session: (uploadSessionId) =>
      api<UploadSessionStatus>(`/documents/uploads/${uploadSessionId}`),
    version: async (documentId, documentVersionId) => {
      const manifest = await api<DocumentManifest>(`/documents/${documentId}/manifest`);
      onManifest?.(manifest);
      const version = manifest.versions.find((v) => v.documentVersionId === documentVersionId);
      return version
        ? {
            documentId,
            documentVersionId,
            versionNo: version.versionNo,
            status: version.status,
            scanState: version.scanState,
          }
        : null;
    },
  };
}
