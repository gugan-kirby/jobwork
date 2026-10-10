import { Injectable } from '@nestjs/common';
import type { GrantAudienceRequest, GrantSummary } from '@jobwork/contracts';
import { type Actor, requireOrganization, requireTransactionalStrength } from '../../iam';
import { NotAuthorized } from '../../iam/domain/errors';
import { assertAudienceAllowed, assertMayRelease } from '../domain/audience-policy';
import { ContentNotReleasable, DocumentNotFound } from '../domain/errors';
import { DmsRepository, type GrantRow } from '../infrastructure/dms.repository';
import { IamRepository } from '../../iam';
import { contextFromActor } from '../../../platform/commands/command';
import { CommandExecutor } from '../../../platform/commands/execute';
import { DomainError } from '../../../platform/http/domain-error';

/**
 * grant-audience (`BR-ENG-02`, `BR-ENG-08`). Release is explicit, per immutable
 * version, and only ever for content a scan has cleared — a document version that is
 * processing, quarantined or revoked cannot be released at all, which is what keeps
 * "scan first" from being merely conventional.
 *
 * A grant confers access; it does not move bytes and does not notify anyone. The
 * transmittal that announces a release is a separate, later act (doc 09 §5).
 */
@Injectable()
export class GrantAudienceCommand {
  constructor(
    private readonly repo: DmsRepository,
    private readonly iam: IamRepository,
    private readonly executor: CommandExecutor,
  ) {}

  async execute(
    actor: Actor,
    documentVersionId: string,
    input: GrantAudienceRequest,
    opts: { idempotencyKey?: string | undefined } = {},
  ): Promise<GrantSummary> {
    requireTransactionalStrength(actor);
    const actorOrganizationId = requireOrganization(actor);

    const version = await this.repo.findVersionForRelease(documentVersionId);
    // No enumeration: a version the actor has no standing over is simply not there.
    if (!version) throw new DocumentNotFound();
    assertMayRelease(actor, version.owningOrganizationId);
    assertAudienceAllowed(actor, input.audienceType);

    if (version.versionStatus !== 'available' || version.scanState !== 'clean') {
      throw new ContentNotReleasable(version.versionStatus, version.scanState);
    }

    const targetOrganizationId = input.organizationId ?? null;
    if (targetOrganizationId) {
      const target = await this.iam.findOrganization(targetOrganizationId);
      if (!target || target.status !== 'active') {
        throw new NotAuthorized('Target organization unavailable');
      }
      if (target.id === version.owningOrganizationId) {
        throw new NotAuthorized('The owning organization already has access');
      }
      // `FR-305` (F-FP.5): a supplier receives JobWork's confirmed copy of a customer file, never the file.
      if (target.type === 'supplier' && (await this.repo.ownerTypes([documentVersionId])).get(documentVersionId) === 'customer') {
        throw new DomainError('SUPPLIER_COPY_REQUIRED', 422, 'A customer file needs its supplier copy first', 'Send the supplier JobWork’s confirmed copy of this file instead.');
      }
    }

    // Re-releasing to an audience that already holds a live grant returns that grant
    // rather than stacking duplicates that would then need revoking one by one.
    const existing = await this.repo.findLiveGrant({
      versionId: documentVersionId,
      audienceType: input.audienceType,
      organizationId: targetOrganizationId,
    });
    if (existing) return toSummary(existing);

    const grant = await this.executor.execute(
      {
        operation: 'dms.grant-audience',
        handler: async (tx, _ctx, cmd: GrantAudienceRequest) => {
          const created = await this.repo.createGrant(
            {
              versionId: documentVersionId,
              audienceType: cmd.audienceType,
              organizationId: targetOrganizationId,
              actions: cmd.actions,
              grantedBy: actor.userId,
              validUntil: cmd.validUntil ? new Date(cmd.validUntil) : null,
            },
            tx,
          );
          return {
            result: toSummary(created),
            audit: [
              {
                action: 'dms.audience_granted',
                subjectType: 'document_version',
                subjectId: documentVersionId,
                ...(cmd.reason ? { reason: cmd.reason } : {}),
                data: {
                  grantId: created.id,
                  audienceType: cmd.audienceType,
                  organizationId: targetOrganizationId,
                  actions: cmd.actions,
                  validUntil: cmd.validUntil ?? null,
                },
              },
            ],
            outbox: [
              {
                eventType: 'dms.audience_granted',
                aggregateType: 'document_version',
                aggregateId: documentVersionId,
                data: {
                  grantId: created.id,
                  audienceType: cmd.audienceType,
                  organizationId: targetOrganizationId,
                  documentId: version.documentId,
                },
              },
            ],
          };
        },
      },
      contextFromActor({ userId: actor.userId, organizationId: actorOrganizationId }),
      input,
      opts,
    );
    return grant;
  }
}

function toSummary(grant: GrantRow): GrantSummary {
  return {
    grantId: grant.id,
    documentVersionId: grant.documentVersionId,
    audienceType: grant.audienceType,
    organizationId: grant.organizationId,
    actions: grant.actions as GrantSummary['actions'],
    validUntil: grant.validUntil ? grant.validUntil.toISOString() : null,
    revokedAt: grant.revokedAt ? grant.revokedAt.toISOString() : null,
    createdAt: grant.createdAt.toISOString(),
  };
}

export { toSummary as grantSummaryOf };
