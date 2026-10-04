import { Injectable } from '@nestjs/common';
import { createLogger, type Logger } from '@jobwork/observability';
import type { RecordScanResultRequest, ScanResultResponse } from '@jobwork/contracts';
import { FileObjectNotFound, ScanVerdictConflict } from '../domain/errors';
import { DmsRepository, type ScanState } from '../infrastructure/dms.repository';
import { ObjectStore } from '../infrastructure/object-store';
import { contextFromService } from '../../../platform/commands/command';
import { CommandExecutor } from '../../../platform/commands/execute';
import type { ServicePrincipal } from '@jobwork/service-auth';

const SETTLED: readonly ScanState[] = ['clean', 'infected', 'unsupported'];

/**
 * record-scan-result (doc 08 §7 step 4). Service-principal only. A `clean` verdict
 * promotes the bytes out of the quarantine bucket and lets the waiting versions become
 * *releasable* — it grants nothing to anyone; audience release stays an explicit,
 * separate act (F-03.4). Every other verdict, including an exhausted failure, settles
 * the versions as quarantined and leaves the original bytes in quarantine as evidence
 * (doc 09 §4, doc 11 §8).
 */
@Injectable()
export class RecordScanResultCommand {
  private readonly log: Logger = createLogger({ service: 'api' }).child({ module: 'dms.scan' });

  constructor(
    private readonly repo: DmsRepository,
    private readonly store: ObjectStore,
    private readonly executor: CommandExecutor,
  ) {}

  async execute(
    principal: ServicePrincipal,
    fileObjectId: string,
    input: RecordScanResultRequest,
    opts: { idempotencyKey?: string | undefined } = {},
  ): Promise<ScanResultResponse> {
    const file = await this.repo.findFileObject(fileObjectId);
    if (!file) throw new FileObjectNotFound();
    const ctx = contextFromService(principal, file.owningOrganizationId ?? null);

    // A settled file keeps its verdict: an identical replay is the worker retrying,
    // anything else needs the revocation path, not a silent overwrite (doc 11 §8).
    if (SETTLED.includes(file.scanState)) {
      if (file.scanState === input.verdict) {
        return this.currentState(file.id, file.scanState);
      }
      throw new ScanVerdictConflict(file.scanState, input.verdict);
    }

    // Promotion happens before the state change: if the copy fails, the file stays
    // quarantined and the worker retries. The reverse order could mark a file clean
    // whose bytes never reached the clean bucket.
    if (input.verdict === 'clean') {
      await this.store.copy(
        { bucket: 'quarantine', key: file.storageKey },
        { bucket: 'clean', key: file.storageKey },
      );
    }

    const outcome = await this.executor.execute(
      {
        operation: 'dms.record-scan-result',
        handler: async (tx, _ctx, cmd: RecordScanResultRequest) => {
          const locked = await this.repo.lockFileObject(fileObjectId, tx);
          if (!locked) throw new FileObjectNotFound();
          if (SETTLED.includes(locked.scanState)) {
            if (locked.scanState === cmd.verdict) {
              const replay = await this.currentState(locked.id, locked.scanState, tx);
              return { result: replay, audit: [] };
            }
            throw new ScanVerdictConflict(locked.scanState, cmd.verdict);
          }

          // The lifecycle runs quarantined → scanning → verdict (database trigger);
          // a verdict arriving for a file that was never claimed still passes through
          // `scanning` so the recorded history stays truthful.
          if (locked.scanState !== 'scanning') {
            await this.repo.setScanState({ id: locked.id, scanState: 'scanning' }, tx);
          }
          await this.repo.setScanState(
            {
              id: locked.id,
              scanState: cmd.verdict,
              detail: `${cmd.reason}${cmd.detail ? `: ${cmd.detail}` : ''} [${cmd.scanner.name}@${cmd.scanner.version}]`,
              detectedMediaType: cmd.detectedMediaType,
            },
            tx,
          );

          // A retriable failure leaves the versions processing: the worker comes back.
          // An exhausted one is terminal, and terminal means quarantined, not released.
          const settlement =
            cmd.verdict === 'clean'
              ? 'available'
              : cmd.verdict === 'failed' && !cmd.retriesExhausted
                ? null
                : 'quarantined';
          const settledCount = settlement
            ? await this.repo.settleVersionsForFile(locked.id, settlement, tx)
            : 0;

          const result: ScanResultResponse = {
            fileObjectId: locked.id,
            scanState: cmd.verdict,
            versionsReleasable: settlement === 'available' ? settledCount : 0,
            versionsQuarantined: settlement === 'quarantined' ? settledCount : 0,
          };

          return {
            result,
            audit: [
              {
                action: 'dms.scan_recorded',
                subjectType: 'file_object',
                subjectId: locked.id,
                reason: cmd.reason,
                data: {
                  verdict: cmd.verdict,
                  scanner: `${cmd.scanner.name}@${cmd.scanner.version}`,
                  detectedMediaType: cmd.detectedMediaType,
                  retriesExhausted: cmd.retriesExhausted,
                  versionsSettled: settledCount,
                },
              },
            ],
            outbox:
              cmd.verdict === 'clean'
                ? [
                    {
                      eventType: 'dms.file_cleared',
                      aggregateType: 'file_object',
                      aggregateId: locked.id,
                      data: { fileObjectId: locked.id, versionsReleasable: settledCount },
                    },
                  ]
                : [
                    {
                      eventType: 'dms.file_quarantined',
                      aggregateType: 'file_object',
                      aggregateId: locked.id,
                      data: {
                        fileObjectId: locked.id,
                        verdict: cmd.verdict,
                        reason: cmd.reason,
                        retriesExhausted: cmd.retriesExhausted,
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

    // The quarantine copy is redundant once the clean copy is committed. Deleting it
    // after commit keeps a store hiccup from rolling back a recorded verdict.
    if (input.verdict === 'clean') {
      await this.store.remove('quarantine', file.storageKey).catch((cause: unknown) => {
        this.log.warn(
          { fileObjectId: file.id, err: String(cause) },
          'dms.quarantine_cleanup_failed',
        );
      });
    }
    return outcome;
  }

  private async currentState(
    fileObjectId: string,
    scanState: ScanState,
    tx?: Parameters<DmsRepository['setScanState']>[1],
  ): Promise<ScanResultResponse> {
    const counts = await this.repo.countVersionStatuses(fileObjectId, tx);
    return {
      fileObjectId,
      scanState,
      versionsReleasable: counts.available,
      versionsQuarantined: counts.quarantined,
    };
  }
}
