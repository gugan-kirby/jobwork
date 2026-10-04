import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestDatabase, type TestDatabase } from '@jobwork/test-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { MetricsService } from '../src/platform/metrics/metrics.service';
import { createWorkerMetrics } from '../../worker/src/metrics';
import { createTestApp } from './helpers/boot';

const INFRA = join(__dirname, '..', '..', '..', 'infra');

interface Rule {
  alert: string;
  expr: string;
  for?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

/** Labels an alert or a panel may select or group on: all small, fixed sets. */
const KNOWN_LABELS = new Set([
  'job', 'service', 'version', 'le', 'method', 'route', 'status_code', 'caller', 'queue', 'status', 'state',
  'event', 'outcome', 'sweep', 'operation', 'operation_class', 'dimension', 'event_type',
]);

const METRIC_TOKEN = /\b(?:jobwork_[a-z0-9_]+|http_server_[a-z0-9_]+|process_[a-z0-9_]+|nodejs_[a-z0-9_]+)\b/g;
const HISTOGRAM_SUFFIX = /_(bucket|count|sum)$/;

function rules(): Array<Rule & { file: string }> {
  return readdirSync(join(INFRA, 'alerts'))
    .filter((f) => f.endsWith('.yaml'))
    .flatMap((file) => {
      const doc = parse(readFileSync(join(INFRA, 'alerts', file), 'utf8')) as { groups: Array<{ rules: Rule[] }> };
      return doc.groups.flatMap((g) => g.rules.map((r) => ({ ...r, file })));
    });
}

function dashboardExprs(): Array<{ dashboard: string; panel: string; expr: string }> {
  return readdirSync(join(INFRA, 'dashboards'))
    .filter((f) => f.endsWith('.json'))
    .flatMap((file) => {
      const d = JSON.parse(readFileSync(join(INFRA, 'dashboards', file), 'utf8')) as { title: string; panels: Array<{ title: string; targets: Array<{ expr: string }> }> };
      return d.panels.flatMap((p) => p.targets.map((t) => ({ dashboard: d.title, panel: p.title, expr: t.expr })));
    });
}

function labelNames(expr: string): string[] {
  const matchers = [...expr.matchAll(/([a-z_]+)\s*(?:=~|!~|!=|=)\s*"/g)].map((m) => m[1]!);
  const grouped = [...expr.matchAll(/\b(?:by|without)\s*\(([^)]*)\)/g)].flatMap((m) => m[1]!.split(',').map((s) => s.trim()).filter(Boolean));
  return [...matchers, ...grouped];
}

/**
 * F-11.3: the alert rules and dashboards are code, and they rot like code — a renamed
 * metric silently turns an alert into one that can never fire. This suite reads the
 * metric names the API and the worker actually register and holds every expression to
 * them, and holds every alert to doc 12 §8.
 */
describe('alert rules and dashboards (F-11.3)', () => {
  let db: TestDatabase;
  let app: NestFastifyApplication;
  const registered = new Set<string>(['up']);

  beforeAll(async () => {
    db = await createTestDatabase('jobwork_alerts');
    process.env['DATABASE_URL'] = db.url;
    process.env['SESSION_SECRET'] = 'test-secret-value';
    process.env['NODE_ENV'] = 'test';
    ({ app } = await createTestApp());
    for (const m of await app.get(MetricsService).registry.getMetricsAsJSON()) registered.add(m.name);
    for (const m of await createWorkerMetrics('dev').registry.getMetricsAsJSON()) registered.add(m.name);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  it('holds every alert to doc 12 §8: owner, severity, impact, recovery, and a runbook for every page', () => {
    const all = rules();
    expect(all.length).toBeGreaterThanOrEqual(20);
    expect(new Set(all.map((r) => r.alert)).size).toBe(all.length);
    for (const r of all) {
      const where = `${r.file}: ${r.alert}`;
      expect(['page', 'ticket'], where).toContain(r.labels?.['severity']);
      expect(r.labels?.['owner'], where).toMatch(/^[a-z]+$/);
      for (const key of ['summary', 'impact', 'recovery']) expect(r.annotations?.[key], `${where} ${key}`).toBeTruthy();
      if (r.labels?.['severity'] === 'page') expect(r.annotations?.['runbook_url'], where).toMatch(/^docs\/runbooks\/[a-z0-9-]+\.md$/);
    }
  });

  it('keeps alert payloads free of templated values (doc 12 §8: no customer, supplier, file or payment data)', () => {
    for (const r of rules()) {
      for (const [key, value] of Object.entries({ ...r.labels, ...r.annotations })) {
        expect(value, `${r.alert} ${key}`).not.toMatch(/\{\{|\$labels|\$value/);
      }
    }
  });

  it('names only metrics the API and worker register, in alerts and dashboards alike', () => {
    const exprs = [...rules().map((r) => ({ where: r.alert, expr: r.expr })), ...dashboardExprs().map((d) => ({ where: `${d.dashboard} / ${d.panel}`, expr: d.expr }))];
    const unknown: string[] = [];
    for (const { where, expr } of exprs) {
      for (const token of expr.match(METRIC_TOKEN) ?? []) {
        const base = registered.has(token) ? token : token.replace(HISTOGRAM_SUFFIX, '');
        if (!registered.has(base)) unknown.push(`${where}: ${token}`);
      }
      if (/\bup\{/.test(expr)) expect(expr, where).toMatch(/job="jobwork-(api|worker)"/);
    }
    expect(unknown).toEqual([]);
  });

  it('selects and groups only on small, fixed label sets', () => {
    const exprs = [...rules().map((r) => ({ where: r.alert, expr: r.expr })), ...dashboardExprs().map((d) => ({ where: d.panel, expr: d.expr }))];
    const odd = exprs.flatMap(({ where, expr }) => labelNames(expr).filter((l) => !KNOWN_LABELS.has(l)).map((l) => `${where}: ${l}`));
    expect(odd).toEqual([]);
  });

  it('gives every dashboard a data-source variable and unique panel ids', () => {
    for (const file of readdirSync(join(INFRA, 'dashboards')).filter((f) => f.endsWith('.json'))) {
      const d = JSON.parse(readFileSync(join(INFRA, 'dashboards', file), 'utf8')) as { uid: string; templating: { list: Array<{ name: string }> }; panels: Array<{ id: number; datasource: { uid: string } }> };
      expect(d.uid, file).toMatch(/^jobwork-/);
      expect(d.templating.list.map((v) => v.name), file).toContain('datasource');
      expect(new Set(d.panels.map((p) => p.id)).size, file).toBe(d.panels.length);
      for (const p of d.panels) expect(p.datasource.uid, file).toBe('${datasource}');
    }
  });
});
