import type { VerificationItem } from '@jobwork/contracts';
import type { VerificationItemRow } from '../infrastructure/supplier.repository';

/** One mapping from row to contract, shared by every command and query. */
export function toVerificationItem(row: VerificationItemRow): VerificationItem {
  return {
    verificationItemId: row.id,
    supplierProfileId: row.supplierProfileId,
    kind: row.kind,
    versionNo: row.versionNo,
    status: row.status,
    referenceValue: row.referenceValue,
    evidenceDocumentVersionId: row.evidenceDocumentVersionId,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
    reviewReason: row.reviewReason,
    createdAt: row.createdAt.toISOString(),
  };
}
