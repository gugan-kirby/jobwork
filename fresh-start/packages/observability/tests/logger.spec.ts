import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/logger';
import { withCorrelation } from '../src/context';

function captureLine(fn: (log: ReturnType<typeof createLogger>) => void): Record<string, unknown> {
  let line = '';
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    line += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    fn(createLogger({ service: 'test' }));
  } finally {
    process.stdout.write = original;
  }
  return JSON.parse(line) as Record<string, unknown>;
}

describe('logger', () => {
  it('redacts sensitive fields', () => {
    const parsed = captureLine((log) =>
      log.info({ password: 'hunter2', nested: { token: 'abc' } }, 'msg'),
    );
    expect(parsed['password']).toBe('[redacted]');
    expect((parsed['nested'] as Record<string, unknown>)['token']).toBe('[redacted]');
  });

  it('injects correlation id from async context', () => {
    const parsed = captureLine((log) =>
      withCorrelation({ correlationId: 'corr-123' }, () => log.info('msg')),
    );
    expect(parsed['correlationId']).toBe('corr-123');
    expect(parsed['service']).toBe('test');
  });
});
