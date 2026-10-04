import { Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import type { ExternalAudience, LeakageAction, LeakageFinding, MessageParty } from '@jobwork/contracts';
import { decideAction } from '../domain/leakage-policy';
import { scanText } from '../domain/leakage';
import { ContextResolver, type ResolvedContext } from '../infrastructure/context.resolver';

/**
 * The gate every externally visible text passes before anyone outside JobWork can read
 * it (`FR-1002`): the composer's pre-check, a post, a share to all suppliers, and a
 * reviewer's redacted rewrite all go through the same scan and the same policy.
 */
@Injectable()
export class LeakageGate {
  constructor(private readonly contexts: ContextResolver) {}

  async check(
    input: {
      context: ResolvedContext;
      audience: ExternalAudience;
      counterpartOrganizationId: string | null;
      authorParty: MessageParty;
      body: string;
    },
    client?: Pool | PoolClient,
  ): Promise<{ action: LeakageAction; findings: LeakageFinding[] }> {
    const registry = await this.contexts.registryFor(input.context, input.audience, input.counterpartOrganizationId, client);
    const findings = scanText(input.body, registry);
    return { action: decideAction({ audience: input.audience, authorParty: input.authorParty, findings }), findings };
  }
}
