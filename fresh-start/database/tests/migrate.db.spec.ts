import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureDatabase, runMigrations } from '../src/migrate';

const BASE_URL = process.env['DATABASE_URL'] ?? 'postgres://localhost:5432/jobwork_dev';
const TEST_DB = `jobwork_migtest_${process.pid}`;

function testDbUrl(): string {
  const url = new URL(BASE_URL);
  url.pathname = `/${TEST_DB}`;
  return url.toString();
}

async function dropTestDb(): Promise<void> {
  const adminUrl = new URL(BASE_URL);
  adminUrl.pathname = '/postgres';
  const client = new Client({ connectionString: adminUrl.toString() });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS "${TEST_DB}" WITH (FORCE)`);
  } finally {
    await client.end();
  }
}

describe('migration runner', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jobwork-mig-'));

  beforeAll(async () => {
    writeFileSync(join(dir, '0001_first.sql'), 'CREATE TABLE mig_demo (id int primary key);');
    writeFileSync(join(dir, '0002_second.sql'), "ALTER TABLE mig_demo ADD COLUMN label text NOT NULL DEFAULT '';");
    await dropTestDb();
    await ensureDatabase(testDbUrl());
  });

  afterAll(async () => {
    await dropTestDb();
  });

  it('applies pending migrations in order and is idempotent on re-run', async () => {
    const first = await runMigrations(testDbUrl(), dir);
    expect(first.applied).toEqual(['0001_first.sql', '0002_second.sql']);

    const second = await runMigrations(testDbUrl(), dir);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(['0001_first.sql', '0002_second.sql']);
  });

  it('fails hard when an applied migration file is edited (checksum drift)', async () => {
    writeFileSync(join(dir, '0001_first.sql'), 'CREATE TABLE mig_demo (id bigint primary key);');
    await expect(runMigrations(testDbUrl(), dir)).rejects.toThrow(/drift/);
  });

  it('rolls back a failing migration atomically', async () => {
    writeFileSync(
      join(dir, '0003_bad.sql'),
      'CREATE TABLE mig_ok (id int); CREATE TABLE mig_demo (id int);',
    );
    writeFileSync(join(dir, '0001_first.sql'), 'CREATE TABLE mig_demo (id int primary key);');
    await expect(runMigrations(testDbUrl(), dir)).rejects.toThrow(/0003_bad/);

    const client = new Client({ connectionString: testDbUrl() });
    await client.connect();
    try {
      const leaked = await client.query(
        `SELECT 1 FROM information_schema.tables WHERE table_name = 'mig_ok'`,
      );
      expect(leaked.rowCount).toBe(0);
    } finally {
      await client.end();
    }
  });
});
