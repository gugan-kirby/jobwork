import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Client } from 'pg';
import { registerPgTypeParsers, runMigrations } from '@jobwork/database';

registerPgTypeParsers();

export interface TestDatabase {
  url: string;
  name: string;
  drop(): Promise<void>;
}

const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', 'database', 'migrations');

function baseUrl(): string {
  return process.env['DATABASE_URL'] ?? 'postgres://localhost:5432/jobwork_dev';
}

/**
 * Creates an isolated database with all real migrations applied.
 * Factories must opt in explicitly to any cross-organization fixture (ES-21).
 */
export async function createTestDatabase(prefix = 'jobwork_test'): Promise<TestDatabase> {
  const name = `${prefix}_${randomBytes(6).toString('hex')}`;
  const adminUrl = new URL(baseUrl());
  adminUrl.pathname = '/postgres';
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }

  const url = new URL(baseUrl());
  url.pathname = `/${name}`;
  await runMigrations(url.toString(), MIGRATIONS_DIR);

  return {
    url: url.toString(),
    name,
    async drop(): Promise<void> {
      const adminDrop = new Client({ connectionString: adminUrl.toString() });
      await adminDrop.connect();
      try {
        await adminDrop.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await adminDrop.end();
      }
    },
  };
}
