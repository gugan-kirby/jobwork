import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestDatabase, type TestDatabase } from '@jobwork/test-kit';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const ROOT = join(__dirname, '..', '..', '..');
const RUNBOOKS = join(ROOT, 'docs', 'runbooks');

function runbooks(): Array<{ file: string; text: string }> {
  return readdirSync(RUNBOOKS)
    .filter((f) => f.endsWith('.md'))
    .map((file) => ({ file, text: readFileSync(join(RUNBOOKS, file), 'utf8') }));
}

function blocks(text: string, lang: string): string[] {
  return [...text.matchAll(new RegExp('```' + lang + '\\n([\\s\\S]*?)```', 'g'))].map((m) => m[1]!.trim());
}

/**
 * F-11.4: a runbook is read at three in the morning by someone who did not write it. Its
 * queries must run against today's schema, it must say who may act and who speaks to
 * customers, and every paging alert must lead to one.
 */
describe('runbooks (F-11.4)', () => {
  let db: TestDatabase;
  let pg: Client;

  beforeAll(async () => {
    db = await createTestDatabase('jobwork_runbooks');
    pg = new Client({ connectionString: db.url });
    await pg.connect();
  }, 60_000);

  afterAll(async () => {
    await pg?.end();
    await db?.drop();
  });

  it('covers the doc 12 §12 set', () => {
    expect(runbooks().map((r) => r.file).sort()).toEqual([
      'README.md',
      'api-latency-error-spike.md',
      'backup-restore-failover.md',
      'compromised-account-or-secret.md',
      'cross-tenant-or-contact-exposure.md',
      'database-pressure.md',
      'file-scan-backlog.md',
      'incorrect-release-emergency-hold.md',
      'integration-outage.md',
      'notification-provider-failure.md',
      'object-storage-failure.md',
      'outbox-backlog-poison-message.md',
      'payment-callback-mismatch.md',
    ]);
  });

  it('gives every runbook its authority, communication owner, diagnosis, mitigation, recovery check and review', () => {
    for (const { file, text } of runbooks().filter((r) => r.file !== 'README.md')) {
      for (const part of ['| Authority |', '| Communication owner |', '| Alerts |', '| Impact |']) expect(text, `${file} ${part}`).toContain(part);
      for (const heading of ['## Verify recovery', '## After the incident']) expect(text, `${file} ${heading}`).toContain(heading);
      expect(/## (Diagnose|Restore|Required behaviour)/.test(text), `${file} diagnosis`).toBe(true);
      expect(/## (Mitigate|Restore)/.test(text), `${file} mitigation`).toBe(true);
    }
  });

  it('runs every SQL block, read-only, against the migrated schema', async () => {
    const failures: string[] = [];
    let ran = 0;
    for (const { file, text } of runbooks()) {
      for (const sql of blocks(text, 'sql')) {
        await pg.query('BEGIN READ ONLY');
        try {
          await pg.query(sql);
          ran += 1;
        } catch (err) {
          failures.push(`${file}: ${err instanceof Error ? err.message : String(err)}\n${sql.split('\n')[0]}`);
        } finally {
          await pg.query('ROLLBACK');
        }
      }
    }
    expect(failures).toEqual([]);
    expect(ran).toBeGreaterThanOrEqual(25);
  });

  it('selects no contact detail, amount, file name or message text', () => {
    const forbidden = /\b(email|phone|display_name|legal_name|body|declared_filename|amount_minor|reference_value|primary_contact_\w+|address_line\w*|destination)\b/;
    for (const { file, text } of runbooks()) {
      for (const sql of blocks(text, 'sql')) {
        const selected = sql.split(/\bFROM\b/i)[0]!;
        expect(selected, `${file}: ${sql.split('\n')[0]}`).not.toMatch(forbidden);
      }
    }
  });

  it('leads every alert to a runbook that exists', () => {
    const missing: string[] = [];
    for (const file of readdirSync(join(ROOT, 'infra', 'alerts'))) {
      const doc = parse(readFileSync(join(ROOT, 'infra', 'alerts', file), 'utf8')) as { groups: Array<{ rules: Array<{ alert: string; annotations?: Record<string, string> }> }> };
      for (const rule of doc.groups.flatMap((g) => g.rules)) {
        const link = rule.annotations?.['runbook_url'];
        if (link && !existsSync(join(ROOT, link.split('#')[0]!))) missing.push(`${rule.alert}: ${link}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
