import { DomainError } from '../../../platform/http/domain-error';

export class UploadPolicyRejected extends DomainError {
  constructor(detail: string) {
    super('UPLOAD_POLICY_REJECTED', 422, 'File rejected by upload policy', detail);
  }
}

export class UploadSessionInvalid extends DomainError {
  constructor(detail?: string) {
    super(
      'UPLOAD_SESSION_INVALID',
      410,
      'Upload session is no longer usable',
      detail ?? 'Start the upload again.',
    );
  }
}

/**
 * The bytes in the store do not match what the caller declared, or never arrived.
 * Nothing is recorded as a usable document version — fail closed (doc 09 §4).
 */
export class UploadVerificationFailed extends DomainError {
  constructor(detail: string) {
    super('UPLOAD_VERIFICATION_FAILED', 409, 'Uploaded file failed verification', detail);
  }
}

export class DocumentNotFound extends DomainError {
  constructor() {
    super('DOCUMENT_NOT_FOUND', 404, 'Document not found');
  }
}

export class FileObjectNotFound extends DomainError {
  constructor() {
    super('FILE_OBJECT_NOT_FOUND', 404, 'File object not found');
  }
}

/**
 * A settled scan verdict is not overwritten in place: changing one is a revocation
 * decision with its own trail (doc 11 §8), not a second opinion from a retry.
 */
export class ScanVerdictConflict extends DomainError {
  constructor(current: string, attempted: string) {
    super(
      'SCAN_VERDICT_CONFLICT',
      409,
      'File already carries a scan verdict',
      `Recorded ${current}; refused ${attempted}.`,
    );
  }
}

/**
 * `BR-ENG-08`: quarantined, failed-scan, unsupported, or revoked content is never
 * released or downloaded, whoever asks.
 */
export class ContentNotReleasable extends DomainError {
  constructor(versionStatus: string, scanState: string) {
    super(
      'CONTENT_NOT_RELEASABLE',
      409,
      'This file cannot be released',
      `Version is ${versionStatus} and its scan state is ${scanState}.`,
    );
  }
}
