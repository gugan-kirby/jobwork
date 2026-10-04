import { AsyncLocalStorage } from 'node:async_hooks';

interface CorrelationContext {
  correlationId: string;
  causationId?: string;
}

export const correlationStorage = new AsyncLocalStorage<CorrelationContext>();

export function getCorrelationId(): string | undefined {
  return correlationStorage.getStore()?.correlationId;
}

export function withCorrelation<T>(
  context: CorrelationContext,
  fn: () => T,
): T {
  return correlationStorage.run(context, fn);
}
