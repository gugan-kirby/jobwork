import { Injectable } from '@nestjs/common';
import { createLogger, type Logger } from '@jobwork/observability';
import type { Actor } from '../../iam';
import { RfqRepository } from '../infrastructure/rfq.repository';
import { contextFromActor } from '../../../platform/commands/command';
import { CommandExecutor } from '../../../platform/commands/execute';

/**
 * The deadline sweep (F-06.6). When a round's deadline passes, every supplier still
 * holding an open invitation is dispositioned `no_response` — an explicit fact, not an
 * absence somebody has to interpret later (doc 19 §4 "all decline / no response").
 *
 * The round itself is *not* closed automatically: closing decides whether it goes to
 * evaluation or `no_bid`, and that is a person's call with an audit trail. The sweep
 * only makes the state honest, so the control room shows who never answered.
 */
@Injectable()
export class RfqDeadlineCommand {
  private readonly log: Logger = createLogger({ service: 'api' }).child({ module: 'sourcing.rfq' });

  constructor(
    private readonly repo: RfqRepository,
    private readonly executor: CommandExecutor,
  ) {}

  async sweep(
    actor: Actor,
    opts: { idempotencyKey?: string | undefined } = {},
  ): Promise<{ lapsed: number; rounds: number }> {
    const now = new Date();
    const overdue = await this.repo.listOverdueInvitations(now);
    const rounds = new Set(overdue.map((invitation) => invitation.rfqId));
    if (overdue.length === 0) return { lapsed: 0, rounds: 0 };

    return this.executor.execute(
      {
        operation: 'sourcing.rfq-deadline-sweep',
        handler: async (tx) => {
          for (const invitation of overdue) {
            await this.repo.setInvitationStatus(
              { invitationId: invitation.invitationId, status: 'no_response' },
              tx,
            );
          }
          return {
            result: { lapsed: overdue.length, rounds: rounds.size },
            audit: [...rounds].map((rfqId) => ({
              action: 'sourcing.rfq_deadline_passed',
              subjectType: 'rfq',
              subjectId: rfqId,
              data: {
                lapsedInvitations: overdue.filter((i) => i.rfqId === rfqId).length,
                sweptAt: now.toISOString(),
              },
            })),
            outbox: [...rounds].map((rfqId) => ({
              eventType: 'sourcing.rfq_deadline_passed.v1',
              aggregateType: 'rfq',
              aggregateId: rfqId,
              data: { sweptAt: now.toISOString() },
            })),
          };
        },
      },
      contextFromActor(actor),
      { sweptAt: now.toISOString() },
      opts,
    );
  }
}
