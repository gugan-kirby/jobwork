import { Injectable } from '@nestjs/common';
import type { GrantSummary } from '@jobwork/contracts';
import { type Actor, requireOrganization, requireTransactionalStrength } from '../../iam';
import { assertMayRelease } from '../domain/audience-policy';
import { DocumentNotFound } from '../domain/errors';
import { DmsRepository } from '../infrastructure/dms.repository';
import { grantSummaryOf } from './grant-audience.command';
import { contextFromActor } from '../../../platform/commands/command';
import { CommandExecutor } from '../../../platform/commands/execute';

/**
 * revoke-grant. Revocation closes future access and nothing else: the downloads that
 * already happened stay in the access log as facts (the table is append-only by
 * trigger), and the file itself is untouched. What a holder took away before
 * revocation cannot be recalled — the audit trail says who took it and when, which is
 * the honest answer to "we withdrew that file" (doc 19 §3).
 *
 * Signed URLs already handed out stay valid for their remaining seconds (doc 20 §8
 * propagation target 5), which is why download TTLs are minutes, not hours.
 */
@Injectable()
export class RevokeGrantCommand {
  constructor(
    private readonly repo: DmsRepository,
    private readonly executor: CommandExecutor,
  ) {}

  async execute(
    actor: Actor,
    documentVersionId: string,
    grantId: string,
    input: { reason?: string | undefined } = {},
    opts: { idempotencyKey?: string | undefined } = {},
  ): Promise<GrantSummary> {
    requireTransactionalStrength(actor);
    const actorOrganizationId = requireOrganization(actor);

    const version = await this.repo.findVersionForRelease(documentVersionId);
    if (!version) throw new DocumentNotFound();
    assertMayRelease(actor, version.owningOrganizationId);

    const grant = await this.repo.findGrant(grantId);
    if (!grant || grant.documentVersionId !== documentVersionId) throw new DocumentNotFound();
    if (grant.revokedAt) return grantSummaryOf(grant);

    return this.executor.execute(
      {
        operation: 'dms.revoke-grant',
        handler: async (tx, _ctx, cmd: { reason?: string | undefined }) => {
          const revoked = await this.repo.revokeGrant(grantId, actor.userId, tx);
          const current = await this.repo.findGrant(grantId, tx);
          if (!current) throw new DocumentNotFound();

          const downloads = await this.repo.countAccess(documentVersionId, grant.organizationId, tx);
          return {
            result: grantSummaryOf(current),
            audit: revoked
              ? [
                  {
                    action: 'dms.audience_revoked',
                    subjectType: 'document_version',
                    subjectId: documentVersionId,
                    ...(cmd.reason ? { reason: cmd.reason } : {}),
                    data: {
                      grantId,
                      audienceType: grant.audienceType,
                      organizationId: grant.organizationId,
                      // Recorded at revocation time: access already taken is history,
                      // not something revocation can undo.
                      downloadsBeforeRevocation: downloads,
                    },
                  },
                ]
              : [],
            outbox: revoked
              ? [
                  {
                    eventType: 'dms.audience_revoked',
                    aggregateType: 'document_version',
                    aggregateId: documentVersionId,
                    data: {
                      grantId,
                      audienceType: grant.audienceType,
                      organizationId: grant.organizationId,
                    },
                  },
                ]
              : [],
          };
        },
      },
      contextFromActor({ userId: actor.userId, organizationId: actorOrganizationId }),
      input,
      opts,
    );
  }
}
