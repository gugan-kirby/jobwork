import { Controller, Param, Post, Req } from '@nestjs/common';
import {
  recordScanResultRequestSchema,
  type BeginScanResponse,
  type ScanResultResponse,
} from '@jobwork/contracts';
import { BeginScanCommand } from '../application/begin-scan.command';
import { RecordScanResultCommand } from '../application/record-scan-result.command';
import { DomainError } from '../../../platform/http/domain-error';
import {
  ServiceOnly,
  type ServiceActorRequest,
} from '../../../platform/http/service-principal.guard';
import { SCAN_WORKER_PRINCIPAL, type ServicePrincipal } from '@jobwork/service-auth';
import { parseBody } from '../../../platform/http/validation';

function principalOf(request: ServiceActorRequest): ServicePrincipal {
  if (!request.servicePrincipal) {
    throw new DomainError('SERVICE_AUTH_FAILED', 401, 'Service credential required');
  }
  return request.servicePrincipal;
}

function idempotencyKey(request: ServiceActorRequest): string | undefined {
  const header = request.headers['idempotency-key'];
  return typeof header === 'string' ? header : undefined;
}

/**
 * The internal scan surface (doc 08 §7). Reachable only by the scan-worker principal —
 * no user session, however privileged, can record a verdict on a file.
 */
@ServiceOnly(SCAN_WORKER_PRINCIPAL.name)
@Controller('internal/documents/scans')
export class InternalScanController {
  constructor(
    private readonly begin: BeginScanCommand,
    private readonly record: RecordScanResultCommand,
  ) {}

  @Post(':fileObjectId/begin')
  async beginScan(
    @Param('fileObjectId') fileObjectId: string,
    @Req() request: ServiceActorRequest,
  ): Promise<BeginScanResponse> {
    return this.begin.execute(principalOf(request), fileObjectId, {
      idempotencyKey: idempotencyKey(request),
    });
  }

  @Post(':fileObjectId/result')
  async recordResult(
    @Param('fileObjectId') fileObjectId: string,
    @Req() request: ServiceActorRequest,
  ): Promise<ScanResultResponse> {
    const body = parseBody(recordScanResultRequestSchema, request.body);
    return this.record.execute(principalOf(request), fileObjectId, body, {
      idempotencyKey: idempotencyKey(request),
    });
  }
}
