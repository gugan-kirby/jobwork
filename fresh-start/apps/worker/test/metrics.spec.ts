import { describe, expect, it } from 'vitest';
import { idShapedLabelValues } from '@jobwork/observability';
import { createWorkerMetrics } from '../src/metrics';

/** F-11.3: the worker reports outcomes, commit-to-handled lag and sweep health. */
describe('worker metrics', () => {
  it('counts handled events, measures lag on delivery, and records sweep health', async () => {
    const m = createWorkerMetrics('dev');
    m.observeOutbox('dms.file_finalized', 'delivered', 0.2, 3);
    m.observeOutbox('dms.file_finalized', 'retry', 0.1, 4);
    m.observeOutbox('01a107c5-eb3e-7049-9996-e254da3b4004', 'dead', 0.1, 9);
    m.sweep('sla')('ok');
    m.sweep('rfq_deadline')('failed');
    const text = await m.registry.metrics();
    expect(text).toContain('jobwork_outbox_handled_total{event_type="dms.file_finalized",outcome="delivered",service="worker"} 1');
    expect(text).toContain('jobwork_outbox_handled_total{event_type="dms.file_finalized",outcome="retry",service="worker"} 1');
    // Only deliveries count towards the enqueue objective; a retry is not "handled".
    expect(text).toContain('jobwork_outbox_lag_seconds_count{service="worker"} 1');
    expect(text).toContain('jobwork_worker_sweeps_total{sweep="rfq_deadline",outcome="failed",service="worker"} 1');
    expect(text).toMatch(/jobwork_worker_sweep_last_success_timestamp_seconds\{sweep="sla",service="worker"\} \d+/);
    expect(text).not.toMatch(/sweep_last_success_timestamp_seconds\{[^}]*rfq_deadline/);
    // An identifier where an event type belongs never becomes a series of its own.
    expect(text).toContain('event_type="other",outcome="dead"');
    expect(idShapedLabelValues(text)).toEqual([]);
  });
});
