import { createHash } from 'node:crypto';
import type { RecordScanResultRequest } from '@jobwork/contracts';
import type { Logger } from '@jobwork/observability';
import { ObjectStoreClient, ObjectStoreError } from '@jobwork/object-store';
import { InternalApiClient, InternalApiError } from '../../internal-api';
import type { ScanOutcome, Scanner } from '../../scan/scanner';
import type { OutboxEventRow } from '../types';

export interface ScanHandlerOptions {
  store: ObjectStoreClient;
  scanner: Scanner;
  api: InternalApiClient;
  log: Logger;
  /** Bytes above this are refused rather than inspected (doc 11 §8 resource limits). */
  maxInspectBytes: number;
  scanTimeoutMs: number;
  /** Attempt at which a failure stops being retriable and becomes a quarantine. */
  maxAttempts: number;
}

class ScanTimeout extends Error {
  constructor(ms: number) {
    super(`scanner exceeded ${ms}ms`);
  }
}

/**
 * dms.file_finalized → inspect the quarantined bytes and record a verdict through the
 * internal command (doc 08 §7). The worker never releases anything itself and never
 * writes business state directly.
 *
 * Fail-closed in every direction: an unreadable, oversized, digest-mismatched, timed
 * out or erroring scan can only ever end as a refusal. Transient failures retry on the
 * outbox's backoff; once retries are spent the verdict is recorded as terminal so the
 * waiting versions are quarantined rather than left hanging.
 */
export function fileFinalizedHandler(opts: ScanHandlerOptions) {
  return async (event: OutboxEventRow): Promise<void> => {
    const fileObjectId = String(event.data['fileObjectId'] ?? event.aggregateId);
    const filename = String(event.data['extension'] ? `file.${String(event.data['extension'])}` : 'file');
    const retriesExhausted = event.attempts >= opts.maxAttempts;
    const ctx = { correlationId: event.correlationId, idempotencyKey: event.id };

    const claim = await opts.api.beginScan(fileObjectId, ctx);
    if (claim.alreadySettled) {
      opts.log.info(
        { fileObjectId, scanState: claim.scanState },
        'dms.scan_skipped_already_settled',
      );
      return;
    }

    let outcome: ScanOutcome;
    try {
      const bytes = await opts.store.getBytes('quarantine', claim.storageKey, opts.maxInspectBytes);

      // Defence in depth: the upload grant binds the digest, so a mismatch here means
      // the stored bytes changed after finalize. Refuse them, never inspect further.
      const actualDigest = createHash('sha256').update(bytes).digest('hex');
      if (actualDigest !== claim.sha256) {
        outcome = {
          verdict: 'unsupported',
          reason: 'truncated_or_corrupt',
          detectedMediaType: null,
          detail: 'stored bytes do not match the recorded digest',
        };
      } else {
        outcome = await withDeadline(
          opts.scanner.scan({
            bytes,
            declaredMediaType: claim.declaredMediaType,
            filename,
          }),
          opts.scanTimeoutMs,
        );
      }
    } catch (cause) {
      outcome = failureOutcome(cause, retriesExhausted);
      opts.log.warn(
        {
          fileObjectId,
          attempt: event.attempts,
          reason: outcome.reason,
          err: cause instanceof Error ? cause.message : String(cause),
        },
        'dms.scan_failed',
      );
    }

    const request: RecordScanResultRequest = {
      verdict: outcome.verdict,
      reason: outcome.reason,
      detectedMediaType: outcome.detectedMediaType,
      ...(outcome.detail ? { detail: outcome.detail } : {}),
      scanner: { name: opts.scanner.name, version: opts.scanner.version },
      retriesExhausted: outcome.verdict === 'failed' ? retriesExhausted : false,
    };

    try {
      const recorded = await opts.api.recordScanResult(fileObjectId, request, {
        ...ctx,
        idempotencyKey: `${event.id}:result`,
      });
      opts.log.info(
        { fileObjectId, verdict: recorded.scanState, reason: outcome.reason },
        'dms.scan_recorded',
      );
    } catch (cause) {
      // A verdict already on file is not an error worth retrying — the previous
      // attempt landed and this delivery is a duplicate.
      if (cause instanceof InternalApiError && cause.code === 'SCAN_VERDICT_CONFLICT') {
        opts.log.info({ fileObjectId }, 'dms.scan_verdict_already_recorded');
        return;
      }
      throw cause;
    }

    // The failure is recorded; throwing now is what schedules the retry. Once retries
    // are exhausted the verdict is already terminal, so the event can complete.
    if (outcome.verdict === 'failed' && !retriesExhausted) {
      throw new Error(`scan incomplete (${outcome.reason}); retrying`);
    }
  };
}

function failureOutcome(cause: unknown, retriesExhausted: boolean): ScanOutcome {
  // An object larger than the inspection limit is a policy refusal, not a transient
  // fault: retrying will not make it smaller.
  if (cause instanceof ObjectStoreError && cause.message.includes('inspection limit')) {
    return {
      verdict: 'unsupported',
      reason: 'too_large_to_inspect',
      detectedMediaType: null,
      detail: cause.message,
    };
  }
  const timedOut = cause instanceof ScanTimeout;
  return {
    verdict: 'failed',
    reason: timedOut ? 'scanner_timeout' : 'scanner_error',
    detectedMediaType: null,
    detail: retriesExhausted
      ? `retries exhausted: ${cause instanceof Error ? cause.message : String(cause)}`
      : (cause instanceof Error ? cause.message : String(cause)).slice(0, 200),
  };
}

/**
 * Bounds how long a verdict may take. An in-process adapter cannot be interrupted
 * mid-computation, so it also carries its own size limits; the out-of-process engine
 * adapter (`T-06`) is killed on this deadline.
 */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ScanTimeout(ms)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
