import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import type { CommandContext, OutboxSpec } from './command';

/** Writes the doc 08 §8 envelope in the same transaction as business state (BR-SYS-02). */
@Injectable()
export class OutboxWriter {
  async write(client: PoolClient, ctx: CommandContext, spec: OutboxSpec): Promise<string> {
    const eventId = uuidv7();
    await client.query(
      `INSERT INTO platform.outbox_event
         (id, event_type, aggregate_type, aggregate_id, aggregate_version,
          organization_id, actor, correlation_id, causation_id, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        eventId,
        spec.eventType,
        spec.aggregateType,
        spec.aggregateId,
        spec.aggregateVersion ?? null,
        ctx.actor.organizationId,
        JSON.stringify({ type: ctx.actor.type, id: ctx.actor.id }),
        ctx.correlationId,
        null,
        JSON.stringify(spec.data),
      ],
    );
    return eventId;
  }
}
