import { Counter, createRegistry, Gauge, Histogram, type Registry, safeLabel } from '@jobwork/observability';
import type { OutcomeObserver } from './outbox/poller';

export type SweepReport = (outcome: 'ok' | 'failed') => void;

export interface WorkerMetrics {
  registry: Registry;
  observeOutbox: OutcomeObserver;
  sweep: (name: string) => SweepReport;
}

/**
 * The worker's metrics (doc 12 §§1, 6; F-11.3): what it did with each outbox event, how
 * long after commit (the "critical event enqueue" objective is measured here, commit to
 * handled), and whether each timed sweep succeeded. Event types and sweep names are a
 * fixed set, so they are safe labels.
 */
export function createWorkerMetrics(version: string): WorkerMetrics {
  const registry = createRegistry({ service: 'worker', version });
  const registers = [registry];
  const handled = new Counter({ name: 'jobwork_outbox_handled_total', help: 'Outbox events handled by the worker, by event type and outcome.', labelNames: ['event_type', 'outcome'], registers });
  const duration = new Histogram({
    name: 'jobwork_outbox_handler_duration_seconds',
    help: 'Time spent in an outbox handler, provider calls included.',
    labelNames: ['event_type'],
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
    registers,
  });
  const lag = new Histogram({
    name: 'jobwork_outbox_lag_seconds',
    help: 'Commit to handled, per outbox event (doc 12 §1: critical event enqueue p95 under 30 s).',
    buckets: [0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 900],
    registers,
  });
  const sweeps = new Counter({ name: 'jobwork_worker_sweeps_total', help: 'Timed sweeps the worker asked the API to run, by sweep and outcome.', labelNames: ['sweep', 'outcome'], registers });
  const lastOk = new Gauge({ name: 'jobwork_worker_sweep_last_success_timestamp_seconds', help: 'When each sweep last succeeded (Unix time).', labelNames: ['sweep'], registers });
  return {
    registry,
    observeOutbox: (eventType, outcome, seconds, lagSeconds) => {
      const type = safeLabel(eventType);
      handled.inc({ event_type: type, outcome });
      duration.observe({ event_type: type }, seconds);
      if (outcome === 'delivered') lag.observe(lagSeconds);
    },
    sweep: (name) => (outcome) => {
      sweeps.inc({ sweep: name, outcome });
      if (outcome === 'ok') lastOk.set({ sweep: name }, Date.now() / 1000);
    },
  };
}
