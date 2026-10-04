import { createServer, type Server } from 'node:http';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

export { Counter, Gauge, Histogram, Registry };

/**
 * Metrics (doc 12 §6; `ES-35`; F-11.3), in the Prometheus exposition format every
 * candidate under `T-01` ingests.
 *
 * Two rules the code enforces rather than trusts:
 * - Identifiers never become label values (doc 12 §6 "keep high-cardinality IDs out of
 *   metric labels"): `safeLabel` turns anything id-shaped — a UUID, an e-mail address, a
 *   long number, a hash — into `other` before it reaches a series.
 * - Metrics are served on their own port, never by the public listener: a scrape is an
 *   operator's view of the platform, and the public edge must not be able to request it.
 */

const ID_SHAPED: readonly RegExp[] = [
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  /[^\s@]+@[^\s@]+\.[^\s@]+/,
  /\d{5,}/,
  /[0-9a-f]{16,}/i,
];

export function isSafeLabelValue(value: string): boolean {
  return !ID_SHAPED.some((pattern) => pattern.test(value));
}

export function safeLabel(value: string | null | undefined, fallback = 'other'): string {
  if (!value) return fallback;
  return isSafeLabelValue(value) ? value : fallback;
}

/** The registry for one process, with process metrics and the build it is running. */
export function createRegistry(opts: { service: string; version: string }): Registry {
  const registry = new Registry();
  registry.setDefaultLabels({ service: opts.service });
  collectDefaultMetrics({ register: registry });
  const build = new Gauge({
    name: 'jobwork_build_info',
    help: 'The build this process runs; always 1 (doc 23 §3 deploy-version dashboards).',
    labelNames: ['version'],
    registers: [registry],
  });
  build.set({ version: opts.version }, 1);
  return registry;
}

/** Serves `GET /metrics` and nothing else. */
export async function startMetricsServer(registry: Registry, opts: { port: number; host: string }): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/metrics') {
      res.writeHead(404).end();
      return;
    }
    registry
      .metrics()
      .then((body) => {
        res.writeHead(200, { 'content-type': registry.contentType }).end(body);
      })
      .catch(() => {
        res.writeHead(500).end();
      });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => resolve());
  });
  return server;
}

/**
 * Label values in an exposition that look like identifiers — the test-side check that
 * `safeLabel` was not forgotten somewhere. `jobwork_build_info` is exempt: its version
 * label is a commit hash on purpose, and it is one series.
 */
export function idShapedLabelValues(exposition: string): string[] {
  const found: string[] = [];
  for (const line of exposition.split('\n')) {
    if (line.startsWith('#') || line.startsWith('jobwork_build_info')) continue;
    const labels = line.match(/\{(.*)\}/)?.[1];
    if (!labels) continue;
    for (const match of labels.matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)) {
      const value = match[2] ?? '';
      if (!isSafeLabelValue(value)) found.push(`${match[1]}=${value}`);
    }
  }
  return found;
}
