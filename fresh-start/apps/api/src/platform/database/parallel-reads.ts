/**
 * Several reads at once: in parallel on the pool, one after another on a transaction.
 * A transaction is one connection, and a pg client runs one query at a time; overlapping
 * calls on it are queued today, deprecated, and removed in pg 9. Reads that share a
 * transaction therefore go in sequence, and the same code stays parallel outside one.
 */
export async function parallelReads<T extends unknown[]>(tx: unknown, reads: { [K in keyof T]: () => Promise<T[K]> }): Promise<T> {
  if (!tx) return (await Promise.all(reads.map((read) => read()))) as T;
  const results: unknown[] = [];
  for (const read of reads) results.push(await read());
  return results as T;
}
