import { Injectable } from '@nestjs/common';
import type { DeadLetter, ResolveDeadLetterRequest } from '@jobwork/contracts';
import { requireRole, requireTransactionalStrength, type Actor } from '../../iam';
import { contextFromActor } from '../../../platform/commands/command';
import { CommandExecutor } from '../../../platform/commands/execute';
import { DatabaseService } from '../../../platform/database/database.service';
import { DomainError } from '../../../platform/http/domain-error';

export class DeadLetterNotFound extends DomainError {
  constructor() {
    super('DEAD_LETTER_NOT_FOUND', 409, 'This event is no longer a dead letter', 'Someone may have replayed or dismissed it already. Refresh the list.');
  }
}

class InternalOnly extends DomainError {
  constructor() {
    super('NOT_AUTHORIZED', 403, 'Internal audience only');
  }
}

const READERS = ['platform_admin', 'security_admin'];

/** Error text can quote what failed — a recipient, a reference. Mask what identifies anyone. */
export function maskError(error: string | null): string | null {
  if (!error) return null;
  return error
    .replace(/[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+/g, '[e-mail]')
    .replace(/\+?\d[\d\s-]{8,}\d/g, '[number]')
    .slice(0, 300);
}

/**
 * Dead letters (F-11.4; doc 12 §4 "controlled replay"; `DO-14`). An outbox event the worker
 * gave up on waits for a person: replay it once its cause is fixed, or dismiss it when
 * the side effect is no longer wanted (a reminder for an order since closed). Both are
 * audited commands with a reason, for platform administrators; the payload is never
 * shown — a dead letter is diagnosed by its type, age and error.
 */
@Injectable()
export class DeadLetters {
  constructor(
    private readonly db: DatabaseService,
    private readonly executor: CommandExecutor,
  ) {}

  async list(actor: Actor): Promise<DeadLetter[]> {
    if (!actor.isInternal) throw new InternalOnly();
    requireRole(actor, ...READERS);
    const res = await this.db.pool.query<{ id: string; event_type: string; aggregate_type: string; occurred_at: Date; attempts: number; last_error: string | null; correlation_id: string }>(
      `SELECT id, event_type, aggregate_type, occurred_at, attempts, last_error, correlation_id
         FROM platform.outbox_event WHERE status = 'dead'
        ORDER BY occurred_at
        LIMIT 200`,
    );
    return res.rows.map((r) => ({
      eventId: r.id,
      eventType: r.event_type,
      aggregateType: r.aggregate_type,
      occurredAt: r.occurred_at.toISOString(),
      attempts: r.attempts,
      lastError: maskError(r.last_error),
      correlationId: r.correlation_id,
    }));
  }

  replay(actor: Actor, eventId: string, input: ResolveDeadLetterRequest, opts: { idempotencyKey?: string | undefined }): Promise<{ eventId: string; status: 'pending' }> {
    return this.resolve(actor, eventId, input, opts, 'replay');
  }

  dismiss(actor: Actor, eventId: string, input: ResolveDeadLetterRequest, opts: { idempotencyKey?: string | undefined }): Promise<{ eventId: string; status: 'dismissed' }> {
    return this.resolve(actor, eventId, input, opts, 'dismiss');
  }

  private async resolve<V extends 'replay' | 'dismiss'>(
    actor: Actor,
    eventId: string,
    input: ResolveDeadLetterRequest,
    opts: { idempotencyKey?: string | undefined },
    verb: V,
  ): Promise<{ eventId: string; status: V extends 'replay' ? 'pending' : 'dismissed' }> {
    if (!actor.isInternal) throw new InternalOnly();
    requireRole(actor, 'platform_admin');
    requireTransactionalStrength(actor);
    type Result = { eventId: string; status: V extends 'replay' ? 'pending' : 'dismissed' };
    return this.executor.execute<ResolveDeadLetterRequest, Result>(
      {
        operation: `platform.outbox-${verb}`,
        handler: async (tx, _ctx, cmd) => {
          // Only a dead event moves: a replay of a pending one would double its side effect.
          const res = await tx.query<{ event_type: string }>(
            verb === 'replay'
              ? `UPDATE platform.outbox_event
                    SET status = 'pending', attempts = 0, next_attempt_at = now(), locked_at = NULL
                  WHERE id = $1 AND status = 'dead' RETURNING event_type`
              : `UPDATE platform.outbox_event SET status = 'dismissed', locked_at = NULL
                  WHERE id = $1 AND status = 'dead' RETURNING event_type`,
            [eventId],
          );
          const row = res.rows[0];
          if (!row) throw new DeadLetterNotFound();
          return {
            result: { eventId, status: (verb === 'replay' ? 'pending' : 'dismissed') as Result['status'] },
            audit: [
              {
                action: verb === 'replay' ? 'platform.outbox_replayed' : 'platform.outbox_dismissed',
                subjectType: 'outbox_event',
                subjectId: eventId,
                reason: cmd.reason,
                data: { eventType: row.event_type },
              },
            ],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
  }
}
