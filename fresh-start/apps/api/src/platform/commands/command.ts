import type { PoolClient } from 'pg';
import { getCorrelationId } from '@jobwork/observability';

export interface CommandActor {
  type: 'user' | 'service' | 'system';
  id: string | null;
  organizationId: string | null;
}

export interface CommandContext {
  actor: CommandActor;
  correlationId: string;
}

export function contextFromActor(actor: {
  userId: string;
  organizationId: string | null;
}): CommandContext {
  return {
    actor: { type: 'user', id: actor.userId, organizationId: actor.organizationId },
    correlationId: getCorrelationId() ?? 'uncorrelated',
  };
}

/** Internal commands run as a named service principal, never as a user (doc 20 §9). */
export function contextFromService(
  principal: { id: string },
  organizationId: string | null,
): CommandContext {
  return {
    actor: { type: 'service', id: principal.id, organizationId },
    correlationId: getCorrelationId() ?? 'uncorrelated',
  };
}

export interface AuditSpec {
  action: string;
  subjectType: string;
  subjectId: string;
  subjectVersion?: number;
  reason?: string;
  /** Minimized safe references only — never secrets, prices, or file content (doc 05 §12). */
  data?: Record<string, unknown>;
}

export interface OutboxSpec {
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion?: number;
  data: Record<string, unknown>;
}

export interface CommandOutcome<TResult> {
  result: TResult;
  audit: AuditSpec[];
  outbox?: OutboxSpec[];
}

export type CommandHandler<TInput, TResult> = (
  tx: PoolClient,
  ctx: CommandContext,
  input: TInput,
) => Promise<CommandOutcome<TResult>>;

export interface CommandDefinition<TInput, TResult> {
  /** Stable operation name, e.g. `iam.invite-member`; used for idempotency scoping and audit. */
  operation: string;
  handler: CommandHandler<TInput, TResult>;
}
