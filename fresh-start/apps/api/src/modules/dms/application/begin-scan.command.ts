import { Injectable } from '@nestjs/common';
import type { BeginScanResponse } from '@jobwork/contracts';
import { FileObjectNotFound } from '../domain/errors';
import { DmsRepository } from '../infrastructure/dms.repository';
import { contextFromService } from '../../../platform/commands/command';
import { CommandExecutor } from '../../../platform/commands/execute';
import type { ServicePrincipal } from '@jobwork/service-auth';

const SETTLED: readonly string[] = ['clean', 'infected', 'unsupported'];

/**
 * begin-scan: the scan worker claims a quarantined file and moves it to `scanning`,
 * which is what makes an interrupted scan visible rather than invisible. Idempotent —
 * re-claiming a file already scanning is normal after a worker restart, and a file
 * that already has a verdict is returned as settled so the worker stops.
 */
@Injectable()
export class BeginScanCommand {
  constructor(
    private readonly repo: DmsRepository,
    private readonly executor: CommandExecutor,
  ) {}

  async execute(
    principal: ServicePrincipal,
    fileObjectId: string,
    opts: { idempotencyKey?: string | undefined } = {},
  ): Promise<BeginScanResponse> {
    const file = await this.repo.findFileObject(fileObjectId);
    if (!file) throw new FileObjectNotFound();
    const ctx = contextFromService(principal, file.owningOrganizationId ?? null);

    return this.executor.execute(
      {
        operation: 'dms.begin-scan',
        handler: async (tx, _ctx, cmd: { fileObjectId: string }) => {
          const locked = await this.repo.lockFileObject(cmd.fileObjectId, tx);
          if (!locked) throw new FileObjectNotFound();

          const settled = SETTLED.includes(locked.scanState);
          if (!settled && locked.scanState !== 'scanning') {
            await this.repo.setScanState({ id: locked.id, scanState: 'scanning' }, tx);
          }

          const result: BeginScanResponse = {
            fileObjectId: locked.id,
            storageKey: locked.storageKey,
            byteSize: locked.byteSize,
            sha256: locked.sha256,
            declaredMediaType: locked.declaredMediaType ?? 'application/octet-stream',
            scanState: settled ? locked.scanState : 'scanning',
            alreadySettled: settled,
          };
          return {
            result,
            audit: settled
              ? []
              : [
                  {
                    action: 'dms.scan_started',
                    subjectType: 'file_object',
                    subjectId: locked.id,
                    data: { previousState: locked.scanState },
                  },
                ],
          };
        },
      },
      ctx,
      { fileObjectId },
      opts,
    );
  }
}
