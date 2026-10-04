import { Injectable } from '@nestjs/common';
import type { AcceptQuoteRequest } from '@jobwork/contracts';
import { CommercialRepository, QuoteNotActionable, QuoteNotFound, assertQuoteVersion, isExpired } from '../../commercial';
import { type Actor, IamRepository, requireOrganization, requireRole } from '../../iam';
import { NotAuthorized } from '../../iam/domain/errors';
import { ApprovalLimitExceeded, QuoteContentMismatch } from '../domain/errors';
import { splitSchedule } from '../domain/schedule';
import { FinanceRepository } from '../infrastructure/finance.repository';
import { OrdersRepository } from '../infrastructure/orders.repository';
import { MoneyFlow, sha256 } from './money-flow';
import { contextFromActor } from '../../../platform/commands/command';
import { CommandExecutor } from '../../../platform/commands/execute';
import { DomainError } from '../../../platform/http/domain-error';

const OPEN_SIBLING = new Set(['draft', 'internal_approval', 'approved', 'sent', 'revision_requested']);
const OPEN_VERSION = new Set(['draft', 'internal_approval', 'approved', 'sent']);

/**
 * accept-quote (`FR-407`, `FR-501`, `UC-05`, doc 02 §8). One transaction:
 *
 *  1. serialize on the offer set, lock the quote, check its aggregate version;
 *  2. the exact sent version, unexpired, whose content and terms hashes the customer saw;
 *  3. the actor's membership, `customer_approver` role and acceptance limit (`D-07`);
 *  4. immutable acceptance evidence, quote → accepted, sibling options withdrawn;
 *  5. contract snapshot, sales order, instalments, the advance invoice and its journal;
 *  6. the release gate (credit may cover it), audit, outbox — all committed together.
 *
 * A retry with the same idempotency key returns the first result; anything that fails
 * leaves nothing behind.
 */
@Injectable()
export class AcceptQuoteCommand {
  constructor(
    private readonly commercial: CommercialRepository,
    private readonly orders: OrdersRepository,
    private readonly finance: FinanceRepository,
    private readonly iam: IamRepository,
    private readonly money: MoneyFlow,
    private readonly executor: CommandExecutor,
  ) {}

  async execute(actor: Actor, quotationId: string, input: AcceptQuoteRequest, opts: { idempotencyKey?: string | undefined } = {}): Promise<{ orderId: string }> {
    if (actor.organizationType !== 'customer') throw new NotAuthorized('Customer organizations only');
    requireRole(actor, 'customer_approver');
    const organizationId = requireOrganization(actor);
    const ctx = contextFromActor(actor);

    try {
      return await this.executor.execute(
        {
          operation: 'orders.accept-quote',
          handler: async (tx, _ctx, cmd: AcceptQuoteRequest) => {
            const peek = await this.commercial.findQuote(quotationId, tx);
            if (!peek || peek.customerOrganizationId !== organizationId || peek.reference === null) throw new QuoteNotFound();
            await this.orders.lockOfferSet(peek.offerSetId, tx);
            const quote = (await this.commercial.findQuote(quotationId, tx, true))!;
            assertQuoteVersion(cmd.expectedVersion, quote.aggregateVersion);
            if (quote.status !== 'sent') throw new QuoteNotActionable(quote.status);
            const version = quote.versions.find((v) => v.versionNo === quote.currentVersionNo);
            if (!version || version.status !== 'sent') throw new QuoteNotActionable(quote.status);
            const now = new Date();
            if (isExpired(version.validityUntil, now)) throw new QuoteNotActionable('expired');
            if (version.versionNo !== cmd.quoteVersionNo) throw new QuoteContentMismatch('version');
            if (version.contentHash !== cmd.contentHash) throw new QuoteContentMismatch('content');
            if (version.termsHash !== cmd.termsHash) throw new QuoteContentMismatch('terms');

            // Authority is read inside the transaction, not trusted from the session (doc 02 §8 step 4).
            const membership = await this.iam.findActiveMembership(actor.userId, organizationId, tx);
            if (!membership || !membership.roles.includes('customer_approver')) throw new NotAuthorized('Requires customer_approver');
            const limit = await this.orders.customerApprovalLimit(membership.membershipId, version.currency, tx);
            if (limit && version.totalMinor > limit.amountMinor) throw new ApprovalLimitExceeded(limit.amountMinor, version.totalMinor, version.currency);

            let deliverySiteId = cmd.deliverySiteId ?? (await this.orders.enquiryDeliverySite(quote.enquiryId, tx));
            if (deliverySiteId && !(await this.orders.siteBelongsTo(deliverySiteId, organizationId, tx))) {
              if (cmd.deliverySiteId) {
                throw new DomainError('DELIVERY_SITE_INVALID', 422, 'That delivery site is not one of yours', undefined, [{ path: 'deliverySiteId', message: 'Choose an active site of your organization' }]);
              }
              deliverySiteId = null;
            }

            const authoritySnapshot = { roles: membership.roles, limitMinor: limit?.amountMinor ?? null, currency: limit ? version.currency : null };
            const acceptanceId = await this.orders.createAcceptance(
              {
                customerQuoteId: quote.id,
                quoteVersionId: version.id,
                contentHash: version.contentHash,
                termsVersionId: version.termsVersionId,
                termsHash: version.termsHash,
                acceptedBy: actor.userId,
                organizationId,
                authoritySnapshot,
                idempotencyKey: opts.idempotencyKey ?? null,
                correlationId: ctx.correlationId,
              },
              tx,
            );
            await this.commercial.setQuoteVersionStatus({ versionId: version.id, status: 'accepted' }, tx);
            await this.commercial.setQuoteStatus({ quoteId: quote.id, status: 'accepted', acceptedVersionId: version.id }, tx);

            // One accepted option per offer set (doc 19 §7): the others are closed, with the reason.
            const withdrawn: string[] = [];
            for (const sibling of await this.commercial.listSiblings(quote.offerSetId, tx)) {
              if (sibling.id === quote.id || !OPEN_SIBLING.has(sibling.status)) continue;
              for (const v of sibling.versions) {
                if (OPEN_VERSION.has(v.status)) {
                  await this.commercial.setQuoteVersionStatus({ versionId: v.id, status: 'withdrawn' }, tx);
                  if (v.approvalRequestId) await this.commercial.supersedeApprovalRequest(v.approvalRequestId, tx);
                }
              }
              await this.commercial.setQuoteStatus({ quoteId: sibling.id, status: 'withdrawn', decisionReason: `Another option (${quote.optionLabel}) was accepted.` }, tx);
              withdrawn.push(sibling.id);
            }

            // The sell-side contract: what was agreed, with whom, under which terms — nothing of the buy side.
            const snapshot = {
              kind: 'customer_sales_contract',
              quotation: { reference: quote.reference, versionNo: version.versionNo, optionLabel: quote.optionLabel, contentHash: version.contentHash },
              enquiry: { enquiryId: quote.enquiryId, reference: quote.enquiryReference, title: quote.enquiryTitle },
              customer: { organizationId, name: quote.customerDisplayName },
              currency: version.currency,
              lines: version.lines,
              subtotalMinor: version.subtotalMinor,
              taxRateBp: version.taxRateBp,
              taxMinor: version.taxMinor,
              freightMinor: version.freightMinor,
              totalMinor: version.totalMinor,
              deliveryLeadDays: version.deliveryLeadDays,
              deliverySiteId,
              paymentTerms: version.paymentTerms,
              schedule: { advanceBp: version.advanceBp, balanceTrigger: version.balanceTrigger },
              validityUntil: version.validityUntil,
              assumptions: version.assumptions,
              exclusions: version.exclusions,
              scopeNote: version.scopeNote,
              terms: { code: version.termsCode, versionNo: version.termsVersionNo, hash: version.termsHash },
              acceptance: { acceptanceId, acceptedBy: actor.userId, acceptedAt: now.toISOString(), authority: authoritySnapshot },
            };
            const contractHash = sha256(snapshot);
            const contractSnapshotId = await this.orders.createContractSnapshot({ acceptanceId, snapshot, contentHash: contractHash }, tx);

            const number = await this.orders.allocateNumber('SO', now, tx);
            const orderId = await this.orders.createSalesOrder(
              {
                number,
                customerOrganizationId: organizationId,
                enquiryId: quote.enquiryId,
                customerQuoteId: quote.id,
                acceptedQuoteVersionId: version.id,
                acceptanceId,
                contractSnapshotId,
                title: quote.enquiryTitle || quote.reference!,
                currency: version.currency,
                totalMinor: version.totalMinor,
                deliveryLeadDays: version.deliveryLeadDays,
                deliverySiteId,
                lines: version.lines,
              },
              tx,
            );

            const parts = splitSchedule({ totalMinor: version.totalMinor, taxMinor: version.taxMinor, advanceBp: version.advanceBp, balanceTrigger: version.balanceTrigger });
            const installments = await this.finance.createInstallments(
              parts.map((p) => ({ salesOrderId: orderId, seq: p.seq, kind: p.kind, label: p.label, amountMinor: p.amountMinor, currency: version.currency, trigger: p.trigger })),
              tx,
            );

            const audit = [
              {
                action: 'commercial.quote_accepted',
                subjectType: 'customer_quote',
                subjectId: quote.id,
                subjectVersion: version.versionNo,
                data: { acceptanceId, contentHash: version.contentHash, termsHash: version.termsHash, totalMinor: version.totalMinor, authority: authoritySnapshot, withdrawnSiblings: withdrawn },
              },
              {
                action: 'orders.sales_order_created',
                subjectType: 'sales_order',
                subjectId: orderId,
                subjectVersion: 1,
                data: { number, acceptanceId, contractSnapshotId, contractHash, totalMinor: version.totalMinor, installments: parts.map((p) => ({ seq: p.seq, kind: p.kind, amountMinor: p.amountMinor })) },
              },
            ];
            const outbox = [
              {
                eventType: 'commercial.quote_accepted.v1',
                aggregateType: 'customer_quote',
                aggregateId: quote.id,
                data: { quoteId: quote.id, reference: quote.reference, versionNo: version.versionNo, acceptanceId, customerOrganizationId: organizationId },
              },
              {
                eventType: 'orders.sales_order_created.v1',
                aggregateType: 'sales_order',
                aggregateId: orderId,
                data: { orderId, number, customerOrganizationId: organizationId, totalMinor: version.totalMinor, currency: version.currency },
              },
            ];

            // Whatever falls due at acceptance is invoiced now, so "pay the advance" is a real invoice.
            const order = (await this.orders.findSalesOrder(orderId, tx))!;
            for (const installment of installments.filter((i) => i.trigger === 'on_acceptance')) {
              const issued = await this.money.issueInstallmentInvoice({ order, installment, issuedBy: actor.userId, correlationId: ctx.correlationId, now }, tx);
              audit.push(...(issued.audit as typeof audit));
              outbox.push(...(issued.outbox as typeof outbox));
            }
            // Approved credit may already cover it (doc 10 §4); otherwise it waits for the advance.
            const release = await this.money.releaseIfGatePasses(orderId, tx, 'accepted within approved credit');
            audit.push(...(release.audit as typeof audit));
            outbox.push(...(release.outbox as typeof outbox));

            return { result: { orderId }, audit, outbox };
          },
        },
        ctx,
        input,
        opts,
      );
    } catch (err) {
      // The partial unique index is the backstop behind the offer-set lock.
      if ((err as { code?: string; constraint?: string }).constraint === 'uq_offer_set_single_acceptance') throw new QuoteNotActionable('accepted');
      throw err;
    }
  }
}
