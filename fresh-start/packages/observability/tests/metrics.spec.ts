import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { Counter, createRegistry, idShapedLabelValues, isSafeLabelValue, safeLabel, startMetricsServer } from '../src/metrics';

/** F-11.3: identifiers stay out of labels, and metrics are served apart from the API. */
describe('metrics', () => {
  let server: Server | null = null;

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = null;
  });

  it('turns id-shaped label values into "other"', () => {
    for (const value of ['01a107c5-eb3e-7049-9996-e254da3b4004', 'buyer@kovai.test', 'ENQ-2026-123456', 'a3f5c9e1b2d4f6a8c0e2']) {
      expect(isSafeLabelValue(value), value).toBe(false);
      expect(safeLabel(value)).toBe('other');
    }
    for (const value of ['/api/v1/queues/:queueKey/items/:subjectId/take', 'enquiries_awaiting_triage', 'POST', '429', 'customer']) {
      expect(safeLabel(value)).toBe(value);
    }
    expect(safeLabel(undefined, 'anonymous')).toBe('anonymous');
  });

  it('labels every series with the service and exposes the build', async () => {
    const registry = createRegistry({ service: 'api', version: '3f2a9c1d0e4b5a6978c1d2e3f4a5b6c7d8e9f0a1' });
    const text = await registry.metrics();
    expect(text).toContain('jobwork_build_info{version="3f2a9c1d0e4b5a6978c1d2e3f4a5b6c7d8e9f0a1",service="api"} 1');
    expect(text).toMatch(/process_cpu_user_seconds_total\{service="api"\}/);
    // The build's hash is the one deliberate exception.
    expect(idShapedLabelValues(text)).toEqual([]);
  });

  it('finds an identifier that slipped into a label', async () => {
    const registry = createRegistry({ service: 'api', version: 'dev' });
    const counter = new Counter({ name: 'leaky_total', help: 'test', labelNames: ['subject'], registers: [registry] });
    counter.inc({ subject: '01a107c5-eb3e-7049-9996-e254da3b4004' });
    expect(idShapedLabelValues(await registry.metrics())).toEqual(['subject=01a107c5-eb3e-7049-9996-e254da3b4004']);
  });

  it('serves /metrics on its own port and nothing else', async () => {
    const registry = createRegistry({ service: 'worker', version: 'dev' });
    server = await startMetricsServer(registry, { port: 0, host: '127.0.0.1' });
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const ok = await fetch(`http://127.0.0.1:${port}/metrics`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toContain('text/plain');
    expect(await ok.text()).toContain('jobwork_build_info');
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/metrics`, { method: 'POST' })).status).toBe(404);
  });
});
