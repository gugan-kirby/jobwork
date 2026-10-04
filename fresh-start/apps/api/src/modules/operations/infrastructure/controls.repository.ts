import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../../platform/database/database.service';
import { QUEUE_DEFINITIONS } from './queue-registry';
import { QueueRepository } from './queue.repository';

export interface QueueControl {
  key: string;
  count: number;
  oldestWaitingSince: Date | null;
  overdue: number;
}

export interface PlatformControls {
  outbox: { pending: number; processing: number; dead: number; oldestPendingSeconds: number };
  scan: { backlog: number; oldestSeconds: number };
  deliveries: { failedLastHour: number; stuckSending: number };
}

export interface ControlsSnapshot {
  at: Date;
  queues: QueueControl[];
  platform: PlatformControls;
}

/** A scrape every 15 s from two Prometheus replicas must not become forty queries a second. */
const CACHE_MS = 10_000;

/**
 * The business and platform controls (doc 12 §§6–7; F-11.3), read once and shared by the
 * Prometheus gauges and the in-app controls panel — so an alert and the screen an
 * operator opens to answer it show the same numbers.
 */
@Injectable()
export class ControlsRepository {
  private cached: { at: number; value: Promise<ControlsSnapshot> } | null = null;

  constructor(
    private readonly db: DatabaseService,
    private readonly queues: QueueRepository,
  ) {}

  /** Cached for scrapes; `fresh` for a person who just asked (the controls panel). */
  snapshot(opts: { fresh?: boolean } = {}): Promise<ControlsSnapshot> {
    const now = Date.now();
    if (opts.fresh || !this.cached || now - this.cached.at > CACHE_MS) {
      const value = this.read();
      // A failed read is not cached: the next scrape tries again.
      value.catch(() => {
        this.cached = null;
      });
      this.cached = { at: now, value };
    }
    return this.cached.value;
  }

  private async read(): Promise<ControlsSnapshot> {
    const at = new Date();
    const overdue = await this.db.pool.query<{ queue_key: string; n: number }>(
      `SELECT queue_key, count(*)::int AS n FROM platform.queue_assignment
        WHERE status = 'open' AND due_at <= now() GROUP BY queue_key`,
    );
    const overdueBy = new Map(overdue.rows.map((r) => [r.queue_key, Number(r.n)]));
    const queues: QueueControl[] = [];
    for (const def of QUEUE_DEFINITIONS) {
      const { count, oldestWaitingSince } = await this.queues.countMembers(def);
      queues.push({ key: def.key, count, oldestWaitingSince, overdue: overdueBy.get(def.key) ?? 0 });
    }
    const outbox = await this.db.pool.query<{ pending: number; processing: number; dead: number; oldest: number }>(
      `SELECT count(*) FILTER (WHERE status = 'pending')::int AS pending,
              count(*) FILTER (WHERE status = 'processing')::int AS processing,
              count(*) FILTER (WHERE status = 'dead')::int AS dead,
              coalesce(extract(epoch FROM now() - min(occurred_at) FILTER (WHERE status IN ('pending', 'processing'))), 0)::int AS oldest
         FROM platform.outbox_event WHERE status IN ('pending', 'processing', 'dead')`,
    );
    const scan = await this.db.pool.query<{ backlog: number; oldest: number }>(
      `SELECT count(*)::int AS backlog, coalesce(extract(epoch FROM now() - min(created_at)), 0)::int AS oldest
         FROM dms.file_object WHERE scan_state IN ('quarantined', 'scanning')`,
    );
    const deliveries = await this.db.pool.query<{ failed: number; stuck: number }>(
      `SELECT count(*) FILTER (WHERE status = 'failed' AND completed_at > now() - interval '1 hour')::int AS failed,
              count(*) FILTER (WHERE status = 'sending' AND attempted_at < now() - interval '15 minutes')::int AS stuck
         FROM communication.delivery_attempt
        WHERE completed_at > now() - interval '1 hour' OR status = 'sending'`,
    );
    const o = outbox.rows[0]!;
    const s = scan.rows[0]!;
    const d = deliveries.rows[0]!;
    return {
      at,
      queues,
      platform: {
        outbox: { pending: o.pending, processing: o.processing, dead: o.dead, oldestPendingSeconds: o.oldest },
        scan: { backlog: s.backlog, oldestSeconds: s.oldest },
        deliveries: { failedLastHour: d.failed, stuckSending: d.stuck },
      },
    };
  }
}
