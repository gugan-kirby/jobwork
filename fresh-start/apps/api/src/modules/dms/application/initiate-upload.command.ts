import { Injectable } from '@nestjs/common';
import { createLogger, type Logger } from '@jobwork/observability';
import type { InitiateUploadRequest, InitiateUploadResponse } from '@jobwork/contracts';
import { v7 as uuidv7 } from 'uuid';
import { type Actor, requireOrganization, requireTransactionalStrength } from '../../iam';
import { VersionConflict } from '../../iam/domain/errors';
import { DocumentNotFound } from '../domain/errors';
import { assertUploadAllowed, safeFilename } from '../domain/upload-policy';
import { DmsRepository } from '../infrastructure/dms.repository';
import { ObjectStore } from '../infrastructure/object-store';
import { contextFromActor } from '../../../platform/commands/command';
import { CommandExecutor } from '../../../platform/commands/execute';
import { ConfigService } from '../../../platform/config/config.service';

/**
 * initiate-upload (doc 08 §7 step 1). Records intent, then hands back a short-lived
 * capability bound to one key, one method, one length and one digest. No bytes reach
 * the API, and the grant cannot be reused for anything else.
 */
@Injectable()
export class InitiateUploadCommand {
  private readonly log: Logger = createLogger({ service: 'api' }).child({ module: 'dms.upload' });

  constructor(
    private readonly repo: DmsRepository,
    private readonly store: ObjectStore,
    private readonly config: ConfigService,
    private readonly executor: CommandExecutor,
  ) {}

  async execute(
    actor: Actor,
    input: InitiateUploadRequest,
    opts: { idempotencyKey?: string | undefined } = {},
  ): Promise<InitiateUploadResponse> {
    requireTransactionalStrength(actor);
    const organizationId = requireOrganization(actor);

    const filename = safeFilename(input.filename);
    assertUploadAllowed({
      purpose: input.purpose,
      filename,
      declaredMediaType: input.declaredMediaType,
      byteSize: input.byteSize,
    });

    if (input.documentId) {
      const document = await this.repo.findDocument(input.documentId, organizationId);
      if (!document) throw new DocumentNotFound();
      if (input.expectedVersion !== undefined && input.expectedVersion !== document.aggregateVersion) {
        throw new VersionConflict();
      }
    }

    const ttlSeconds = this.config.env.UPLOAD_GRANT_TTL_SECONDS;
    const sessionId = await this.executor.execute(
      {
        operation: 'dms.initiate-upload',
        handler: async (tx, ctx, cmd: InitiateUploadRequest & { filename: string }) => {
          const session = await this.repo.createUploadSession(
            {
              organizationId,
              createdBy: actor.userId,
              purpose: cmd.purpose,
              declaredFilename: cmd.filename,
              declaredMediaType: cmd.declaredMediaType,
              declaredByteSize: cmd.byteSize,
              storageKey: uuidv7(),
              documentId: cmd.documentId ?? null,
              expiresAt: new Date(Date.now() + ttlSeconds * 1000),
            },
            tx,
          );
          this.log.info(
            { correlationId: ctx.correlationId, uploadSessionId: session.id, purpose: cmd.purpose },
            'dms.upload_initiated',
          );
          return {
            result: session.id,
            audit: [
              {
                action: 'dms.upload_initiated',
                subjectType: 'upload_session',
                subjectId: session.id,
                data: {
                  purpose: cmd.purpose,
                  byteSize: cmd.byteSize,
                  sha256: cmd.sha256,
                  documentId: cmd.documentId ?? null,
                },
              },
            ],
          };
        },
      },
      contextFromActor({ userId: actor.userId, organizationId }),
      { ...input, filename },
      opts,
    );

    // Signed from the stored session, never from the request: a replayed idempotent
    // call re-signs the same key rather than persisting a capability in the database.
    const session = await this.repo.findUploadSession(sessionId, organizationId);
    if (!session) throw new DocumentNotFound();

    const grant = this.store.signUpload({
      key: session.storageKey,
      byteSize: session.declaredByteSize,
      sha256: input.sha256,
      contentType: session.declaredMediaType,
      ttlSeconds,
    });

    return {
      uploadSessionId: session.id,
      expiresAt: session.expiresAt.toISOString(),
      grant,
    };
  }
}
