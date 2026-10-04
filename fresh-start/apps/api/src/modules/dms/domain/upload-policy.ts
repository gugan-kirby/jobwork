import type { DocumentPurpose } from '@jobwork/contracts';
import { UPLOAD_POLICY } from '@jobwork/contracts';
import { UploadPolicyRejected } from './errors';

/**
 * Server-side enforcement of the shared purpose policy (`UPLOAD_POLICY` in
 * `@jobwork/contracts`, doc 09 §4). Declared type and extension are *guidance*
 * checked at the edge so obvious mistakes fail fast and cheap; the binding verdict
 * comes from content inspection in the scan worker (F-03.3), which may still
 * quarantine anything this admits.
 */

const MB = 1024 * 1024;


/** Filenames are caller-controlled: no path separators, no control characters. */
export function safeFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (cleaned === '' || cleaned === '.' || cleaned === '..') {
    throw new UploadPolicyRejected('Filename is not usable');
  }
  return cleaned.slice(0, 255);
}

export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(dot + 1).toLowerCase() : '';
}

export function assertUploadAllowed(input: {
  purpose: DocumentPurpose;
  filename: string;
  declaredMediaType: string;
  byteSize: number;
}): void {
  const policy = UPLOAD_POLICY[input.purpose];
  if (input.byteSize > policy.maxBytes) {
    throw new UploadPolicyRejected(
      `${input.purpose} files are limited to ${Math.floor(policy.maxBytes / MB)} MB`,
    );
  }
  const mediaType = input.declaredMediaType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!policy.mediaTypes.includes(mediaType)) {
    throw new UploadPolicyRejected(
      `Content type ${mediaType} is not accepted for ${input.purpose}`,
    );
  }
  const extension = extensionOf(input.filename);
  if (!policy.extensions.includes(extension)) {
    throw new UploadPolicyRejected(
      `Files for ${input.purpose} must be one of: ${policy.extensions.join(', ')}`,
    );
  }
}
