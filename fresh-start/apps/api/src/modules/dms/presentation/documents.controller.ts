import { Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  finalizeUploadRequestSchema,
  initiateUploadRequestSchema,
  type DocumentManifest,
  type DocumentSummary,
  type InitiateUploadResponse,
  type UploadSessionStatus,
} from '@jobwork/contracts';
import { z } from 'zod';
import type { Actor } from '../../iam';
import { requireOrganization } from '../../iam';
import { FinalizeUploadCommand, type FinalizeUploadResult } from '../application/finalize-upload.command';
import { InitiateUploadCommand } from '../application/initiate-upload.command';
import { DocumentNotFound } from '../domain/errors';
import { DmsRepository } from '../infrastructure/dms.repository';
import { CurrentActor } from '../../../platform/http/actor.decorator';
import { parseBody } from '../../../platform/http/validation';

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const finalizeBodySchema = finalizeUploadRequestSchema.extend({
  title: z.string().trim().min(1).max(200).optional(),
  engineeringRevision: z.string().trim().min(1).max(40).optional(),
  expectedVersion: z.number().int().positive().optional(),
});

function idempotencyKey(request: FastifyRequest): string | undefined {
  const header = request.headers['idempotency-key'];
  return typeof header === 'string' ? header : undefined;
}

@Controller('documents')
export class DocumentsController {
  constructor(
    private readonly initiate: InitiateUploadCommand,
    private readonly finalize: FinalizeUploadCommand,
    private readonly repo: DmsRepository,
  ) {}

  @Post('uploads')
  async initiateUpload(
    @CurrentActor() actor: Actor,
    @Req() request: FastifyRequest,
  ): Promise<InitiateUploadResponse> {
    const body = parseBody(initiateUploadRequestSchema, request.body);
    return this.initiate.execute(actor, body, { idempotencyKey: idempotencyKey(request) });
  }

  @Post('uploads/:uploadSessionId/finalize')
  async finalizeUpload(
    @CurrentActor() actor: Actor,
    @Param('uploadSessionId') uploadSessionId: string,
    @Req() request: FastifyRequest,
  ): Promise<FinalizeUploadResult> {
    const body = parseBody(finalizeBodySchema, request.body);
    return this.finalize.execute(actor, uploadSessionId, body, {
      idempotencyKey: idempotencyKey(request),
    });
  }

  /**
   * What became of an upload this browser started (doc 21 §6 resumable recovery).
   * A reload loses the file handle and the signed grant, never the session.
   */
  @Get('uploads/:uploadSessionId')
  async uploadSession(
    @CurrentActor() actor: Actor,
    @Param('uploadSessionId') uploadSessionId: string,
  ): Promise<UploadSessionStatus> {
    const organizationId = requireOrganization(actor);
    const session = await this.repo.findUploadSession(uploadSessionId, organizationId);
    if (!session) throw new DocumentNotFound();
    return {
      uploadSessionId: session.id,
      status: session.status,
      purpose: session.purpose,
      filename: session.declaredFilename,
      byteSize: session.declaredByteSize,
      expiresAt: session.expiresAt.toISOString(),
      documentId: session.documentId,
      documentVersionId: session.documentVersionId,
    };
  }

  /** Documents owned by the actor's own organization; audience-granted documents of
   * other organizations arrive with the grant surface (F-03.4). */
  @Get()
  async list(
    @CurrentActor() actor: Actor,
    @Query() query: unknown,
  ): Promise<{ documents: DocumentSummary[] }> {
    const organizationId = requireOrganization(actor);
    const { limit } = parseBody(listQuerySchema, query);
    const rows = await this.repo.listDocuments(organizationId, limit);
    return {
      documents: rows.map((row) => ({
        documentId: row.id,
        title: row.title,
        logicalType: row.logicalType,
        classification: row.classification,
        currentVersionNo: row.currentVersionNo,
        currentVersionId: row.currentVersionId,
        currentVersionStatus: row.currentVersionStatus,
        currentVersionScanState: row.currentVersionScanState,
        aggregateVersion: row.aggregateVersion,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }

  /** Doc 21 §6 manifest: every version with its digest, revision label and states. */
  @Get(':documentId/manifest')
  async manifest(
    @CurrentActor() actor: Actor,
    @Param('documentId') documentId: string,
  ): Promise<DocumentManifest> {
    const organizationId = requireOrganization(actor);
    const document = await this.repo.findDocument(documentId, organizationId);
    if (!document) throw new DocumentNotFound();
    const versions = await this.repo.listVersions(documentId, organizationId);
    // listVersions is newest-first, so the head is the version an attach would use.
    const current = versions[0] ?? null;
    return {
      document: {
        documentId: document.id,
        title: document.title,
        logicalType: document.logicalType,
        classification: document.classification,
        currentVersionNo: document.currentVersionNo,
        currentVersionId: current?.id ?? null,
        currentVersionStatus: current?.status ?? null,
        currentVersionScanState: current?.scanState ?? null,
        aggregateVersion: document.aggregateVersion,
        createdAt: document.createdAt.toISOString(),
      },
      versions: versions.map((version) => ({
        documentVersionId: version.id,
        documentId: version.documentId,
        versionNo: version.versionNo,
        engineeringRevision: version.engineeringRevision,
        originalFilename: version.originalFilename,
        status: version.status,
        scanState: version.scanState,
        sha256: version.sha256,
        byteSize: version.byteSize,
        audiences: version.audiences,
        createdAt: version.createdAt.toISOString(),
      })),
    };
  }
}
