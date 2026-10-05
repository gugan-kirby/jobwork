import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { scanText } from '../domain/leakage';
import { ContextResolver } from '../infrastructure/context.resolver';

/**
 * The leakage registry turned on a customer-facing artifact (IN-17; `R-08`; doc 11 "identity
 * leakage"). Every string a customer will read — a label, a delivery note, a tracking line — is
 * scanned for any other party's name, domain, email or phone. Contact patterns on their own (the
 * customer's own receiving phone) are not findings here: only a match against a shielded party is.
 */
@Injectable()
export class IdentityScreen {
  constructor(private readonly contexts: ContextResolver) {}

  async screenForCustomer(customerOrganizationId: string, texts: ReadonlyArray<{ field: string; text: string }>, tx?: PoolClient): Promise<Array<{ field: string; text: string; label: string }>> {
    const registry = await this.contexts.registryExcluding([customerOrganizationId], tx);
    const findings: Array<{ field: string; text: string; label: string }> = [];
    for (const { field, text } of texts) {
      if (!text.trim()) continue;
      for (const f of scanText(text, registry)) if (f.kind === 'party_identity') findings.push({ field, text: f.text, label: f.label });
    }
    return findings;
  }
}
