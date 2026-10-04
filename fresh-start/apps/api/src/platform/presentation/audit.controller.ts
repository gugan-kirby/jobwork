import { Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentActor } from '../http/actor.decorator';
import { DomainError } from '../http/domain-error';
import { parseBody } from '../http/validation';
import { DatabaseService } from '../database/database.service';
import { RateLimit } from '../http/rate-limit/rate-limit.decorator';

/** Platform sees only the actor shape the guard attaches — no dependency on the iam module. */
interface ActorLike {
  isInternal: boolean;
  roles: string[];
}

const auditQuerySchema = z.object({
  action: z.string().max(120).optional(),
  subjectType: z.string().max(60).optional(),
  subjectId: z.string().max(120).optional(),
  actorId: z.uuid().optional(),
  /** The organization the command was issued *from* — who did things, not what was done to. */
  organizationId: z.uuid().optional(),
  /**
   * Everything about one organization, wherever it is filed: the organization row itself,
   * and the membership, user and profile events that name it in their payload. Without
   * this, "the history of this customer" silently means "the two events whose subject id
   * happens to be the organization", which reads as a system that forgets.
   */
  aboutOrganizationId: z.uuid().optional(),
  correlationId: z.string().max(80).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
});

interface AuditRow {
  id: string;
  occurredAt: Date;
  actorType: string;
  actorId: string | null;
  organizationId: string | null;
  action: string;
  subjectType: string;
  subjectId: string;
  subjectVersion: number | null;
  reason: string | null;
  correlationId: string;
  data: Record<string, unknown>;
}

/** Read-only audit explorer (UC-37 read path); filter allowlist + stable cursor (doc 08 §4). */
@Controller('audit-events')
export class AuditController {
  constructor(private readonly db: DatabaseService) {}

  @RateLimit('search')
  @Get()
  async list(
    @CurrentActor() actor: ActorLike,
    @Query() query: unknown,
  ): Promise<{ events: AuditRow[]; nextCursor: string | null }> {
    const allowed = ['security_admin', 'auditor', 'platform_admin'];
    if (!actor.isInternal || !allowed.some((r) => actor.roles.includes(r))) {
      throw new DomainError('NOT_AUTHORIZED', 403, 'Not authorized');
    }

    const q = parseBody(auditQuerySchema, query);
    const conditions: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown): void => {
      params.push(value);
      conditions.push(sql.replace('?', `$${params.length}`));
    };
    if (q.action) add('action = ?', q.action);
    if (q.subjectType) add('subject_type = ?', q.subjectType);
    if (q.subjectId) add('subject_id = ?', q.subjectId);
    if (q.actorId) add('actor_id = ?', q.actorId);
    if (q.organizationId) add('organization_id = ?', q.organizationId);
    if (q.aboutOrganizationId) {
      params.push(q.aboutOrganizationId);
      const i = params.length;
      conditions.push(
        `((subject_type = 'organization' AND subject_id = $${i}::text)
          OR data->>'organizationId' = $${i}::text
          OR organization_id = $${i}::uuid)`,
      );
    }
    if (q.correlationId) add('correlation_id = ?', q.correlationId);
    if (q.cursor) {
      const [ts, id] = Buffer.from(q.cursor, 'base64url').toString().split('|');
      params.push(ts, id);
      conditions.push(`(occurred_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
    }
    params.push(q.limit + 1);

    const res = await this.db.pool.query(
      `SELECT id, occurred_at AS "occurredAt", actor_type AS "actorType", actor_id AS "actorId",
              organization_id AS "organizationId", action, subject_type AS "subjectType",
              subject_id AS "subjectId", subject_version AS "subjectVersion", reason,
              correlation_id AS "correlationId", data
         FROM platform.audit_event
        ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
        ORDER BY occurred_at DESC, id DESC
        LIMIT $${params.length}`,
      params,
    );
    const rows = res.rows as AuditRow[];
    const hasMore = rows.length > q.limit;
    const events = hasMore ? rows.slice(0, q.limit) : rows;
    const last = events[events.length - 1];
    const nextCursor =
      hasMore && last
        ? Buffer.from(`${last.occurredAt.toISOString()}|${last.id}`).toString('base64url')
        : null;
    return { events, nextCursor };
  }
}
