import { join } from 'node:path';
import { ensureDatabase, migrationStatus, runMigrations } from './migrate';

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'up';
  const databaseUrl = process.env['DATABASE_URL'] ?? 'postgres://localhost:5432/jobwork_dev';
  const dryRun = process.argv.includes('--dry-run');

  if (command === 'up') {
    await ensureDatabase(databaseUrl);
    const result = await runMigrations(databaseUrl, MIGRATIONS_DIR, { dryRun });
    for (const f of result.applied) console.log(`${dryRun ? 'pending' : 'applied'}: ${f}`);
    console.log(
      `${dryRun ? 'would apply' : 'applied'} ${result.applied.length}, up-to-date ${result.skipped.length}`,
    );
    return;
  }
  if (command === 'status') {
    const rows = await migrationStatus(databaseUrl, MIGRATIONS_DIR);
    for (const r of rows) {
      console.log(`${r.appliedAt ? r.appliedAt.toISOString() : 'PENDING            '}  ${r.name}`);
    }
    return;
  }
  console.error(`unknown command: ${command} (use up|status)`);
  process.exitCode = 2;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
