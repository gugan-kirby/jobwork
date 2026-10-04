import type { OutboxHandler } from './types';

/** eventType → handler. An unregistered type dead-letters with a clear error (doc 07 §10). */
export class HandlerRegistry {
  private readonly handlers = new Map<string, OutboxHandler>();

  register(eventType: string, handler: OutboxHandler): this {
    if (this.handlers.has(eventType)) {
      throw new Error(`handler already registered for ${eventType}`);
    }
    this.handlers.set(eventType, handler);
    return this;
  }

  resolve(eventType: string): OutboxHandler | undefined {
    return this.handlers.get(eventType);
  }
}
