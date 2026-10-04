import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Gauge } from '@jobwork/observability';
import { MetricsService } from '../../../platform/metrics/metrics.service';
import { ControlsRepository } from './controls.repository';

/**
 * Domain and business-control gauges (doc 12 §6 "Domain" and "Business-control"; F-11.3),
 * read at scrape time from the same snapshot the controls panel shows. Labels are queue
 * keys and states only — a fixed, small set.
 */
@Injectable()
export class OperationsMetrics implements OnModuleInit {
  constructor(
    private readonly metrics: MetricsService,
    private readonly controls: ControlsRepository,
  ) {}

  onModuleInit(): void {
    const registers = [this.metrics.registry];
    const controls = this.controls;
    new Gauge({
      name: 'jobwork_queue_items',
      help: 'Items waiting in each work queue (the command-center count).',
      labelNames: ['queue'],
      registers,
      async collect() {
        for (const q of (await controls.snapshot()).queues) this.set({ queue: q.key }, q.count);
      },
    });
    new Gauge({
      name: 'jobwork_queue_oldest_age_seconds',
      help: 'How long the oldest item in each work queue has waited.',
      labelNames: ['queue'],
      registers,
      async collect() {
        const s = await controls.snapshot();
        for (const q of s.queues) this.set({ queue: q.key }, q.oldestWaitingSince ? Math.max(0, (s.at.getTime() - q.oldestWaitingSince.getTime()) / 1000) : 0);
      },
    });
    new Gauge({
      name: 'jobwork_queue_overdue',
      help: 'Items past their service target in each work queue.',
      labelNames: ['queue'],
      registers,
      async collect() {
        for (const q of (await controls.snapshot()).queues) this.set({ queue: q.key }, q.overdue);
      },
    });
    new Gauge({
      name: 'jobwork_outbox_events',
      help: 'Outbox events not yet delivered, by status; dead is a poison message waiting for a person.',
      labelNames: ['status'],
      registers,
      async collect() {
        const { outbox } = (await controls.snapshot()).platform;
        this.set({ status: 'pending' }, outbox.pending);
        this.set({ status: 'processing' }, outbox.processing);
        this.set({ status: 'dead' }, outbox.dead);
      },
    });
    new Gauge({
      name: 'jobwork_outbox_oldest_pending_age_seconds',
      help: 'Age of the oldest undelivered outbox event (doc 12 §1 critical event enqueue).',
      registers,
      async collect() {
        this.set((await controls.snapshot()).platform.outbox.oldestPendingSeconds);
      },
    });
    new Gauge({
      name: 'jobwork_scan_backlog',
      help: 'Files in quarantine waiting for a scan verdict.',
      registers,
      async collect() {
        this.set((await controls.snapshot()).platform.scan.backlog);
      },
    });
    new Gauge({
      name: 'jobwork_scan_oldest_age_seconds',
      help: 'Age of the oldest file waiting for a scan verdict.',
      registers,
      async collect() {
        this.set((await controls.snapshot()).platform.scan.oldestSeconds);
      },
    });
    new Gauge({
      name: 'jobwork_notification_deliveries',
      help: 'Notification delivery attempts that failed in the last hour, or have been sending for over 15 minutes.',
      labelNames: ['state'],
      registers,
      async collect() {
        const { deliveries } = (await controls.snapshot()).platform;
        this.set({ state: 'failed_last_hour' }, deliveries.failedLastHour);
        this.set({ state: 'stuck_sending' }, deliveries.stuckSending);
      },
    });
  }
}
