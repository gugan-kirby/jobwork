import { Injectable } from '@nestjs/common';
import { createLogger, type Logger } from '@jobwork/observability';
import type { FinalizeUploadRequest } from '@jobwork/contracts';
import { type Actor, requireOrganization, requireTransactionalStrength } from '../../iam';
import { VersionConflict } from '../../../platform/http/domain-error';
import {
  UploadSessionInvalid,
  UploadVerificationFailed,
} from '../domain/errors';
import { extensionOf } from '../domain/upload-policy';
import { DmsRepository } from '../infrastructure/dms.repository';
import { ObjectStore } from '../infrastructure/object-store';
import { AuditWriter } from '../../../platform/commands/audit.writer';
import { contextFromActor } from '../../../platform/commands/command';
import { CommandExecutor } from '../../../platform/commands/execute';

type FinalizeInput = FinalizeUploadRequest & {
  title?: string | undefined;
  engineeringRevision?: string | undefined;
  expectedVersion?: number | undefined;
};

export interface FinalizeUploadResult {
  documentId: string;
  documentVersionId: string;
  versionNo: number;
  status: 'processing' | 'available';
  scanState: string;
  deduplicated: boolean;
}

/**
 * finalize-upload (doc 08 §7 step 3). The bytes are already in quarantine; this asks
 * the store what actually landed and refuses to record anything that does not match
 * the declaration. On any mismatch the session is aborted and the object deleted —
 * a document version is never created from unverified bytes (doc 09 §4).
 *
 * Idempotent twice over: naturally, because a finalized session returns its own
 * result, and through the platform idempotency key when one is supplied.
 */
@Injectable()
export class FinalizeUploadCommand {
  private readonly log: Logger = createLogger({ service: 'api' }).child({ module: 'dms.upload' });

  constructor(
    private readonly repo: DmsRepository,
    private readonly store: ObjectStore,
    private readonly executor: CommandExecutor,
    private readonly audit: AuditWriter,
  ) {}

  async execute(
    actor: Actor,
    uploadSessionId: string,
    input: FinalizeInput,
    opts: { idempotencyKey?: string | undefined } = {},
  ): Promise<FinalizeUploadResult> {
    requireTransactionalStrength(actor);
    const organizationId = requireOrganization(actor);
    const ctx = contextFromActor({ userId: actor.userId, organizationId });

    const session = await this.repo.findUploadSession(uploadSessionId, organizationId);
    if (!session) throw new UploadSessionInvalid('Unknown upload session');

    if (session.status === 'finalized') {
      return this.replayFinalized(session.documentId, session.documentVersionId, organizationId);
    }
    if (session.status !== 'initiated') {
      throw new UploadSessionInvalid(`Session is ${session.status}`);
    }
    if (session.expiresAt.getTime() < Date.now()) {
      await this.reject(ctx, session.id, session.storageKey, 'session_expired');
      throw new UploadSessionInvalid('Upload window closed');
    }

    // The finalize declaration must repeat what the grant was issued for; a caller
    // cannot re-declare a different file after the fact.
    if (input.byteSize !== session.declaredByteSize) {
      await this.reject(ctx, session.id, session.storageKey, 'declared_size_mismatch');
      throw new UploadVerificationFailed('Declared size does not match the upload session');
    }

    const stored = await this.store.head('quarantine', session.storageKey);
    if (!stored) {
      await this.reject(ctx, session.id, session.storageKey, 'object_missing');
      throw new UploadVerificationFailed('No uploaded object found for this session');
    }
    if (stored.byteSize !== session.declaredByteSize) {
      await this.reject(ctx, session.id, session.storageKey, 'stored_size_mismatch');
      throw new UploadVerificationFailed('Stored object size does not match the declaration');
    }
    if (stored.sha256 !== null && stored.sha256 !== input.sha256) {
      await this.reject(ctx, session.id, session.storageKey, 'digest_mismatch');
      throw new UploadVerificationFailed('Stored object digest does not match the declaration');
    }
    if (stored.sha256 === null) {
      // The grant binds the digest, so the store rejects mismatched bytes at PUT time;
      // if it cannot report one back, the scan worker recomputes it from the bytes.
      this.log.warn(
        { uploadSessionId: session.id },
        'dms.store_checksum_unavailable',
      );
    }

    const outcome = await this.executor.execute(
      {
        operation: 'dms.finalize-upload',
        handler: async (tx, _ctx, cmd: FinalizeInput) => {
          const locked = await this.repo.lockUploadSession(session.id, organizationId, tx);
          if (!locked) throw new UploadSessionInvalid('Unknown upload session');
          if (locked.status === 'finalized') {
            const replayed = await this.replayFinalized(
              locked.documentId,
              locked.documentVersionId,
              organizationId,
            );
            return { result: replayed, audit: [] };
          }
          if (locked.status !== 'initiated') {
            throw new UploadSessionInvalid(`Session is ${locked.status}`);
          }

          // Same bytes already known to this organization: reuse the file object so
          // storage and scan verdicts stay single-sourced (doc 19 §3 same-bytes case).
          const existing = await this.repo.findFileByDigest(organizationId, cmd.sha256, tx);
          const file =
            existing ??
            (await this.repo.createFileObject(
              {
                storageKey: locked.storageKey,
                byteSize: locked.declaredByteSize,
                declaredMediaType: locked.declaredMediaType,
                sha256: cmd.sha256,
                organizationId,
                createdBy: actor.userId,
              },
              tx,
            ));
          if (existing && existing.byteSize !== locked.declaredByteSize) {
            throw new UploadVerificationFailed('Digest collides with a different stored size');
          }

          let documentId = locked.documentId;
          let supersedes: string | null = null;
          let nextVersionNo = 1;
          if (documentId) {
            const document = await this.repo.lockDocument(documentId, organizationId, tx);
            if (!document) throw new UploadSessionInvalid('Document is no longer available');
            if (
              cmd.expectedVersion !== undefined &&
              cmd.expectedVersion !== document.aggregateVersion
            ) {
              throw new VersionConflict();
            }
            nextVersionNo = document.currentVersionNo + 1;
            supersedes = await this.repo.latestVersionId(documentId, tx);
          } else {
            const created = await this.repo.createDocument(
              {
                organizationId,
                logicalType: locked.purpose,
                title: cmd.title?.trim() || titleFrom(locked.declaredFilename),
                createdBy: actor.userId,
              },
              tx,
            );
            documentId = created.id;
          }

          // Bytes already cleared for this organization release immediately; anything
          // else waits behind the scan (F-03.3) — a version is never born grantable.
          const versionStatus = file.scanState === 'clean' ? 'available' : 'processing';
          const version = await this.repo.appendVersion(
            {
              documentId,
              versionNo: nextVersionNo,
              fileObjectId: file.id,
              originalFilename: locked.declaredFilename,
              engineeringRevision: cmd.engineeringRevision?.trim() || null,
              supersedesVersionId: supersedes,
              status: versionStatus,
              createdBy: actor.userId,
            },
            tx,
          );
          await this.repo.advanceDocument(documentId, version.versionNo, tx);
          await this.repo.markSessionStatus(locked.id, 'finalized', tx, {
            documentId,
            documentVersionId: version.id,
          });

          const result: FinalizeUploadResult = {
            documentId,
            documentVersionId: version.id,
            versionNo: version.versionNo,
            status: versionStatus,
            scanState: file.scanState,
            deduplicated: existing !== null,
          };

          return {
            result,
            audit: [
              {
                action: 'dms.upload_finalized',
                subjectType: 'document_version',
                subjectId: version.id,
                subjectVersion: version.versionNo,
                data: {
                  documentId,
                  uploadSessionId: locked.id,
                  sha256: cmd.sha256,
                  byteSize: locked.declaredByteSize,
                  deduplicated: existing !== null,
                },
              },
            ],
            // Only newly stored bytes need scanning; reused ones already carry a verdict.
            outbox: existing
              ? []
              : [
                  {
                    eventType: 'dms.file_finalized',
                    aggregateType: 'file_object',
                    aggregateId: file.id,
                    data: {
                      fileObjectId: file.id,
                      documentVersionId: version.id,
                      storageKey: locked.storageKey,
                      byteSize: locked.declaredByteSize,
                      sha256: cmd.sha256,
                      declaredMediaType: locked.declaredMediaType,
                      purpose: locked.purpose,
                      extension: extensionOf(locked.declaredFilename),
                    },
                  },
                ],
          };
        },
      },
      ctx,
      input,
      opts,
    );

    // Deduplicated uploads leave a redundant quarantine object behind; drop it outside
    // the transaction so a store hiccup can never roll back committed business state.
    if (outcome.deduplicated) {
      await this.store.remove('quarantine', session.storageKey).catch((cause: unknown) => {
        this.log.warn(
          { uploadSessionId: session.id, err: String(cause) },
          'dms.duplicate_object_cleanup_failed',
        );
      });
    }
    return outcome;
  }

  private async replayFinalized(
    documentId: string | null,
    documentVersionId: string | null,
    organizationId: string,
  ): Promise<FinalizeUploadResult> {
    if (!documentId || !documentVersionId) {
      throw new UploadSessionInvalid('Finalized session is missing its document link');
    }
    const versions = await this.repo.listVersions(documentId, organizationId);
    const version = versions.find((v) => v.id === documentVersionId);
    if (!version) throw new UploadSessionInvalid('Finalized session is missing its document link');
    return {
      documentId,
      documentVersionId,
      versionNo: version.versionNo,
      status: version.status === 'available' ? 'available' : 'processing',
      scanState: version.scanState,
      deduplicated: false,
    };
  }

  /** Fail-closed path: session dies, bytes are deleted, the refusal is auditable. */
  private async reject(
    ctx: ReturnType<typeof contextFromActor>,
    sessionId: string,
    storageKey: string,
    reason: string,
  ): Promise<void> {
    await this.repo.markSessionStatus(sessionId, 'aborted');
    await this.audit.write(null, ctx, {
      action: 'dms.upload_rejected',
      subjectType: 'upload_session',
      subjectId: sessionId,
      reason,
    });
    await this.store.remove('quarantine', storageKey).catch(() => undefined);
    this.log.warn({ uploadSessionId: sessionId, reason }, 'dms.upload_rejected');
  }
}

function titleFrom(filename: string): string {
  const dot = filename.lastIndexOf('.');
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  return stem.trim().slice(0, 200) || filename.slice(0, 200);
}
