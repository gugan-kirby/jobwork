import { Controller, Get, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  grantAudienceRequestSchema,
  type DownloadResponse,
  type GrantSummary,
} from '@jobwork/contracts';
import { z } from 'zod';
import type { Actor } from '../../iam';
import { requireOrganization } from '../../iam';
import { GrantAudienceCommand } from '../application/grant-audience.command';
import { RevokeGrantCommand } from '../application/revoke-grant.command';
import { isAuditor, isInternalDocumentHandler } from '../domain/audience-policy';
import { ContentNotReleasable, DocumentNotFound } from '../domain/errors';
import { DmsRepository } from '../infrastructure/dms.repository';
import { ObjectStore } from '../infrastructure/object-store';
import { ConfigService } from '../../../platform/config/config.service';
import { CurrentActor } from '../../../platform/http/actor.decorator';
import { parseBody } from '../../../platform/http/validation';
import { RateLimit } from '../../../platform/http/rate-limit/rate-limit.decorator';

const revokeBodySchema = z.object({
  reason: z.string().trim().min(1).max(200).optional(),
});

function idempotencyKey(request: FastifyRequest): string | undefined {
  const header = request.headers['idempotency-key'];
  return typeof header === 'string' ? header : undefined;
}

/**
 * Release and retrieval of a specific document version.
 *
 * Downloads are authorized at the moment of asking and answered with a short-lived
 * capability on the storage origin, never a stream from the application origin
 * (doc 09 §4, doc 03 §6). The URL's few minutes of life are the revocation bound of
 * doc 20 §8 target 5: a grant revoked now cannot be caught by a URL already issued,
 * so the TTL is kept short rather than pretended away.
 */
@Controller('documents/versions')
export class DownloadController {
  constructor(
    private readonly repo: DmsRepository,
    private readonly store: ObjectStore,
    private readonly config: ConfigService,
    private readonly grantAudience: GrantAudienceCommand,
    private readonly revoke: RevokeGrantCommand,
  ) {}

  @RateLimit('export')
  @Post(':versionId/grants')
  async grant(
    @CurrentActor() actor: Actor,
    @Param('versionId') versionId: string,
    @Req() request: FastifyRequest,
  ): Promise<GrantSummary> {
    const body = parseBody(grantAudienceRequestSchema, request.body);
    return this.grantAudience.execute(actor, versionId, body, {
      idempotencyKey: idempotencyKey(request),
    });
  }

  @Post(':versionId/grants/:grantId/revoke')
  async revokeGrant(
    @CurrentActor() actor: Actor,
    @Param('versionId') versionId: string,
    @Param('grantId') grantId: string,
    @Req() request: FastifyRequest,
  ): Promise<GrantSummary> {
    const body = request.body === undefined ? {} : parseBody(revokeBodySchema, request.body);
    return this.revoke.execute(actor, versionId, grantId, body, {
      idempotencyKey: idempotencyKey(request),
    });
  }

  /** The owning organization's view of who currently holds this version. */
  @Get(':versionId/grants')
  async listGrants(
    @CurrentActor() actor: Actor,
    @Param('versionId') versionId: string,
  ): Promise<{ grants: GrantSummary[] }> {
    const organizationId = requireOrganization(actor);
    const grants = await this.repo.listGrants(versionId, organizationId);
    return {
      grants: grants.map((g) => ({
        grantId: g.id,
        documentVersionId: g.documentVersionId,
        audienceType: g.audienceType,
        organizationId: g.organizationId,
        actions: g.actions as GrantSummary['actions'],
        validUntil: g.validUntil ? g.validUntil.toISOString() : null,
        revokedAt: g.revokedAt ? g.revokedAt.toISOString() : null,
        createdAt: g.createdAt.toISOString(),
      })),
    };
  }

  @RateLimit('export')
  @Get(':versionId/download')
  async download(
    @CurrentActor() actor: Actor,
    @Param('versionId') versionId: string,
  ): Promise<DownloadResponse> {
    const organizationId = requireOrganization(actor);

    const decision = await this.repo.decideAccess({
      versionId,
      organizationId,
      action: 'download',
      internalHandler: isInternalDocumentHandler(actor),
      auditor: isAuditor(actor),
    });
    // Unknown version and unauthorized version answer identically: no enumeration
    // (doc 03 §7 — customer A cannot probe for customer B's documents).
    if (!decision || (!decision.ownerAccess && !decision.granted)) throw new DocumentNotFound();
    if (decision.versionStatus !== 'available' || decision.scanState !== 'clean') {
      throw new ContentNotReleasable(decision.versionStatus, decision.scanState);
    }

    const ttlSeconds = this.config.env.DOWNLOAD_GRANT_TTL_SECONDS;
    const url = this.store.signDownload({
      bucket: 'clean',
      key: decision.storageKey,
      filename: decision.originalFilename,
      ttlSeconds,
    });

    // Written before the URL is handed over: who was given access to these bytes is a
    // fact the append-only log keeps whatever happens to the grant afterwards.
    await this.repo.recordAccess({
      versionId,
      actorId: actor.userId,
      organizationId,
      action: 'download',
    });

    return {
      url,
      filename: decision.originalFilename,
      sha256: decision.sha256,
      byteSize: decision.byteSize,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    };
  }
}
