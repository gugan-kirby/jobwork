import { Injectable } from '@nestjs/common';
import type { MatchCandidate, MatchResult } from '@jobwork/contracts';
import { type Actor } from '../../iam';
import { NotAuthorized } from '../../iam/domain/errors';
import { EligibilityProjection } from '../../supplier';
import { EnquiryRepository } from '../infrastructure/enquiry.repository';
import { EnquiryNotFound } from '../domain/enquiry';

/**
 * Matching v1 (doc 07 §2.1, `FR-204`, `FR-205`): the **hard filter only**. Scoring and
 * ranking arrive later; what matters now is that a shortlist is explainable.
 *
 * Two properties this query exists to guarantee:
 *
 *  1. **Every miss carries a reason.** A supplier that is not on the shortlist is listed
 *     with the codes that excluded it — expired evidence, missing capability, paused.
 *     "No suppliers found" with no explanation is how sourcing loses trust in a matcher.
 *  2. **Preference never overrides eligibility silently** (`FR-205`). This query does not
 *     rank or promote anybody; an ineligible supplier can only reach an RFQ through an
 *     explicit override that records its reason on the invitation row.
 */
@Injectable()
export class MatchSuppliersQuery {
  /** Bumped whenever the filter's meaning changes, and recorded on every snapshot. */
  static readonly CONFIG_VERSION = 'hard-filter-v1';

  constructor(
    private readonly eligibility: EligibilityProjection,
    private readonly enquiries: EnquiryRepository,
  ) {}

  async execute(actor: Actor, enquiryId: string): Promise<MatchResult> {
    if (!actor.isInternal) throw new NotAuthorized('Matching is internal');

    const enquiry = await this.enquiries.find(enquiryId);
    if (!enquiry) throw new EnquiryNotFound();

    // What the requirement actually needs: the process and material codes its lines
    // name. Everything else (tolerance, envelope) is soft ranking, which v1 does not do.
    const required = new Set<string>();
    for (const item of enquiry.items) {
      if (item.processCapabilityId) required.add(item.processCapabilityId);
      if (item.materialCapabilityId) required.add(item.materialCapabilityId);
    }
    const requiredCapabilityCodes = await this.enquiries.capabilityCodesFor([...required]);

    // The projection is asked for *everybody*, not only those who pass: a matcher that
    // cannot show you who was excluded and why is not auditable (`FR-204`).
    const records = await this.eligibility.query({ limit: 200 });

    const candidates: MatchCandidate[] = await Promise.all(
      records.map(async (record) => {
        const missing = requiredCapabilityCodes.filter(
          (code) => !record.capabilityCodes.includes(code),
        );
        // The match's own reason code, kept beside the eligibility ones: this supplier
        // is eligible in general and simply does not publish what this job needs.
        const exclusions: string[] = [...record.exclusions];
        if (missing.length > 0) exclusions.push('capability_not_published');
        return {
          supplierProfileId: record.supplierProfileId,
          organizationId: record.organizationId,
          displayName: await this.enquiries.organizationName(record.organizationId),
          regionClass: record.regionClass,
          eligible: exclusions.length === 0,
          exclusions,
          capabilityCodes: record.capabilityCodes,
          missingCapabilityCodes: missing,
        };
      }),
    );

    // Deterministic order: eligible first, then by name, so two runs of the same facts
    // read the same to the person deciding.
    candidates.sort((a, b) =>
      a.eligible === b.eligible
        ? a.displayName.localeCompare(b.displayName)
        : Number(b.eligible) - Number(a.eligible),
    );

    return {
      enquiryId,
      configVersion: MatchSuppliersQuery.CONFIG_VERSION,
      requiredCapabilityCodes,
      candidates,
      eligibleCount: candidates.filter((candidate) => candidate.eligible).length,
      evaluatedAt: new Date().toISOString(),
    };
  }
}
