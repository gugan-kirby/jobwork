import { Injectable } from '@nestjs/common';
import type {
  CustomerQuoteDecisionRequest,
  DraftQuoteRequest,
  Quote,
  QuoteContentInput,
  QuoteVersionActionRequest,
  ReplaceQuoteRequest,
  WithdrawQuoteRequest,
} from '@jobwork/contracts';
import { quoteContentInputSchema } from '@jobwork/contracts';
import { type Actor, requireOrganization, requireRole, requireTransactionalStrength } from '../../iam';
import { NotAuthorized } from '../../iam/domain/errors';
import { EnquiryRepository } from '../../sourcing';
import { evaluateQuotePolicy, PolicyRulesInvalid } from '../domain/approval-policy';
import { CostSheetNotApproved, CostSheetNotFound } from '../domain/cost-sheet';
import {
  QuoteNotActionable,
  QuoteNotFound,
  assertQuoteTransition,
  assertQuoteVersion,
  computeQuoteTotals,
  hashQuoteContent,
  isExpired,
} from '../domain/quote';
import { CommercialRepository, type QuoteRecord } from '../infrastructure/commercial.repository';
import { CommercialView } from './commercial-view';
import { COMMERCIAL_READ_ROLES } from './evaluate.command';
import { contextFromActor, contextFromService } from '../../../platform/commands/command';
import { CommandExecutor } from '../../../platform/commands/execute';
import { DomainError } from '../../../platform/http/domain-error';

const TERMS_CODE = 'customer_quotation_terms';

class QuoteOptionExists extends DomainError {
  constructor(label: string) {
    super('QUOTE_OPTION_EXISTS', 409, 'That option already exists for this enquiry', `There is already a ${label} quotation in this offer set. Replace it instead of adding another.`);
  }
}

class TermsMissing extends DomainError {
  constructor() {
    super('TERMS_MISSING', 500, 'No current quotation terms', 'Seed or publish a terms version before quoting.');
  }
}

/**
 * The internal quote commands (`FR-406`, `BR-COM-04`, F-07.5). The whole lifecycle is
 * named transitions with a version guard; the content of any version past draft is
 * frozen by the database, and the customer-visible reference is minted at send.
 */
@Injectable()
export class QuoteCommand {
  constructor(
    private readonly repo: CommercialRepository,
    private readonly enquiries: EnquiryRepository,
    private readonly view: CommercialView,
    private readonly executor: CommandExecutor,
  ) {}

  private requireAuthor(actor: Actor): void {
    if (!actor.isInternal) throw new NotAuthorized('JobWork only');
    requireRole(actor, 'jobwork_sales', 'jobwork_sourcing');
  }

  async get(actor: Actor, quoteId: string): Promise<Quote> {
    if (!actor.isInternal) throw new NotAuthorized('JobWork only');
    requireRole(actor, ...COMMERCIAL_READ_ROLES);
    const quote = await this.repo.findQuote(quoteId);
    if (!quote) throw new QuoteNotFound();
    return this.view.quote(quote);
  }

  async list(actor: Actor, filter: { status?: Quote['status'] | undefined; enquiryId?: string | undefined }, limit: number): Promise<Quote[]> {
    if (!actor.isInternal) throw new NotAuthorized('JobWork only');
    requireRole(actor, ...COMMERCIAL_READ_ROLES);
    const rows = filter.enquiryId
      ? await this.repo.listQuotesForEnquiry(filter.enquiryId)
      : await this.repo.listQuotes({ status: filter.status }, limit);
    return Promise.all(rows.map((row) => this.view.quote(row)));
  }

  /** A draft from an approved cost sheet version: the sell lines become the quote lines. */
  async draft(actor: Actor, input: DraftQuoteRequest, opts: { idempotencyKey?: string | undefined } = {}): Promise<Quote> {
    this.requireAuthor(actor);
    requireTransactionalStrength(actor);

    const found = await this.repo.findCostSheetVersion(input.costSheetVersionId);
    if (!found) throw new CostSheetNotFound();
    if (found.version.status !== 'approved') throw new CostSheetNotApproved(found.version.status);
    const sheet = (await this.repo.findCostSheet(found.costSheetId))!;
    const enquiry = await this.enquiries.find(sheet.enquiryId);
    const terms = await this.repo.currentTerms(TERMS_CODE);
    if (!terms) throw new TermsMissing();

    const content: QuoteContentInput = quoteContentInputSchema.parse({
      ...input.content,
      lines:
        input.content.lines ??
        found.version.sellLines.map((line) => ({
          lineNo: line.lineNo,
          description: line.description,
          quantity: line.quantity,
          unit: line.unit,
          unitPriceMinor: line.unitSellMinor,
        })),
    });
    const totals = computeQuoteTotals(content);
    const contentHash = hashQuoteContent({ currency: found.version.currency, content, totals, termsVersionId: terms.id });

    let quoteId: string;
    try {
      quoteId = await this.executor.execute(
        {
          operation: 'commercial.draft-quote',
          handler: async (tx) => {
            const offerSetId = await this.repo.findOrCreateOfferSet(
              { enquiryId: sheet.enquiryId, rfqId: sheet.rfqId, customerOrganizationId: sheet.customerOrganizationId, createdBy: actor.userId },
              tx,
            );
            const id = await this.repo.createQuote(
              {
                offerSetId,
                enquiryId: sheet.enquiryId,
                rfqId: sheet.rfqId,
                customerOrganizationId: sheet.customerOrganizationId,
                optionLabel: input.optionLabel,
                costSheetVersionId: found.version.id,
                createdBy: actor.userId,
              },
              tx,
            );
            const versionId = await this.repo.appendQuoteVersion(
              {
                quoteId: id,
                versionNo: 1,
                currency: found.version.currency,
                lines: totals.lines,
                subtotalMinor: totals.subtotalMinor,
                taxRateBp: content.taxRateBp,
                taxMinor: totals.taxMinor,
                freightMinor: content.freightMinor,
                totalMinor: totals.totalMinor,
                deliveryLeadDays: content.deliveryLeadDays,
                paymentTerms: content.paymentTerms,
                advanceBp: content.advanceBp,
                balanceTrigger: content.balanceTrigger,
                validityUntil: content.validityUntil,
                assumptions: content.assumptions,
                exclusions: content.exclusions,
                scopeNote: content.scopeNote,
                termsVersionId: terms.id,
                contentHash,
                createdBy: actor.userId,
                supersedesVersionId: null,
                revisionReason: null,
              },
              tx,
            );
            return {
              result: id,
              audit: [
                {
                  action: 'commercial.quote_drafted',
                  subjectType: 'customer_quote',
                  subjectId: id,
                  subjectVersion: 1,
                  data: { versionId, enquiryId: sheet.enquiryId, optionLabel: input.optionLabel, totalMinor: totals.totalMinor, contentHash, enquiryReference: enquiry?.reference ?? null },
                },
              ],
            };
          },
        },
        contextFromActor(actor),
        input,
        opts,
      );
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new QuoteOptionExists(input.optionLabel);
      throw err;
    }
    return this.get(actor, quoteId);
  }

  async requestApproval(actor: Actor, quoteId: string, input: QuoteVersionActionRequest, opts: { idempotencyKey?: string | undefined } = {}): Promise<Quote> {
    this.requireAuthor(actor);
    requireTransactionalStrength(actor);
    const policy = await this.repo.activePolicy('quote');
    if (!policy) throw new PolicyRulesInvalid('quote');

    await this.executor.execute(
      {
        operation: 'commercial.request-quote-approval',
        handler: async (tx, _ctx, cmd: QuoteVersionActionRequest) => {
          const quote = await this.locked(quoteId, cmd.expectedVersion, tx);
          assertQuoteTransition(quote.status, 'internal_approval');
          const current = this.current(quote);
          const outcome = evaluateQuotePolicy(policy.rules, { amountMinor: current.totalMinor });
          const requestId = await this.repo.createApprovalRequest(
            {
              kind: 'quote',
              subjectType: 'quote_version',
              subjectId: current.id,
              subjectVersionNo: current.versionNo,
              subjectHash: current.contentHash,
              policyVersionId: policy.id,
              requestedBy: actor.userId,
              amountMinor: current.totalMinor,
              currency: current.currency,
              marginBp: null,
              context: {
                quoteId,
                enquiryReference: quote.enquiryReference,
                label: `Quotation for ${quote.enquiryReference ?? quote.enquiryTitle} v${current.versionNo} (${quote.optionLabel})`,
              },
              requiredRoles: outcome.requiredRoles,
            },
            tx,
          );
          await this.repo.setQuoteVersionStatus({ versionId: current.id, status: 'internal_approval', approvalRequestId: requestId }, tx);
          await this.repo.setQuoteStatus({ quoteId, status: 'internal_approval' }, tx);
          return {
            result: undefined,
            audit: [
              {
                action: 'commercial.quote_approval_requested',
                subjectType: 'customer_quote',
                subjectId: quoteId,
                subjectVersion: current.versionNo,
                data: { approvalRequestId: requestId, totalMinor: current.totalMinor, requiredRoles: outcome.requiredRoles },
              },
            ],
            outbox: [
              {
                eventType: 'commercial.quote_approval_requested.v1',
                aggregateType: 'customer_quote',
                aggregateId: quoteId,
                data: { approvalRequestId: requestId, requiredRoles: outcome.requiredRoles },
              },
            ],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.get(actor, quoteId);
  }

  /** approved → sent: the customer can see it from here on. Reference minted now. */
  async send(actor: Actor, quoteId: string, input: QuoteVersionActionRequest, opts: { idempotencyKey?: string | undefined } = {}): Promise<Quote> {
    this.requireAuthor(actor);
    requireTransactionalStrength(actor);
    await this.executor.execute(
      {
        operation: 'commercial.send-quote',
        handler: async (tx, _ctx, cmd: QuoteVersionActionRequest) => {
          const quote = await this.locked(quoteId, cmd.expectedVersion, tx);
          assertQuoteTransition(quote.status, 'sent');
          const current = this.current(quote);
          if (current.status !== 'approved') throw new QuoteNotActionable(quote.status);
          const now = new Date();
          if (isExpired(current.validityUntil, now)) {
            throw new DomainError('QUOTE_VALIDITY_PASSED', 409, 'The validity date has already passed', 'Replace it with a fresh validity before sending.');
          }
          const reference = quote.reference ?? (await this.repo.allocateQuoteReference(tx, now));
          await this.repo.setQuoteVersionStatus({ versionId: current.id, status: 'sent', sentAt: now }, tx);
          // Any earlier sent version is now history.
          for (const v of quote.versions) {
            if (v.id !== current.id && v.status === 'sent') {
              await this.repo.setQuoteVersionStatus({ versionId: v.id, status: 'superseded' }, tx);
            }
          }
          await this.repo.setQuoteStatus({ quoteId, status: 'sent', reference }, tx);
          return {
            result: undefined,
            audit: [
              {
                action: 'commercial.quote_sent',
                subjectType: 'customer_quote',
                subjectId: quoteId,
                subjectVersion: current.versionNo,
                data: { reference, contentHash: current.contentHash, totalMinor: current.totalMinor, validityUntil: current.validityUntil },
              },
            ],
            outbox: [
              {
                eventType: 'commercial.quote_sent.v1',
                aggregateType: 'customer_quote',
                aggregateId: quoteId,
                data: { quoteId, reference, versionNo: current.versionNo, customerOrganizationId: quote.customerOrganizationId, validityUntil: current.validityUntil },
              },
            ],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.get(actor, quoteId);
  }

  /** A replacement: a new draft version that supersedes the sent one once it is itself sent. */
  async replace(actor: Actor, quoteId: string, input: ReplaceQuoteRequest, opts: { idempotencyKey?: string | undefined } = {}): Promise<Quote> {
    this.requireAuthor(actor);
    requireTransactionalStrength(actor);
    const terms = await this.repo.currentTerms(TERMS_CODE);
    if (!terms) throw new TermsMissing();

    await this.executor.execute(
      {
        operation: 'commercial.replace-quote',
        handler: async (tx, _ctx, cmd: ReplaceQuoteRequest) => {
          const quote = await this.locked(quoteId, cmd.expectedVersion, tx);
          assertQuoteTransition(quote.status, 'draft');
          const current = this.current(quote);
          const totals = computeQuoteTotals(cmd.content);
          const contentHash = hashQuoteContent({ currency: current.currency, content: cmd.content, totals, termsVersionId: terms.id });
          // A still-draft or approved-but-unsent current version is simply replaced by
          // the new draft; a sent one stays as the customer saw it until the new one ships.
          if (current.status === 'draft' || current.status === 'approved' || current.status === 'internal_approval') {
            await this.repo.setQuoteVersionStatus({ versionId: current.id, status: 'withdrawn' }, tx);
            if (current.approvalRequestId) await this.repo.supersedeApprovalRequest(current.approvalRequestId, tx);
          }
          const versionId = await this.repo.appendQuoteVersion(
            {
              quoteId,
              versionNo: quote.currentVersionNo + 1,
              currency: current.currency,
              lines: totals.lines,
              subtotalMinor: totals.subtotalMinor,
              taxRateBp: cmd.content.taxRateBp,
              taxMinor: totals.taxMinor,
              freightMinor: cmd.content.freightMinor,
              totalMinor: totals.totalMinor,
              deliveryLeadDays: cmd.content.deliveryLeadDays,
              paymentTerms: cmd.content.paymentTerms,
              advanceBp: cmd.content.advanceBp,
              balanceTrigger: cmd.content.balanceTrigger,
              validityUntil: cmd.content.validityUntil,
              assumptions: cmd.content.assumptions,
              exclusions: cmd.content.exclusions,
              scopeNote: cmd.content.scopeNote,
              termsVersionId: terms.id,
              contentHash,
              createdBy: actor.userId,
              supersedesVersionId: current.id,
              revisionReason: cmd.revisionReason,
            },
            tx,
          );
          await this.repo.setQuoteStatus({ quoteId, status: 'draft' }, tx);
          return {
            result: undefined,
            audit: [
              {
                action: 'commercial.quote_replaced',
                subjectType: 'customer_quote',
                subjectId: quoteId,
                subjectVersion: quote.currentVersionNo + 1,
                reason: cmd.revisionReason,
                data: { versionId, supersedesVersionId: current.id, totalMinor: totals.totalMinor, contentHash },
              },
            ],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.get(actor, quoteId);
  }

  async withdraw(actor: Actor, quoteId: string, input: WithdrawQuoteRequest, opts: { idempotencyKey?: string | undefined } = {}): Promise<Quote> {
    this.requireAuthor(actor);
    requireTransactionalStrength(actor);
    await this.executor.execute(
      {
        operation: 'commercial.withdraw-quote',
        handler: async (tx, _ctx, cmd: WithdrawQuoteRequest) => {
          const quote = await this.locked(quoteId, cmd.expectedVersion, tx);
          assertQuoteTransition(quote.status, 'withdrawn');
          for (const v of quote.versions) {
            if (['draft', 'internal_approval', 'approved', 'sent'].includes(v.status)) {
              await this.repo.setQuoteVersionStatus({ versionId: v.id, status: 'withdrawn' }, tx);
              if (v.approvalRequestId) await this.repo.supersedeApprovalRequest(v.approvalRequestId, tx);
            }
          }
          await this.repo.setQuoteStatus({ quoteId, status: 'withdrawn', decisionReason: cmd.reason }, tx);
          return {
            result: undefined,
            audit: [{ action: 'commercial.quote_withdrawn', subjectType: 'customer_quote', subjectId: quoteId, reason: cmd.reason }],
            outbox: [{ eventType: 'commercial.quote_withdrawn.v1', aggregateType: 'customer_quote', aggregateId: quoteId, data: { quoteId } }],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.get(actor, quoteId);
  }

  /** The expiry sweep (worker-driven): sent quotes past validity become `expired`. */
  async expireDue(principal: { id: string }, now = new Date()): Promise<{ expired: number }> {
    const due = await this.repo.listExpiredSentQuotes(now);
    let expired = 0;
    for (const { quoteId, versionId } of due) {
      await this.executor.execute(
        {
          operation: 'commercial.expire-quote',
          handler: async (tx) => {
            const quote = await this.repo.findQuote(quoteId, tx, true);
            if (!quote || !['sent', 'revision_requested'].includes(quote.status)) return { result: undefined, audit: [] };
            await this.repo.setQuoteVersionStatus({ versionId, status: 'expired' }, tx);
            await this.repo.setQuoteStatus({ quoteId, status: 'expired' }, tx);
            expired += 1;
            return {
              result: undefined,
              audit: [{ action: 'commercial.quote_expired', subjectType: 'customer_quote', subjectId: quoteId, data: { versionId } }],
              outbox: [{ eventType: 'commercial.quote_expired.v1', aggregateType: 'customer_quote', aggregateId: quoteId, data: { quoteId } }],
            };
          },
        },
        contextFromService(principal, null),
        { quoteId, versionId },
      );
    }
    return { expired };
  }

  // ------------------------------------------------------------- customer side

  private async customerLocked(actor: Actor, quoteId: string, expectedVersion: number, tx: Parameters<CommercialRepository['setQuoteStatus']>[1]): Promise<QuoteRecord> {
    const organizationId = requireOrganization(actor);
    const quote = await this.repo.findQuote(quoteId, tx, true);
    // Not yours and does not exist are the same answer (doc 11 §5).
    if (!quote || quote.customerOrganizationId !== organizationId || quote.reference === null) throw new QuoteNotFound();
    assertQuoteVersion(expectedVersion, quote.aggregateVersion);
    if (quote.status !== 'sent') throw new QuoteNotActionable(quote.status);
    const current = this.current(quote);
    if (isExpired(current.validityUntil, new Date())) throw new QuoteNotActionable('expired');
    return quote;
  }

  async requestRevision(actor: Actor, quoteId: string, input: CustomerQuoteDecisionRequest, opts: { idempotencyKey?: string | undefined } = {}): Promise<void> {
    if (actor.organizationType !== 'customer') throw new NotAuthorized('Customers only');
    requireRole(actor, 'customer_requester', 'customer_approver');
    await this.executor.execute(
      {
        operation: 'commercial.request-quote-revision',
        handler: async (tx, _ctx, cmd: CustomerQuoteDecisionRequest) => {
          const quote = await this.customerLocked(actor, quoteId, cmd.expectedVersion, tx);
          assertQuoteTransition(quote.status, 'revision_requested');
          await this.repo.setQuoteStatus({ quoteId, status: 'revision_requested', decisionReason: cmd.reason }, tx);
          return {
            result: undefined,
            audit: [{ action: 'commercial.quote_revision_requested', subjectType: 'customer_quote', subjectId: quoteId, reason: cmd.reason }],
            outbox: [{ eventType: 'commercial.quote_revision_requested.v1', aggregateType: 'customer_quote', aggregateId: quoteId, data: { quoteId, reason: cmd.reason } }],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
  }

  async reject(actor: Actor, quoteId: string, input: CustomerQuoteDecisionRequest, opts: { idempotencyKey?: string | undefined } = {}): Promise<void> {
    if (actor.organizationType !== 'customer') throw new NotAuthorized('Customers only');
    requireRole(actor, 'customer_approver');
    await this.executor.execute(
      {
        operation: 'commercial.reject-quote',
        handler: async (tx, _ctx, cmd: CustomerQuoteDecisionRequest) => {
          const quote = await this.customerLocked(actor, quoteId, cmd.expectedVersion, tx);
          assertQuoteTransition(quote.status, 'rejected');
          await this.repo.setQuoteVersionStatus({ versionId: this.current(quote).id, status: 'rejected' }, tx);
          await this.repo.setQuoteStatus({ quoteId, status: 'rejected', decisionReason: cmd.reason }, tx);
          return {
            result: undefined,
            audit: [{ action: 'commercial.quote_rejected', subjectType: 'customer_quote', subjectId: quoteId, reason: cmd.reason }],
            outbox: [{ eventType: 'commercial.quote_rejected.v1', aggregateType: 'customer_quote', aggregateId: quoteId, data: { quoteId, reason: cmd.reason } }],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
  }

  // ------------------------------------------------------------- helpers

  private async locked(quoteId: string, expectedVersion: number, tx: Parameters<CommercialRepository['setQuoteStatus']>[1]): Promise<QuoteRecord> {
    const quote = await this.repo.findQuote(quoteId, tx, true);
    if (!quote) throw new QuoteNotFound();
    assertQuoteVersion(expectedVersion, quote.aggregateVersion);
    return quote;
  }

  private current(quote: QuoteRecord): QuoteRecord['versions'][number] {
    const current = quote.versions.find((v) => v.versionNo === quote.currentVersionNo);
    if (!current) throw new QuoteNotFound();
    return current;
  }
}
