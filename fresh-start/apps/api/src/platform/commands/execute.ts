import { Injectable } from '@nestjs/common';
import { DomainError } from '../http/domain-error';
import { DatabaseService } from '../database/database.service';
import { AuditWriter } from './audit.writer';
import { canonicalJson, requestHash } from './canonical';
import type { CommandContext, CommandDefinition } from './command';
import { OutboxWriter } from './outbox.writer';

export class IdempotencyPayloadMismatch extends DomainError {
  constructor() {
    super(
      'IDEMPOTENCY_PAYLOAD_MISMATCH',
      409,
      'Idempotency key reused with a different request',
    );
  }
}

export class OperationInProgress extends DomainError {
  constructor() {
    super('OPERATION_IN_PROGRESS', 409, 'The same operation is still being processed', 'Retry shortly.');
  }
}

/**
 * The doc 02 §8 template: (idempotency claim) → handler in one transaction →
 * audit + outbox appended atomically → (idempotency completion) → commit.
 * Handlers own authorization and expected-version checks; nothing persists on any throw.
 */
@Injectable()
export class CommandExecutor {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxWriter,
  ) {}

  async execute<TInput, TResult>(
    def: CommandDefinition<TInput, TResult>,
    ctx: CommandContext,
    input: TInput,
    opts: { idempotencyKey?: string | undefined } = {},
  ): Promise<TResult> {
    const key = opts.idempotencyKey;
    const hash = key ? requestHash(def.operation, input) : null;

    return this.db.withTransaction(async (tx) => {
      if (key && hash && ctx.actor.id) {
        const claimed = await tx.query(
          `INSERT INTO platform.idempotency_record
             (scope_type, scope_id, operation, idempotency_key, request_hash)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (scope_id, operation, idempotency_key) DO NOTHING`,
          [ctx.actor.type === 'user' ? 'user' : 'service', ctx.actor.id, def.operation, key, hash],
        );
        if ((claimed.rowCount ?? 0) === 0) {
          const existing = await tx.query<{
            request_hash: string;
            status: string;
            result: unknown;
          }>(
            `SELECT request_hash, status, result FROM platform.idempotency_record
             WHERE scope_id = $1 AND operation = $2 AND idempotency_key = $3`,
            [ctx.actor.id, def.operation, key],
          );
          const record = existing.rows[0];
          if (!record) throw new OperationInProgress();
          if (record.request_hash !== hash) throw new IdempotencyPayloadMismatch();
          if (record.status === 'completed') return record.result as TResult;
          throw new OperationInProgress();
        }
      }

      const outcome = await def.handler(tx, ctx, input);

      for (const auditSpec of outcome.audit) {
        await this.audit.write(tx, ctx, auditSpec);
      }
      for (const outboxSpec of outcome.outbox ?? []) {
        await this.outbox.write(tx, ctx, outboxSpec);
      }

      if (key && ctx.actor.id) {
        await tx.query(
          `UPDATE platform.idempotency_record
             SET status = 'completed', result = $4, completed_at = now()
           WHERE scope_id = $1 AND operation = $2 AND idempotency_key = $3`,
          [ctx.actor.id, def.operation, key, canonicalJson(outcome.result)],
        );
      }
      return outcome.result;
    });
  }
}
