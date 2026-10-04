import { Injectable } from '@nestjs/common';
import type {
  SupplierProfile,
  SupplierQueue,
  SupplierSelfView,
  SupplierSummary,
} from '@jobwork/contracts';
import {
  buildOnboardingChecklist,
  blockingRows,
  daysUntil,
  EXPIRY_WARNING_DAYS,
} from '../domain/onboarding-checklist';
import { computeExclusions } from '../domain/verification';
import { SupplierRepository, type SupplierProfileRow } from '../infrastructure/supplier.repository';
import { toVerificationItem } from './verification-view';

/**
 * One assembly of "everything true about this supplier right now", used by the supplier
 * looking at itself and by the reviewer looking at it. Two assemblies would eventually
 * disagree, and the disagreement would always surface as a supplier being told it is
 * ready for a decision that the reviewer cannot make.
 */
@Injectable()
export class SupplierView {
  constructor(private readonly repo: SupplierRepository) {}

  async profile(row: SupplierProfileRow): Promise<SupplierProfile> {
    const worksSite = row.worksSiteId ? await this.repo.findWorksSite(row.worksSiteId) : null;
    return {
      supplierProfileId: row.id,
      organizationId: row.organizationId,
      legalName: row.legalName,
      displayName: row.displayName,
      tradeName: row.tradeName,
      website: row.website,
      summary: row.summary,
      regionClass: row.regionClass,
      yearEstablished: row.yearEstablished,
      employeeBand: row.employeeBand as SupplierProfile['employeeBand'],
      primaryContactName: row.primaryContactName,
      primaryContactEmail: row.primaryContactEmail,
      primaryContactPhone: row.primaryContactPhone,
      status: row.status,
      acceptingWork: row.acceptingWork,
      acceptingWorkNote: row.acceptingWorkNote,
      acceptingWorkUntil: row.acceptingWorkUntil,
      aggregateVersion: row.aggregateVersion,
      submittedAt: row.submittedAt ? row.submittedAt.toISOString() : null,
      decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
      decisionReason: row.decisionReason,
      worksSite,
    };
  }

  async selfView(row: SupplierProfileRow, now = new Date()): Promise<SupplierSelfView> {
    const [capabilities, machines, verification, certifications, snapshot] = await Promise.all([
      this.repo.listSupplierCapabilities(row.id, false),
      this.repo.listMachines(row.id, false),
      this.repo.listVerificationItems(row.id),
      this.repo.listCertifications(row.id),
      this.repo.verificationSnapshot(row.id),
    ]);

    const checklist = buildOnboardingChecklist({
      profile: {
        tradeName: row.tradeName,
        primaryContactName: row.primaryContactName,
        primaryContactEmail: row.primaryContactEmail,
        primaryContactPhone: row.primaryContactPhone,
        regionClass: row.regionClass,
        summary: row.summary,
        worksSiteId: row.worksSiteId,
      },
      publishedCapabilityCount: capabilities.length,
      machineCount: machines.length,
      verification: snapshot,
      now,
    });

    const exclusions = computeExclusions({
      profileStatus: row.status,
      organizationStatus: row.organizationStatus,
      publishedCapabilityCount: capabilities.length,
      items: snapshot,
      acceptingWork: row.acceptingWork,
      now,
    });

    return {
      profile: await this.profile(row),
      checklist,
      verification: verification.map(toVerificationItem),
      certifications: certifications.map((cert) => ({
        certificationId: cert.id,
        certificationType: cert.certificationType,
        certificateNumber: cert.certificateNumber,
        issuer: cert.issuer,
        issuedOn: cert.issuedOn,
        expiresOn: cert.expiresOn,
        status: cert.status,
        evidenceDocumentVersionId: cert.evidenceDocumentVersionId,
      })),
      capabilityCount: capabilities.length,
      machineCount: machines.length,
      eligible: exclusions.length === 0,
      exclusions,
      // Submission is offered only when it would be accepted, and only from a state
      // that can be submitted from — an already-submitted file is not resubmitted.
      canSubmit:
        blockingRows(checklist).length === 0 &&
        (row.status === 'onboarding' || row.status === 'rejected'),
    };
  }

  /**
   * What an admitted supplier has to watch (F-SN.2): dates that will cost it matching,
   * and anything a reviewer sent back. Empty queues are still returned — a supplier
   * needs to see that the dates were checked, not wonder whether the page failed.
   */
  async summary(row: SupplierProfileRow, now = new Date()): Promise<SupplierSummary> {
    const [verification, certifications, view] = await Promise.all([
      this.repo.listVerificationItems(row.id),
      this.repo.listCertifications(row.id),
      this.selfView(row, now),
    ]);

    // Newest version per kind: an older version's date is history, not a warning.
    const latest = new Map<string, (typeof verification)[number]>();
    for (const item of verification) if (!latest.has(item.kind)) latest.set(item.kind, item);
    const current = [...latest.values()];

    const expiring = current.filter(
      (item) =>
        (item.status === 'verified' || item.status === 'expiring') &&
        item.expiresAt !== null &&
        daysUntil(item.expiresAt, now) <= EXPIRY_WARNING_DAYS &&
        item.expiresAt > now,
    );
    const expired = current.filter(
      (item) =>
        item.status === 'expired' || (item.expiresAt !== null && item.expiresAt <= now),
    );
    const returned = current.filter((item) => item.status === 'returned_for_evidence');
    const certificationsExpiring = certifications.filter(
      (cert) =>
        cert.expiresOn !== null &&
        daysUntil(new Date(`${cert.expiresOn}T00:00:00Z`), now) <= EXPIRY_WARNING_DAYS,
    );

    const nearest = (dates: Array<Date | null>): string | null => {
      const sorted = dates
        .filter((date): date is Date => date !== null)
        .sort((a, b) => a.getTime() - b.getTime());
      return sorted[0] ? sorted[0].toISOString() : null;
    };

    const queues: SupplierQueue[] = [
      {
        key: 'evidence_expired',
        label: 'Evidence that has lapsed',
        detail: 'You are out of matching until these are renewed.',
        count: expired.length,
        nearestDate: nearest(expired.map((item) => item.expiresAt)),
        href: '/supplier/compliance',
      },
      {
        key: 'evidence_expiring',
        label: 'Evidence expiring soon',
        detail: `Renew before the date and you never leave matching.`,
        count: expiring.length,
        nearestDate: nearest(expiring.map((item) => item.expiresAt)),
        href: '/supplier/compliance',
      },
      {
        key: 'evidence_returned',
        label: 'Sent back to you',
        detail: 'A reviewer asked for better evidence and said why.',
        count: returned.length,
        nearestDate: null,
        href: '/supplier/compliance',
      },
      {
        key: 'certifications_expiring',
        label: 'Certifications expiring',
        detail: 'A lapsed certificate drops you from work that requires it.',
        count: certificationsExpiring.length,
        nearestDate: nearest(
          certificationsExpiring.map((cert) =>
            cert.expiresOn ? new Date(`${cert.expiresOn}T00:00:00Z`) : null,
          ),
        ),
        href: '/supplier/compliance',
      },
    ];

    return {
      queues,
      matchable: view.eligible,
      exclusions: view.exclusions,
      acceptingWork: row.acceptingWork,
      generatedAt: now.toISOString(),
    };
  }
}
