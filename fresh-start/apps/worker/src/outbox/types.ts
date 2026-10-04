export interface OutboxEventRow {
  id: string;
  eventType: string;
  occurredAt: Date;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: number | null;
  organizationId: string | null;
  actor: { type: string; id: string | null };
  correlationId: string;
  data: Record<string, unknown>;
  attempts: number;
}

export interface HandlerResult {
  /** Keys removed from the stored event data after successful delivery (transient secrets). */
  stripDataKeys?: string[];
}

export type OutboxHandler = (event: OutboxEventRow) => Promise<HandlerResult | void>;
