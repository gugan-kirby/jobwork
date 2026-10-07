import { Injectable } from '@nestjs/common';
import type {
  ApprovalRequest,
  Award,
  CostSheet,
  Evaluation,
  Quote,
  QuoteVersion,
} from '@jobwork/contracts';
import { evaluationScenarioSchema } from '@jobwork/contracts';
import {
  CommercialRepository,
  type ApprovalRequestRow,
  type AwardRecord,
  type CostSheetRecord,
  type EvaluationRecord,
  type QuoteRecord,
  type QuoteVersionRecord,
} from '../infrastructure/commercial.repository';

/**
 * Internal DTO mapping. Everything here is for JobWork's eyes; the customer projection
 * lives in `presentation/customer-quote.projection.ts` and is a different type.
 */
@Injectable()
export class CommercialView {
  constructor(private readonly repo: CommercialRepository) {}

  evaluation(record: EvaluationRecord, currency: string): Evaluation {
    return {
      evaluationId: record.id,
      rfqId: record.rfqId,
      configVersion: record.configVersion,
      scenario: evaluationScenarioSchema.parse(record.scenario),
      scenarioHash: record.scenarioHash,
      currency,
      rows: record.rows.map((row) => ({
        bidVersionId: row.bidVersionId,
        supplierOrganizationId: row.supplierOrganizationId,
        supplierDisplayName: row.supplierDisplayName,
        versionNo: row.versionNo,
        originalTotalMinor: row.originalTotalMinor,
        normalizedLandedMinor: row.normalizedLandedMinor,
        components: row.components,
        lines: row.lines,
        leadTimeDays: row.leadTimeDays,
        validityUntil: row.validityUntil,
        feasibility: row.feasibility,
        rank: row.rank,
        flags: row.flags as Evaluation['rows'][number]['flags'],
      })),
      createdAt: record.createdAt.toISOString(),
    };
  }

  approval(row: ApprovalRequestRow): ApprovalRequest {
    const { href, title } = approvalTarget(row);
    return {
      approvalRequestId: row.id,
      kind: row.kind,
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      subjectVersionNo: row.subjectVersionNo,
      subjectHash: row.subjectHash,
      policyVersionId: row.policyVersionId,
      policyVersionNo: row.policyVersionNo,
      requestedBy: row.requestedBy,
      requestedByName: row.requestedByName,
      requestedAt: row.requestedAt.toISOString(),
      amountMinor: row.amountMinor,
      currency: row.currency,
      marginBp: row.marginBp,
      context: row.context,
      requiredRoles: row.requiredRoles,
      status: row.status,
      decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
      decisions: row.decisions.map((d) => ({
        decisionId: d.id,
        decision: d.decision,
        decidedBy: d.decidedBy,
        decidedByName: d.decidedByName,
        decidedAt: d.decidedAt.toISOString(),
        authoritySnapshot: d.authoritySnapshot,
        reason: d.reason,
      })),
      href,
      title,
    };
  }

  async award(record: AwardRecord): Promise<Award> {
    const approval = record.approvalRequestId
      ? await this.repo.findApprovalRequest(record.approvalRequestId)
      : null;
    return {
      awardId: record.id,
      rfqId: record.rfqId,
      rfqReference: record.rfqReference,
      enquiryId: record.enquiryId,
      evaluationId: record.evaluationId,
      status: record.status,
      singleSource: record.singleSource,
      rationale: record.rationale,
      fallbackNote: record.fallbackNote,
      proposedBy: record.proposedBy,
      proposedAt: record.proposedAt.toISOString(),
      approvalRequestId: record.approvalRequestId,
      approvalStatus: approval?.status ?? null,
      decidedAt: record.decidedAt ? record.decidedAt.toISOString() : null,
      currency: record.currency,
      buyTotalMinor: record.buyTotalMinor,
      lines: record.lines.map((line) => ({
        awardLineId: line.id,
        rfqItemId: line.rfqItemId,
        lineNo: line.lineNo,
        bidVersionId: line.bidVersionId,
        supplierOrganizationId: line.supplierOrganizationId,
        supplierDisplayName: line.supplierDisplayName,
        bidQuantity: line.bidQuantity,
        quantity: line.quantity,
        unit: line.unit,
        unitPriceMinor: line.unitPriceMinor,
        setupAmountMinor: line.setupAmountMinor,
        freightAmountMinor: line.freightAmountMinor,
        nreAmountMinor: line.nreAmountMinor,
        lineTotalMinor: line.lineTotalMinor,
      })),
      costSheetId: record.costSheetId,
      aggregateVersion: record.aggregateVersion,
    };
  }

  async costSheet(record: CostSheetRecord, minMarginBp: number): Promise<CostSheet> {
    const versions = await Promise.all(
      record.versions.map(async (v) => {
        const approval = v.approvalRequestId ? await this.repo.findApprovalRequest(v.approvalRequestId) : null;
        return {
          costSheetVersionId: v.id,
          versionNo: v.versionNo,
          status: v.status,
          currency: v.currency,
          buyTotalMinor: v.buyTotalMinor,
          components: v.components,
          landedTotalMinor: v.landedTotalMinor,
          marginMinor: v.marginMinor,
          marginBp: v.marginBp,
          sellTotalMinor: v.sellTotalMinor,
          sellLines: v.sellLines,
          note: v.note,
          contentHash: v.contentHash,
          approvalRequestId: v.approvalRequestId,
          approvalStatus: approval?.status ?? null,
          createdAt: v.createdAt.toISOString(),
          supersedesVersionId: v.supersedesVersionId,
        };
      }),
    );
    return {
      costSheetId: record.id,
      rfqId: record.rfqId,
      awardId: record.awardId,
      enquiryId: record.enquiryId,
      customerOrganizationId: record.customerOrganizationId,
      status: record.status,
      currentVersionNo: record.currentVersionNo,
      aggregateVersion: record.aggregateVersion,
      minMarginBp,
      versions,
    };
  }

  async quote(record: QuoteRecord): Promise<Quote> {
    const versions: QuoteVersion[] = await Promise.all(
      record.versions.map(async (v) => {
        const approval = v.approvalRequestId ? await this.repo.findApprovalRequest(v.approvalRequestId) : null;
        return toQuoteVersion(v, approval?.status ?? null);
      }),
    );
    return {
      quoteId: record.id,
      offerSetId: record.offerSetId,
      enquiryId: record.enquiryId,
      enquiryReference: record.enquiryReference,
      enquiryTitle: record.enquiryTitle,
      rfqId: record.rfqId,
      customerOrganizationId: record.customerOrganizationId,
      customerDisplayName: record.customerDisplayName,
      optionLabel: record.optionLabel,
      reference: record.reference,
      costSheetVersionId: record.costSheetVersionId,
      status: record.status,
      currentVersionNo: record.currentVersionNo,
      decisionReason: record.decisionReason,
      acceptedVersionId: record.acceptedVersionId,
      aggregateVersion: record.aggregateVersion,
      createdAt: record.createdAt.toISOString(),
      versions,
    };
  }
}

export function toQuoteVersion(v: QuoteVersionRecord, approvalStatus: QuoteVersion['approvalStatus']): QuoteVersion {
  return {
    quoteVersionId: v.id,
    versionNo: v.versionNo,
    status: v.status,
    currency: v.currency,
    lines: v.lines,
    subtotalMinor: v.subtotalMinor,
    taxRateBp: v.taxRateBp,
    taxMinor: v.taxMinor,
    freightMinor: v.freightMinor,
    totalMinor: v.totalMinor,
    deliveryLeadDays: v.deliveryLeadDays,
    paymentTerms: v.paymentTerms,
    advanceBp: v.advanceBp,
    balanceTrigger: v.balanceTrigger,
    validityUntil: v.validityUntil,
    assumptions: v.assumptions,
    exclusions: v.exclusions,
    scopeNote: v.scopeNote,
    termsVersionId: v.termsVersionId,
    termsVersionNo: v.termsVersionNo,
    termsHash: v.termsHash,
    contentHash: v.contentHash,
    approvalRequestId: v.approvalRequestId,
    approvalStatus,
    sentAt: v.sentAt ? v.sentAt.toISOString() : null,
    createdAt: v.createdAt.toISOString(),
    supersedesVersionId: v.supersedesVersionId,
    revisionReason: v.revisionReason,
  };
}

function approvalTarget(row: ApprovalRequestRow): { href: string; title: string } {
  const context = row.context as { awardId?: string; costSheetId?: string; quoteId?: string; rfqReference?: string | null; label?: string; ncrId?: string; shipmentId?: string };
  switch (row.kind) {
    case 'allocation':
      return { href: '/finance', title: context.label ?? 'Cash allocation' };
    case 'award':
      return { href: `/awards/${context.awardId ?? row.subjectId}`, title: context.label ?? `Award on ${context.rfqReference ?? 'round'}` };
    case 'cost_sheet':
      return { href: `/cost-sheets/${context.costSheetId ?? row.subjectId}`, title: context.label ?? 'Cost sheet' };
    case 'quote':
      return { href: `/quotes/${context.quoteId ?? row.subjectId}`, title: context.label ?? 'Customer quotation' };
    case 'change':
      return { href: `/changes/${row.subjectId}`, title: context.label ?? 'Engineering change' };
    case 'deviation':
      return { href: `/quality/ncrs/${context.ncrId ?? ''}`, title: context.label ?? 'Deviation' };
    case 'dispatch_override':
      return { href: `/logistics/shipments/${context.shipmentId ?? row.subjectId}`, title: context.label ?? 'Dispatch override' };
    case 'bill_exception':
      return { href: '/finance/bills', title: context.label ?? 'Supplier bill exception' };
    case 'case_resolution':
      return { href: `/support/${row.subjectId}`, title: context.label ?? 'Support case resolution' };
  }
}
