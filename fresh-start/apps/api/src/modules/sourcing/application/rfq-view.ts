import { Injectable } from '@nestjs/common';
import type {
  BidVersion,
  Rfq,
  SupplierBid,
  SupplierRfq,
  SupplierRfqListItem,
} from '@jobwork/contracts';
import { RfqRepository, type BidVersionRow, type RfqRow } from '../infrastructure/rfq.repository';
import { neutralFilename } from '../../dms';

/**
 * The two RFQ payloads, built separately on purpose.
 *
 * `internalView` carries everything: supplier names, eligibility, bid totals. The
 * supplier view is assembled from scratch rather than by deleting fields from the
 * internal one, because a field nobody remembered to delete is exactly how doc 03 §7
 * gets violated. If a customer's name is to reach a supplier, someone has to write the
 * line that puts it there — and no such line exists.
 */
@Injectable()
export class RfqView {
  constructor(private readonly repo: RfqRepository) {}

  async internalView(rfq: RfqRow): Promise<Rfq> {
    const [items, release, invitations] = await Promise.all([
      this.repo.listItems(rfq.id),
      this.repo.listReleaseItems(rfq.id),
      this.repo.listInvitations(rfq.id),
    ]);

    const withCounts = await Promise.all(
      invitations.map(async (invitation) => {
        const bid = await this.repo.findBid(rfq.id, invitation.supplierOrganizationId);
        return {
          rfqSupplierId: invitation.id,
          supplierProfileId: invitation.supplierProfileId,
          organizationId: invitation.supplierOrganizationId,
          displayName: invitation.displayName,
          status: invitation.status,
          eligibleAtRelease: invitation.eligibilitySnapshot.eligible,
          exclusionsAtRelease: invitation.eligibilitySnapshot.exclusions ?? [],
          overrideReason: invitation.overrideReason,
          invitedAt: invitation.invitedAt?.toISOString() ?? null,
          acknowledgedAt: invitation.acknowledgedAt?.toISOString() ?? null,
          respondedAt: invitation.respondedAt?.toISOString() ?? null,
          declineCode: invitation.declineCode as Rfq['invitations'][number]['declineCode'],
          declineReason: invitation.declineReason,
          bidVersionCount: bid ? await this.repo.countBidVersions(bid.id) : 0,
        };
      }),
    );

    return {
      rfqId: rfq.id,
      enquiryId: rfq.enquiryId,
      requirementId: rfq.requirementId,
      reference: rfq.reference,
      roundNo: rfq.roundNo,
      status: rfq.status,
      currency: rfq.currency,
      deadlineAt: rfq.deadlineAt?.toISOString() ?? null,
      lateBidPolicy: rfq.lateBidPolicy,
      instructions: rfq.instructions,
      pricingMode: rfq.pricingMode,
      offerPaymentTerms: rfq.offerPaymentTerms,
      aggregateVersion: rfq.aggregateVersion,
      releasedAt: rfq.releasedAt?.toISOString() ?? null,
      closedAt: rfq.closedAt?.toISOString() ?? null,
      outcomeReason: rfq.outcomeReason,
      items: items.map((item) => ({
        rfqItemId: item.id,
        lineNo: item.lineNo,
        partName: item.partName,
        description: item.description,
        quantityBreakpoints: item.quantityBreakpoints,
        specification: item.specification,
        offeredUnitPriceMinor: item.offeredUnitPriceMinor,
      })),
      release: release.map((item) => ({
        documentVersionId: item.documentVersionId,
        role: item.role as Rfq['release'][number]['role'],
        sha256: item.sha256,
      })),
      invitations: withCounts,
    };
  }

  /**
   * What one supplier may see (`BR-COM-06`). Note what is absent and cannot be added by
   * accident: the customer organization, the enquiry reference, the delivery address,
   * any other supplier, and any sell-side number.
   */
  async supplierView(rfq: RfqRow, supplierOrganizationId: string): Promise<SupplierRfq | null> {
    const invitation = await this.repo.findInvitationForOrganization(
      rfq.id,
      supplierOrganizationId,
    );
    if (!invitation) return null;

    const [items, documents, bid] = await Promise.all([
      this.repo.listItems(rfq.id),
      this.repo.listReleaseItems(rfq.id),
      this.repo.findBid(rfq.id, supplierOrganizationId),
    ]);

    return {
      rfqId: rfq.id,
      reference: rfq.reference,
      roundNo: rfq.roundNo,
      status: rfq.status,
      currency: rfq.currency,
      deadlineAt: rfq.deadlineAt?.toISOString() ?? null,
      lateBidPolicy: rfq.lateBidPolicy,
      instructions: rfq.instructions,
      pricingMode: rfq.pricingMode,
      offerPaymentTerms: rfq.offerPaymentTerms,
      invitationStatus: invitation.status,
      invitedAt: invitation.invitedAt?.toISOString() ?? null,
      acknowledgedAt: invitation.acknowledgedAt?.toISOString() ?? null,
      items: items.map((item) => ({
        rfqItemId: item.id,
        lineNo: item.lineNo,
        partName: item.partName,
        description: item.description,
        quantityBreakpoints: item.quantityBreakpoints,
        specification: item.specification,
        offeredUnitPriceMinor: item.offeredUnitPriceMinor,
      })),
      documents: documents.map((document) => ({
        documentVersionId: document.documentVersionId,
        role: document.role as SupplierRfq['documents'][number]['role'],
        sha256: document.sha256,
        // F-FP.4: the customer's own filename never reaches a supplier.
        filename: neutralFilename(document.documentVersionId, document.filename),
      })),
      bid: bid ? await this.bidView(bid.id, bid) : null,
    };
  }

  async supplierList(supplierOrganizationId: string): Promise<SupplierRfqListItem[]> {
    const rows = await this.repo.listRfqsForSupplier(supplierOrganizationId);
    return Promise.all(
      rows.map(async ({ rfq, invitation, bidVersionCount }) => ({
        rfqId: rfq.id,
        reference: rfq.reference,
        status: rfq.status,
        invitationStatus: invitation.status,
        deadlineAt: rfq.deadlineAt?.toISOString() ?? null,
        itemCount: (await this.repo.listItems(rfq.id)).length,
        bidVersionCount,
      })),
    );
  }

  private async bidView(
    bidId: string,
    bid: { rfqId: string; draft: SupplierBid['draft']; currentVersionNo: number },
  ): Promise<SupplierBid> {
    const versions = await this.repo.listBidVersions(bidId);
    return {
      supplierBidId: bidId,
      rfqId: bid.rfqId,
      currentVersionNo: bid.currentVersionNo,
      draft: bid.draft,
      versions: versions.map(toBidVersion),
    };
  }

  /** Bids on a round, for JobWork's evaluation view only. */
  async bidsForEvaluation(rfqId: string): Promise<
    Array<{
      rfqSupplierId: string;
      displayName: string;
      invitationStatus: string;
      version: BidVersion | null;
      history: BidVersion[];
    }>
  > {
    const rows = await this.repo.listLiveBidsForRfq(rfqId);
    return Promise.all(
      rows.map(async (row) => {
        const history = (await this.repo.listBidVersions(row.bid.id)).map(toBidVersion);
        // After an award there is no *live* (submitted) version left — they are selected
        // or rejected — but the control room still has to show what was decided. The
        // newest version stands in; its status says which it is.
        const version = row.version ? toBidVersion(row.version) : (history[0] ?? null);
        return {
          rfqSupplierId: row.invitation.id,
          displayName: row.invitation.displayName,
          invitationStatus: row.invitation.status,
          version,
          history,
        };
      }),
    );
  }
}

export function toBidVersion(row: BidVersionRow): BidVersion {
  return {
    bidVersionId: row.id,
    versionNo: row.versionNo,
    status: row.status,
    currency: row.currency,
    taxTreatment: row.taxTreatment as BidVersion['taxTreatment'],
    linesTotalMinor: row.linesTotalMinor,
    nreAmountMinor: row.nreAmountMinor,
    freightAmountMinor: row.freightAmountMinor,
    totalAmountMinor: row.totalAmountMinor,
    leadTimeDays: row.leadTimeDays,
    validityUntil: row.validityUntil,
    feasibility: row.feasibility as BidVersion['feasibility'],
    assumptions: row.assumptions,
    exclusions: row.exclusions,
    paymentTerms: row.paymentTerms,
    note: row.note,
    contentHash: row.contentHash,
    receivedAt: row.receivedAt.toISOString(),
    late: row.late,
    revisionReason: row.revisionReason,
    lines: row.lines.map((line) => ({
      rfqItemId: line.rfqItemId,
      lineNo: line.lineNo,
      quantity: line.quantity,
      unit: line.unit,
      unitPriceMinor: line.unitPriceMinor,
      setupAmountMinor: line.setupAmountMinor,
      ...(line.leadTimeDays !== null ? { leadTimeDays: line.leadTimeDays } : {}),
      note: line.note,
    })),
  };
}
