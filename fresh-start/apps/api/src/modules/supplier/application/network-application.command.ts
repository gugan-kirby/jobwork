import { Injectable } from '@nestjs/common';
import type {
  DeclineApplicationRequest,
  SupplierApplication,
  SupplierApplicationRequest,
} from '@jobwork/contracts';
import { createLogger, getCorrelationId, type Logger } from '@jobwork/observability';
import { type Actor, requireRole, requireTransactionalStrength } from '../../iam';
import { NotAuthorized } from '../../iam/domain/errors';
import { ApplicationAlreadyDecided, ApplicationNotFound, CapabilityUnknown } from '../domain/errors';
import {
  NetworkApplicationRepository,
  SupplierRepository,
  type NetworkApplicationRow,
} from '../infrastructure/supplier.repository';
import { AuditWriter } from '../../../platform/commands/audit.writer';
import { contextFromActor } from '../../../platform/commands/command';
import { CommandExecutor } from '../../../platform/commands/execute';
import { OutboxWriter } from '../../../platform/commands/outbox.writer';
import { DatabaseService } from '../../../platform/database/database.service';

export function projectApplication(row: NetworkApplicationRow): SupplierApplication {
  return {
    applicationId: row.id,
    companyName: row.companyName,
    contactName: row.contactName,
    email: row.email,
    phone: row.phone,
    city: row.city,
    processCodes: row.processCodes,
    note: row.note,
    status: row.status,
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    decisionReason: row.decisionReason,
    admittedOrganizationId: row.admittedOrganizationId,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Network applications (F-MX.4, prototype tile 3 "Vendor" tab).
 *
 * `apply` is anonymous and creates a request, never an account: the prototype's
 * register-as-vendor becomes "ask to join", and admission stays the explicit JobWork
 * decision F-SO built. `decline` is the one decision taken here; admission runs through
 * `admitSupplier` with the application id, so the organization and the closed
 * application are written together.
 */
@Injectable()
export class NetworkApplicationCommand {
  private readonly log: Logger = createLogger({ service: 'api' }).child({ module: 'supplier.application' });

  constructor(
    private readonly applications: NetworkApplicationRepository,
    private readonly suppliers: SupplierRepository,
    private readonly db: DatabaseService,
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxWriter,
    private readonly executor: CommandExecutor,
  ) {}

  async apply(input: SupplierApplicationRequest): Promise<{ applicationId: string }> {
    // Claimed processes are checked against the taxonomy, not trusted: a code the
    // platform does not know cannot be matched later, so it is refused now.
    if (input.processCodes.length > 0) {
      const known = new Set(
        (await this.suppliers.listTaxonomy())
          .filter((row) => row.kind === 'process' && !row.isFamily)
          .map((row) => row.code),
      );
      for (const code of input.processCodes) {
        if (!known.has(code)) throw new CapabilityUnknown(code);
      }
    }

    const row = await this.db.withTransaction(async (tx) => {
      const created = await this.applications.create(
        {
          companyName: input.companyName,
          contactName: input.contactName,
          email: input.email,
          phone: input.phone,
          city: input.city,
          processCodes: input.processCodes,
          note: input.note,
        },
        tx,
      );
      // Nobody is signed in; the record is its own actor until JobWork picks it up.
      const ctx = {
        actor: { type: 'system' as const, id: null, organizationId: null },
        correlationId: getCorrelationId() ?? 'uncorrelated',
      };
      await this.audit.write(tx, ctx, {
        action: 'supplier.application_received',
        subjectType: 'network_application',
        subjectId: created.id,
        data: { processCount: input.processCodes.length, city: input.city },
      });
      await this.outbox.write(tx, ctx, {
        eventType: 'supplier.application_received.v1',
        aggregateType: 'network_application',
        aggregateId: created.id,
        data: { applicationId: created.id, email: input.email, companyName: input.companyName },
      });
      return created;
    });
    this.log.info({ applicationId: row.id }, 'supplier.application_received');
    return { applicationId: row.id };
  }

  private requireReviewer(actor: Actor): void {
    if (!actor.isInternal) throw new NotAuthorized('Only JobWork reviews applications');
    requireRole(actor, 'jobwork_sourcing', 'platform_admin');
  }

  async list(actor: Actor, status: string | undefined, limit: number): Promise<SupplierApplication[]> {
    this.requireReviewer(actor);
    return (await this.applications.list(status, limit)).map(projectApplication);
  }

  async get(actor: Actor, applicationId: string): Promise<SupplierApplication> {
    this.requireReviewer(actor);
    const row = await this.applications.find(applicationId);
    if (!row) throw new ApplicationNotFound();
    return projectApplication(row);
  }

  async decline(
    actor: Actor,
    applicationId: string,
    input: DeclineApplicationRequest,
    opts: { idempotencyKey?: string | undefined } = {},
  ): Promise<SupplierApplication> {
    this.requireReviewer(actor);
    requireTransactionalStrength(actor);

    return this.executor.execute(
      {
        operation: 'supplier.decline-application',
        handler: async (tx, _ctx, cmd: DeclineApplicationRequest) => {
          const application = await this.applications.find(applicationId, tx);
          if (!application) throw new ApplicationNotFound();
          const closed = await this.applications.decide(
            {
              id: applicationId,
              status: 'declined',
              decidedBy: actor.userId,
              reason: cmd.reason,
              admittedOrganizationId: null,
            },
            tx,
          );
          if (!closed) throw new ApplicationAlreadyDecided(application.status);
          const after = (await this.applications.find(applicationId, tx))!;
          return {
            result: projectApplication(after),
            audit: [
              {
                action: 'supplier.application_declined',
                subjectType: 'network_application',
                subjectId: applicationId,
                reason: cmd.reason,
              },
            ],
            outbox: [
              {
                eventType: 'supplier.application_declined.v1',
                aggregateType: 'network_application',
                aggregateId: applicationId,
                data: { applicationId, email: application.email },
              },
            ],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
  }
}
