import { randomBytes, randomUUID } from 'node:crypto';

interface Sql {
  query(sql: string, args?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/**
 * Stages what F-FP.5 asks for before a customer file reaches a supplier: JobWork's clean copy of
 * it, prepared by one member and confirmed by another (`dms.supplier_copy`). Seeded as rows, like
 * every fixture that is the stage rather than the play; `fixed-price.api.spec.ts` drives the real
 * commands. Returns the copy's version id.
 */
/** A clean, available file JobWork uploaded (internal-owned), as finalize would leave it. Returns its version id. */
export async function stageJobWorkFile(pg: Sql, filename = 'supplier-copy.pdf'): Promise<string> {
  const internal = (await pg.query(`SELECT id FROM iam.organization WHERE type = 'internal' ORDER BY created_at LIMIT 1`)).rows[0]!['id'] as string;
  const doc = (await pg.query(`INSERT INTO dms.document (owning_organization_id, logical_type, title) VALUES ($1, 'drawing_2d', 'Supplier copy') RETURNING id`, [internal])).rows[0]!['id'] as string;
  const file = (
    await pg.query(`INSERT INTO dms.file_object (storage_key, byte_size, declared_media_type, sha256, scan_state, owning_organization_id) VALUES ($1, 2048, 'application/pdf', $2, 'clean', $3) RETURNING id`, [
      `clean/${randomBytes(8).toString('hex')}`,
      randomBytes(32).toString('hex'),
      internal,
    ])
  ).rows[0]!['id'] as string;
  const version = (await pg.query(`INSERT INTO dms.document_version (document_id, version_no, file_object_id, original_filename, status, created_by) VALUES ($1, 1, $2, $3, 'available', gen_random_uuid()) RETURNING id`, [doc, file, filename])).rows[0]!['id'] as string;
  await pg.query(`UPDATE dms.document SET current_version_no = 1 WHERE id = $1`, [doc]);
  return version;
}

export async function stageSupplierCopy(pg: Sql, sourceVersionId: string, filename = 'supplier-copy.pdf'): Promise<string> {
  const copy = await stageJobWorkFile(pg, filename);
  await pg.query(`INSERT INTO dms.supplier_copy (source_version_id, copy_version_id, prepared_by, confirmed_by, confirmed_at, confirm_note) VALUES ($1, $2, $3, $4, now(), 'staged')`, [sourceVersionId, copy, randomUUID(), randomUUID()]);
  return copy;
}
