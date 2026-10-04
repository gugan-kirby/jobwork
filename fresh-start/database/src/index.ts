// Public surface of @jobwork/database (ES-03): migrations, and the Postgres type
// parsers every process that opens a pool must register.
export {
  ensureDatabase,
  listMigrationFiles,
  migrationStatus,
  runMigrations,
  type MigrationResult,
  type MigrationStatusRow,
} from './migrate';
export { registerPgTypeParsers } from './pg-types';
