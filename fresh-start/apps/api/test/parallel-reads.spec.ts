import { describe, expect, it } from 'vitest';
import { parallelReads } from '../src/platform/database/parallel-reads';

describe('parallelReads', () => {
  function recorder() {
    const log: string[] = [];
    const read = (name: string, ms: number) => async (): Promise<string> => {
      log.push(`start ${name}`);
      await new Promise((resolve) => setTimeout(resolve, ms));
      log.push(`end ${name}`);
      return name;
    };
    return { log, read };
  }

  it('runs reads one after another on a transaction, in order', async () => {
    const { log, read } = recorder();
    const result = await parallelReads({ transaction: true }, [read('a', 20), read('b', 1)]);
    expect(result).toEqual(['a', 'b']);
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b']);
  });

  it('runs them together on the pool', async () => {
    const { log, read } = recorder();
    const result = await parallelReads(undefined, [read('a', 20), read('b', 1)]);
    expect(result).toEqual(['a', 'b']);
    expect(log.slice(0, 2)).toEqual(['start a', 'start b']);
  });
});
