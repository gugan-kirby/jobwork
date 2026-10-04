import { Injectable } from '@nestjs/common';
import { createLogger, type Logger } from '@jobwork/observability';
import type { OrganizationSite, SaveOrganizationSiteRequest } from '@jobwork/contracts';
import { type Actor, requireRole } from './actor';
import { NotAuthorized } from '../domain/errors';
import { DomainError } from '../../../platform/http/domain-error';
import { IamRepository } from '../infrastructure/iam.repository';
import { AuditWriter } from '../../../platform/commands/audit.writer';
import { contextFromActor } from '../../../platform/commands/command';
import { DatabaseService } from '../../../platform/database/database.service';

export class SiteNotFound extends DomainError {
  constructor() {
    super('SITE_NOT_FOUND', 404, 'Address not found', 'No address with that id in your organization.');
  }
}

/**
 * An organization's own address book (F-CX.3). Every read and write is scoped to the
 * caller's organization by construction — there is no path parameter naming an
 * organization, so one customer can never reach another's addresses however the request
 * is shaped.
 *
 * Archiving rather than deleting is the whole design: an enquiry that named an address
 * must still be able to say where it was going, years later.
 */
@Injectable()
export class SiteService {
  private readonly log: Logger = createLogger({ service: 'api' }).child({ module: 'iam.sites' });

  constructor(
    private readonly repo: IamRepository,
    private readonly audit: AuditWriter,
    private readonly db: DatabaseService,
  ) {}

  private requireOrganization(actor: Actor): string {
    if (!actor.organizationId) throw new NotAuthorized('No organization selected');
    return actor.organizationId;
  }

  async list(actor: Actor, includeArchived = false): Promise<OrganizationSite[]> {
    const organizationId = this.requireOrganization(actor);
    return this.repo.listSites(organizationId, includeArchived);
  }

  /** Anyone who may raise an enquiry may keep the addresses it ships to. */
  private assertMayMaintain(actor: Actor): void {
    requireRole(actor, 'org_admin', 'customer_requester', 'customer_approver', 'platform_admin');
  }

  async save(actor: Actor, input: SaveOrganizationSiteRequest): Promise<OrganizationSite> {
    const organizationId = this.requireOrganization(actor);
    this.assertMayMaintain(actor);

    if (input.siteId) {
      const existing = await this.repo.findSite(input.siteId, organizationId);
      if (!existing) throw new SiteNotFound();
    }

    const site = await this.db.withTransaction(async (client) => {
      const saved = await this.repo.saveSite(
        { ...input, organizationId, siteId: input.siteId ?? null, gstin: input.gstin ?? null, createdBy: actor.userId },
        client,
      );
      await this.audit.write(client, contextFromActor(actor), {
        action: input.siteId ? 'iam.site_updated' : 'iam.site_added',
        subjectType: 'organization_site',
        subjectId: saved.siteId,
        // The address itself is not audit payload: the trail is read by more people than
        // the address book is.
        data: { organizationId, label: saved.label, kind: saved.kind, city: saved.city },
      });
      return saved;
    });
    this.log.info({ siteId: site.siteId, organizationId }, 'iam.site_saved');
    return site;
  }

  async archive(actor: Actor, siteId: string): Promise<void> {
    const organizationId = this.requireOrganization(actor);
    this.assertMayMaintain(actor);
    await this.db.withTransaction(async (client) => {
      const archived = await this.repo.archiveSite(siteId, organizationId, client);
      if (!archived) throw new SiteNotFound();
      await this.audit.write(client, contextFromActor(actor), {
        action: 'iam.site_archived',
        subjectType: 'organization_site',
        subjectId: siteId,
        data: { organizationId },
      });
    });
  }
}
