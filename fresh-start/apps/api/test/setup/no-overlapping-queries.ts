import { afterAll } from 'vitest';

/**
 * A transaction is one connection, and pg runs one query on it at a time. Overlapping
 * calls are queued today, deprecated, and removed in pg 9. pg only warns once per process,
 * so the warning is collected here and fails the file that caused it. Use
 * `parallelReads(tx, …)` for reads that share a transaction.
 */
const overlapping: string[] = [];
process.on('warning', (warning) => {
  if (/already executing a query/.test(warning.message)) overlapping.push(warning.message);
});

afterAll(() => {
  if (overlapping.length > 0) {
    throw new Error(`queries overlapped on one connection (${overlapping.length}): ${overlapping[0]}`);
  }
});
