import type { BeginScanResponse, RecordScanResultRequest, ScanResultResponse } from '@jobwork/contracts';
import { mintServiceToken, SERVICE_TOKEN_HEADER } from '@jobwork/service-auth';

export class InternalApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'InternalApiError';
  }
}

export interface InternalApiOptions {
  baseUrl: string;
  tokenSecret: string;
  principalName: string;
  timeoutMs?: number;
}

/**
 * The worker's channel to internal commands (doc 08 §7). Every call carries a freshly
 * minted, short-lived service credential — nothing long-lived is stored, and the
 * worker holds no user session (doc 20 §9).
 */
export class InternalApiClient {
  constructor(private readonly opts: InternalApiOptions) {}

  beginScan(
    fileObjectId: string,
    ctx: { correlationId: string; idempotencyKey: string },
  ): Promise<BeginScanResponse> {
    return this.post<BeginScanResponse>(
      `/api/v1/internal/documents/scans/${fileObjectId}/begin`,
      undefined,
      ctx,
    );
  }

  recordScanResult(
    fileObjectId: string,
    body: RecordScanResultRequest,
    ctx: { correlationId: string; idempotencyKey: string },
  ): Promise<ScanResultResponse> {
    return this.post<ScanResultResponse>(
      `/api/v1/internal/documents/scans/${fileObjectId}/result`,
      body,
      ctx,
    );
  }

  /** Scheduled verification sweep (doc 06 §14); safe to call as often as it ticks. */
  sweepVerificationExpiry(ctx: {
    correlationId: string;
    idempotencyKey: string;
  }): Promise<{ expired: number; expiring: number }> {
    return this.post<{ expired: number; expiring: number }>(
      '/api/v1/internal/suppliers/verification/sweep',
      undefined,
      ctx,
    );
  }

  /** RFQ deadline sweep (F-06.6); idempotent, and a missed tick only delays it. */
  sweepRfqDeadlines(ctx: {
    correlationId: string;
    idempotencyKey: string;
  }): Promise<{ lapsed: number; rounds: number }> {
    return this.post<{ lapsed: number; rounds: number }>(
      '/api/v1/internal/rfqs/deadline-sweep',
      undefined,
      ctx,
    );
  }

  /** Payment reconcile sweep (F-08.5): closes intents nobody paid before they expired. */
  sweepPayments(ctx: { correlationId: string; idempotencyKey: string }): Promise<{ expired: number }> {
    return this.post<{ expired: number }>('/api/v1/internal/payments/reconcile-sweep', undefined, ctx);
  }

  private async post<T>(
    path: string,
    body: unknown,
    ctx: { correlationId: string; idempotencyKey: string },
  ): Promise<T> {
    const headers: Record<string, string> = {
      [SERVICE_TOKEN_HEADER]: mintServiceToken(this.opts.tokenSecret, this.opts.principalName),
      'idempotency-key': ctx.idempotencyKey,
      'x-correlation-id': ctx.correlationId,
    };
    // Fastify rejects a body-less POST that still declares a JSON content type.
    if (body !== undefined) headers['content-type'] = 'application/json';

    let response: Response;
    try {
      response = await fetch(`${this.opts.baseUrl}${path}`, {
        method: 'POST',
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000),
      });
    } catch (cause) {
      throw new InternalApiError(
        `api unreachable: ${cause instanceof Error ? cause.message : String(cause)}`,
        0,
      );
    }

    const text = await response.text();
    const payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!response.ok) {
      throw new InternalApiError(
        `${path} failed: ${String(payload['title'] ?? response.statusText)}`,
        response.status,
        typeof payload['code'] === 'string' ? payload['code'] : undefined,
      );
    }
    return payload as T;
  }
}
