import { extensionOf } from './upload-policy';

/**
 * What a document is called outside the organization that owns it (F-FP.4; FR-305). An uploaded
 * file's name and its default title are the uploader's words — `KovaiPumps_bracket_rev2.pdf`
 * names the customer — so a supplier only ever meets JobWork's name for the version. The same
 * version has the same name in every view and download, and the original stays with its owner
 * and JobWork.
 */
export function neutralTitle(documentVersionId: string): string {
  return `JW-DOC-${documentVersionId.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

export function neutralFilename(documentVersionId: string, originalFilename: string): string {
  const extension = extensionOf(originalFilename);
  return extension ? `${neutralTitle(documentVersionId)}.${extension}` : neutralTitle(documentVersionId);
}
