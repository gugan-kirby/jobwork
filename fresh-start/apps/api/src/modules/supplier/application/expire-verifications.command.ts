import { Injectable } from '@nestjs/common';
import { createLogger, type Logger } from '@jobwork/observability';
import { SupplierRepository } from '../infrastructure/supplier.repository';
import { contextFromService } from '../../../platform/commands/command';
import { CommandExecutor } from '../../../platform/commands/execute';
import type { ServicePrincipal } from '@jobwork/service-auth';

export interface ExpirySweepResult {
  expiring: number;
  expired: number;
}

/** How long before the stored expiry an item starts warning (doc 06 §14 `expiring`). */
const EXPIRING_WINDOW_DAYS = 30;
const BATCH = 200;

/**
 * expire-verifications — the scheduled half of doc 06 §14, run by the scan worker under
 * its service principal. Expiry is driven by the stored date, not by a timer that could
 * drift or a job that could be missed: whatever the schedule does, the query is the
 * truth, and running it twice changes nothing the second time.
 *
 * Expiry excludes a supplier from *new* matching (`FR-202`). It rewrites no history:
 * the RFQs and awards made while the evidence was valid keep saying what they said, and
 * the award and release gates re-check current state themselves (doc 19 §4).
 */
@Injectable()
export class ExpireVerificationsCommand {
  private readonly log: Logger = createLogger({ service: 'api' }).child({
    module: 'supplier.verification',
  });

  constructor(
    private readonly repo: SupplierRepository,
    private readonly executor: CommandExecutor,
  ) {}

  async execute(principal: ServicePrincipal, now = new Date()): Promise<ExpirySweepResult> {
    const ctx = contextFromService(principal, null);

    return this.executor.execute(
      {
        operation: 'supplier.expire-verifications',
        handler: async (tx) => {
          const warnThreshold = new Date(
            now.getTime() + EXPIRING_WINDOW_DAYS * 24 * 60 * 60 * 1000,
          );
          const audit: Array<{
            action: string;
            subjectType: string;
            subjectId: string;
            subjectVersion?: number;
            reason?: string;
            data?: Record<string, unknown>;
          }> = [];
          const outbox: Array<{
            eventType: string;
            aggregateType: string;
            aggregateId: string;
            data: Record<string, unknown>;
          }> = [];

          const due = await this.repo.findExpiredVerifications(now, BATCH, tx);
          for (const item of due) {
            await this.repo.setVerificationStatus({ id: item.id, status: 'expired' }, tx);
            audit.push({
              action: 'supplier.verification_expired',
              subjectType: 'verification_item',
              subjectId: item.id,
              subjectVersion: item.versionNo,
              reason: 'stored expiry reached',
              data: {
                supplierProfileId: item.supplierProfileId,
                kind: item.kind,
                expiresAt: item.expiresAt?.toISOString() ?? null,
              },
            });
            outbox.push({
              eventType: 'supplier.verification_expired',
              aggregateType: 'verification_item',
              aggregateId: item.id,
              data: { supplierProfileId: item.supplierProfileId, kind: item.kind },
            });
          }

          // Warn before the cliff so a supplier can renew rather than fall out of
          // matching silently.
          const soon = await this.repo.findExpiringVerifications(now, warnThreshold, BATCH, tx);
          for (const item of soon) {
            await this.repo.setVerificationStatus({ id: item.id, status: 'expiring' }, tx);
            audit.push({
              action: 'supplier.verification_expiring',
              subjectType: 'verification_item',
              subjectId: item.id,
              subjectVersion: item.versionNo,
              data: {
                supplierProfileId: item.supplierProfileId,
                kind: item.kind,
                expiresAt: item.expiresAt?.toISOString() ?? null,
              },
            });
            outbox.push({
              eventType: 'supplier.verification_expiring',
              aggregateType: 'verification_item',
              aggregateId: item.id,
              data: { supplierProfileId: item.supplierProfileId, kind: item.kind },
            });
          }

          if (due.length > 0 || soon.length > 0) {
            this.log.info(
              { expired: due.length, expiring: soon.length },
              'supplier.verification_sweep',
            );
          }
          return {
            result: { expired: due.length, expiring: soon.length },
            audit,
            outbox,
          };
        },
      },
      ctx,
      { sweptAt: now.toISOString() },
    );
  }
}
