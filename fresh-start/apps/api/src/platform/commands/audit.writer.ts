import { Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import type { AuditSpec, CommandContext } from './command';

/**
 * Appends audit events. Inside a command this runs on the command's transaction (BR-SYS-02);
 * security telemetry that has no aggregate mutation may write directly on the pool.
 */
@Injectable()
export class AuditWriter {
  constructor(private readonly db: DatabaseService) {}

  async write(
    client: Pool | PoolClient | null,
    ctx: CommandContext,
    spec: AuditSpec,
  ): Promise<void> {
    await (client ?? this.db.pool).query(
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
