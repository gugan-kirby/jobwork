import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { AuditSpec, OutboxSpec } from '../../../platform/commands/command';

export interface DocumentRevisionInput {
  documentId: string;
  documentVersionId: string;
  versionNo: number;
  title: string;
  uploadedBy: string;
}

/** What a revision implies elsewhere, written in the upload's own transaction. */
export type DocumentRevisionHook = (input: DocumentRevisionInput, tx: PoolClient) => Promise<{ audit: AuditSpec[]; outbox: OutboxSpec[] }>;

/**
 * A new version of an existing document can matter to records this module does not own:
 * a released baseline that names the old version must open an engineering change
 * (`BR-ENG-05`, `FR-604`). The owning module registers here at start-up, so the upload
 * command never imports the module that depends on it (as the approval effect registry).
 */
@Injectable()
export class DocumentRevisionHooks {
  private readonly hooks: DocumentRevisionHook[] = [];

  register(hook: DocumentRevisionHook): void {
    this.hooks.push(hook);
  }

  async run(input: DocumentRevisionInput, tx: PoolClient): Promise<{ audit: AuditSpec[]; outbox: OutboxSpec[] }> {
    const audit: AuditSpec[] = [];
    const outbox: OutboxSpec[] = [];
    for (const hook of this.hooks) {
      const out = await hook(input, tx);
      audit.push(...out.audit);
      outbox.push(...out.outbox);
    }
    return { audit, outbox };
  }
}
