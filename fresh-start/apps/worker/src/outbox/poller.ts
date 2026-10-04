import type { Logger } from '@jobwork/observability';
import { withCorrelation } from '@jobwork/observability';
import type { Pool } from 'pg';
import type { HandlerRegistry } from './registry';
import type { OutboxEventRow } from './types';

export interface PollerOptions {
  batchSize: number;
  visibilityTimeoutMs: number;
  maxAttempts: number;
  baseDelayMs: number;
  capDelayMs: number;
}

export const DEFAULT_POLLER_OPTIONS: PollerOptions = {
  batchSize: 10,
  visibilityTimeoutMs: 2 * 60 * 1000,
  maxAttempts: 8,
  baseDelayMs: 2_000,
  capDelayMs: 15 * 60 * 1000,
};

/** Capped exponential backoff with jitter — cap applied after jitter (doc 07 §10, corrected). */
export function retryDelayMs(attempt: number, opts: PollerOptions, random = Math.random): number {
  const jitter = 0.5 + random(); // [0.5, 1.5)
  return Math.min(opts.capDelayMs, opts.baseDelayMs * 2 ** attempt * jitter);
}

/**
 * Leases due outbox rows with FOR UPDATE SKIP LOCKED, dispatches to handlers, and records
 * delivery, retry, or dead-letter state. Stuck 'processing' rows past the visibility
 * timeout are reclaimed (crash recovery).
 */
/**
 * What happened to one event, for metrics (F-11.3). `lagSeconds` is due-to-handled for a
 * first attempt — a new event's commit, or a replay — and null for a retry, whose wait was
 * a deliberate backoff. Measured from the commit, a replay of a month-old dead letter
 * would report a month of "lag" against a 30-second objective.
 */
export type OutcomeObserver = (eventType: string, outcome: 'delivered' | 'retry' | 'dead', seconds: number, lagSeconds: number | null) => void;

export class OutboxPoller {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly pool: Pool,
    private readonly registry: HandlerRegistry,
    private readonly log: Logger,
    private readonly opts: PollerOptions = DEFAULT_POLLER_OPTIONS,
    private readonly observe: OutcomeObserver = () => undefined,
  ) {}

  async claim(): Promise<OutboxEventRow[]> {
    const res = await this.pool.query(
      `UPDATE platform.outbox_event o
          SET status = 'processing', locked_at = now(), attempts = o.attempts + 1
        WHERE o.id IN (
          SELECT id FROM platform.outbox_event
           WHERE (status = 'pending' AND next_attempt_at <= now())
              OR (status = 'processing' AND locked_at < now() - ($2 * interval '1 millisecond'))
           ORDER BY next_attempt_at
           LIMIT $1
           FOR UPDATE SKIP LOCKED)
        RETURNING o.id, o.event_type AS "eventType", o.occurred_at AS "occurredAt",
                  o.aggregate_type AS "aggregateType", o.aggregate_id AS "aggregateId",
                  o.aggregate_version AS "aggregateVersion", o.organization_id AS "organizationId",
                  o.actor, o.correlation_id AS "correlationId", o.data, o.attempts,
                  o.next_attempt_at AS "dueAt"`,
      [this.opts.batchSize, this.opts.visibilityTimeoutMs],
    );
    return res.rows as OutboxEventRow[];
  }

  async processOne(event: OutboxEventRow): Promise<'delivered' | 'retry' | 'dead'> {
    const handler = this.registry.resolve(event.eventType);
    if (!handler) {
      await this.markDead(event.id, `no handler registered for ${event.eventType}`);
      this.log.error({ eventId: event.id, eventType: event.eventType }, 'outbox event parked');
      return 'dead';
    }
    try {
      const result = await withCorrelation(
        { correlationId: event.correlationId, causationId: event.id },
        () => handler(event),
      );
      const strip = result && 'stripDataKeys' in result ? (result.stripDataKeys ?? []) : [];
      await this.pool.query(
        `UPDATE platform.outbox_event
            SET status = 'delivered', delivered_at = now(), locked_at = NULL,
                data = data - $2::text[]
          WHERE id = $1`,
        [event.id, strip],
      );
      return 'delivered';
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (event.attempts >= this.opts.maxAttempts) {
        await this.markDead(event.id, message);
        this.log.error({ eventId: event.id, err: message }, 'outbox event dead-lettered');
        return 'dead';
      }
      const delay = retryDelayMs(event.attempts, this.opts);
      await this.pool.query(
        `UPDATE platform.outbox_event
            SET status = 'pending', locked_at = NULL, last_error = $2,
                next_attempt_at = now() + ($3 * interval '1 millisecond')
          WHERE id = $1`,
        [event.id, message, Math.round(delay)],
      );
      this.log.warn({ eventId: event.id, attempt: event.attempts, err: message }, 'outbox retry scheduled');
      return 'retry';
    }
  }

  private async markDead(id: string, error: string): Promise<void> {
    await this.pool.query(
      `UPDATE platform.outbox_event
          SET status = 'dead', locked_at = NULL, last_error = $2
        WHERE id = $1`,
      [id, error],
    );
  }

  async tick(): Promise<number> {
    const events = await this.claim();
    for (const event of events) {
      const started = performance.now();
      const outcome = await this.processOne(event);
      const due = event.dueAt ?? event.occurredAt;
      const lag = event.attempts === 1 ? (Date.now() - new Date(due).getTime()) / 1000 : null;
      this.observe(event.eventType, outcome, (performance.now() - started) / 1000, lag);
    }
    return events.length;
  }

  start(intervalMs = 2_000): void {
    const loop = async (): Promise<void> => {
      if (this.running) return;
      this.running = true;
      try {
        let processed = 0;
        do {
          processed = await this.tick();
        } while (processed > 0);
      } catch (err) {
        this.log.error(
          { err: err instanceof Error ? err.message : String(err) },
          'outbox tick failed',
        );
      } finally {
        this.running = false;
      }
    };
    this.timer = setInterval(() => void loop(), intervalMs);
    void loop();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
