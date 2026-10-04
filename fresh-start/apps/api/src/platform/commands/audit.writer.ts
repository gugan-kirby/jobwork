import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { AuditSpec, CommandContext } from './command';

/**
 * Appends audit events, always on the transaction of the change they record (BR-SYS-02).
 * The client is required: an audit row written after a commit can be lost while the
 * change stands, and the IN-12 review found nine places that did exactly that.
 */
@Injectable()
export class AuditWriter {
  /**
   * Always inside the caller's transaction (`BR-SYS-02`): the audit row commits with the
   * change it records, or neither does. There is deliberately no pool fallback.
   */
  async write(client: PoolClient, ctx: CommandContext, spec: AuditSpec): Promise<void> {
    await client.query(
      `INSERT INTO platform.audit_event
         (actor_type, actor_id, organization_id, action, subject_type, subject_id,
          subject_version, reason, correlation_id, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        ctx.actor.type,
        ctx.actor.id,
        ctx.actor.organizationId,
        spec.action,
        spec.subjectType,
        spec.subjectId,
        spec.subjectVersion ?? null,
        spec.reason ?? null,
        ctx.correlationId,
        JSON.stringify(spec.data ?? {}),
      ],
    );
  }
}
