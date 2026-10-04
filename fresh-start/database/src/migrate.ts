import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export interface MigrationStatusRow {
  name: string;
  checksum: string;
  appliedAt: Date | null;
}

const LOCK_KEY = 7480_2001;

function checksumOf(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

export function listMigrationFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

/** Creates the target database if it does not exist. Requires access to the `postgres` db. */
export async function ensureDatabase(databaseUrl: string): Promise<void> {
  const url = new URL(databaseUrl);
  const dbName = url.pathname.replace(/^\//, '');
  if (!dbName) throw new Error(`DATABASE_URL has no database name: ${databaseUrl}`);
  if (!/^[a-z_][a-z0-9_]*$/.test(dbName)) {
    throw new Error(`unsupported database name (expected [a-z_][a-z0-9_]*): ${dbName}`);
  }
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = '/postgres';
  const client = new Client({ connectionString: adminUrl.toString() });
  await client.connect();
  try {
    const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (exists.rowCount === 0) {
      await client.query(`CREATE DATABASE "${dbName}"`);
    }
  } finally {
    await client.end();
  }
}

export async function runMigrations(
  databaseUrl: string,
  migrationsDir: string,
  opts: { dryRun?: boolean } = {},
): Promise<MigrationResult> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const applied: string[] = [];
  const skipped: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const appliedRows = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM schema_migrations',
    );
    const appliedMap = new Map(appliedRows.rows.map((r) => [r.name, r.checksum]));

    for (const file of listMigrationFiles(migrationsDir)) {
      const sql = readFileSync(join(migrationsDir, file), 'utf8');
      const checksum = checksumOf(sql);
      const prior = appliedMap.get(file);
      if (prior !== undefined) {
        if (prior !== checksum) {
          throw new Error(
            `migration drift: ${file} was edited after being applied (checksum mismatch). ` +
              'Applied migrations are immutable; write a new migration instead.',
          );
        }
        skipped.push(file);
        continue;
      }
      if (opts.dryRun) {
        applied.push(file);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
          file,
          checksum,
        ]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${err instanceof Error ? err.message : err}`);
      }
      applied.push(file);
    }
    return { applied, skipped };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    await client.end();
  }
}

export async function migrationStatus(
  databaseUrl: string,
  migrationsDir: string,
): Promise<MigrationStatusRow[]> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const hasTable = await client.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = 'schema_migrations'`,
    );
    const appliedMap = new Map<string, Date>();
    if ((hasTable.rowCount ?? 0) > 0) {
      const rows = await client.query<{ name: string; applied_at: Date }>(
        'SELECT name, applied_at FROM schema_migrations',
      );
      for (const r of rows.rows) appliedMap.set(r.name, r.applied_at);
    }
    return listMigrationFiles(migrationsDir).map((name) => ({
      name,
      checksum: checksumOf(readFileSync(join(migrationsDir, name), 'utf8')),
      appliedAt: appliedMap.get(name) ?? null,
    }));
  } finally {
    await client.end();
  }
}
