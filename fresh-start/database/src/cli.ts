import { join } from 'node:path';
import { adminBootstrapFromEnv, bootstrapAdmin } from './bootstrap-admin';
import { ensureDatabase, migrationStatus, runMigrations } from './migrate';
import { addStaff, staffGrantFromEnv } from './staff';

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
  if (command === 'bootstrap-admin') {
    const { userId } = await bootstrapAdmin(databaseUrl, adminBootstrapFromEnv(process.env));
    console.log(`created first admin ${userId}`);
    return;
  }
  if (command === 'add-staff') {
    const result = await addStaff(databaseUrl, staffGrantFromEnv(process.env));
    console.log(`${result.created ? 'created' : 'updated'} ${result.userId}: added ${result.added.length ? result.added.join(', ') : 'nothing, every role was held'}`);
    return;
  }
  console.error(`unknown command: ${command} (use up|status|bootstrap-admin|add-staff)`);
  process.exitCode = 2;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
