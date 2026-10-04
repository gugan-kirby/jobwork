import type { ChecklistRow } from '@jobwork/contracts';
import { MANDATORY_KINDS, type VerificationSnapshot } from './verification';

/**
 * What a supplier still owes before JobWork can admit it (`FR-105`), computed from the
 * same facts the reviewer decides on — never stored. A stored checklist would go stale
 * the moment a certificate expired, and the supplier would be told it was ready while
 * the reviewer saw a gap.
 *
 * `blocking` is the whole point: a blocking row refuses submission *and* refuses
 * approval, so the two sides can never disagree about whether the file is complete.
 */

export interface ChecklistFacts {
  profile: {
    tradeName: string;
    primaryContactName: string;
    primaryContactEmail: string;
    primaryContactPhone: string;
    regionClass: string;
    summary: string;
    worksSiteId: string | null;
  };
  publishedCapabilityCount: number;
  machineCount: number;
  verification: readonly VerificationSnapshot[];
  now: Date;
}

const KIND_LABEL: Record<string, string> = {
  gst: 'GST registration',
  pan: 'PAN',
  bank_account: 'Bank account',
  udyam: 'Udyam (MSME) registration',
  address_proof: 'Address proof',
  quality_system: 'Quality system',
  certification: 'Certification',
};

/** `expiring` warns; only the stored date withdraws the evidence (doc 06 §14). */
function liveEvidence(items: readonly VerificationSnapshot[], now: Date): VerificationSnapshot[] {
  return items.filter(
    (item) =>
      (item.status === 'verified' || item.status === 'expiring') &&
      (item.expiresAt === null || item.expiresAt > now),
  );
}

/** Days from now until a date, rounded down; negative once it has passed. */
export function daysUntil(date: Date, now: Date): number {
  return Math.floor((date.getTime() - now.getTime()) / 86_400_000);
}

/**
 * How close an item is to costing the supplier its eligibility. A warning that only
 * arrives on the day of expiry is not a warning — the practice everywhere else is
 * staged notice, and this is the value the portal shows.
 */
export const EXPIRY_WARNING_DAYS = 45;

export function buildOnboardingChecklist(facts: ChecklistFacts): ChecklistRow[] {
  const rows: ChecklistRow[] = [];
  const { profile } = facts;

  const identityMissing = [
    profile.tradeName.trim() === '' ? 'trade name' : null,
    profile.regionClass.trim() === '' ? 'region' : null,
    profile.summary.trim() === '' ? 'what you make' : null,
  ].filter((v): v is string => v !== null);
  rows.push({
    key: 'company_identity',
    label: 'Company details',
    state: identityMissing.length === 0 ? 'complete' : 'incomplete',
    blocking: identityMissing.length > 0,
    detail:
      identityMissing.length === 0
        ? 'Trade name, region and a description of what you make.'
        : `Still needed: ${identityMissing.join(', ')}.`,
  });

  const contactMissing =
    profile.primaryContactName.trim() === '' ||
    profile.primaryContactEmail.trim() === '' ||
    profile.primaryContactPhone.trim() === '';
  rows.push({
    key: 'primary_contact',
    label: 'Primary contact',
    state: contactMissing ? 'incomplete' : 'complete',
    blocking: contactMissing,
    detail: contactMissing
      ? 'A name, email and phone number we can reach during an RFQ.'
      : `${profile.primaryContactName} · ${profile.primaryContactEmail}`,
  });

  rows.push({
    key: 'works_site',
    label: 'Works address',
    state: profile.worksSiteId ? 'complete' : 'incomplete',
    blocking: profile.worksSiteId === null,
    detail: profile.worksSiteId
      ? 'The address parts are made at. Never shown to a customer.'
      : 'Tell us where the work happens. It stays internal — customers never see it.',
  });

  rows.push({
    key: 'capabilities',
    label: 'Capabilities',
    state: facts.publishedCapabilityCount > 0 ? 'complete' : 'incomplete',
    blocking: facts.publishedCapabilityCount === 0,
    detail:
      facts.publishedCapabilityCount > 0
        ? `${facts.publishedCapabilityCount} published; ${facts.machineCount} machine${
            facts.machineCount === 1 ? '' : 's'
          } declared.`
        : 'Publish at least one process or material you can quote for.',
  });

  for (const kind of MANDATORY_KINDS) {
    const forKind = facts.verification.filter((item) => item.kind === kind);
    const live = liveEvidence(forKind, facts.now);
    const latest = forKind[0];
    const label = `${KIND_LABEL[kind] ?? kind} evidence`;

    if (live.length > 0) {
      // Live, but for how much longer? An item counted as simply "done" is how a
      // supplier loses matching without ever being told (F-SN gap 1).
      const soonest = live
        .map((item) => item.expiresAt)
        .filter((date): date is Date => date !== null)
        .sort((a, b) => a.getTime() - b.getTime())[0];
      const remaining = soonest ? daysUntil(soonest, facts.now) : null;
      const expiringSoon = remaining !== null && remaining <= EXPIRY_WARNING_DAYS;

      rows.push({
        key: `verification_${kind}`,
        label,
        state: expiringSoon ? 'incomplete' : 'complete',
        // A warning, not a block: the evidence is still valid, and submission is not
        // refused for something that has not happened yet.
        blocking: false,
        detail: expiringSoon
          ? `Expires ${soonest!.toISOString().slice(0, 10)} — ${
              remaining <= 0 ? 'today' : `${remaining} day${remaining === 1 ? '' : 's'} left`
            }. Send the renewed document before then.`
          : soonest
            ? `Verified by JobWork; valid to ${soonest.toISOString().slice(0, 10)}.`
            : 'Verified by JobWork.',
      });
      continue;
    }
    // A returned or expired item is different from one never sent: the supplier is
    // owed the reason, not a repeat of the original instruction.
    const detail =
      latest?.status === 'submitted' || latest?.status === 'under_review'
        ? 'Submitted — waiting on a JobWork reviewer.'
        : latest?.status === 'returned_for_evidence'
          ? 'Returned for better evidence. Upload a clearer copy and submit again.'
          : latest?.status === 'expired'
            ? 'Expired. Upload the renewed document.'
            : latest?.status === 'revoked'
              ? 'Revoked by JobWork. Contact your sourcing manager.'
              : 'Not submitted yet.';
    rows.push({
      key: `verification_${kind}`,
      label,
      state: latest?.status === 'submitted' || latest?.status === 'under_review'
        ? 'incomplete'
        : 'blocked',
      // Waiting on a reviewer does not block submission — it *is* the submission.
      blocking: !(latest?.status === 'submitted' || latest?.status === 'under_review'),
      detail,
    });
  }

  return rows;
}

export function blockingRows(rows: readonly ChecklistRow[]): ChecklistRow[] {
  return rows.filter((row) => row.blocking);
}
