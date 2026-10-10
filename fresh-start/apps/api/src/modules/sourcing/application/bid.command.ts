import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type {
  AcceptOfferRequest,
  AcknowledgeRfqRequest,
  DeclineRfqRequest,
  SaveBidDraftRequest,
  SubmitBidRequest,
  WithdrawBidRequest,
} from '@jobwork/contracts';
import { type Actor, requireOrganization, requireTransactionalStrength } from '../../iam';
import { NotAuthorized } from '../../iam/domain/errors';
import {
  assertBidTransition,
  BidNotFound,
  BidRejected,
  hashBid,
  lateness,
  validateBid,
} from '../domain/bid';
import { assertInvitationTransition, OfferRefused, OPEN_INVITATION_STATES, RfqNotFound } from '../domain/rfq';
import { type InvitationRow, type RfqItemRow, RfqRepository } from '../infrastructure/rfq.repository';
import { type AuditSpec, contextFromActor, type OutboxSpec } from '../../../platform/commands/command';
import { CommandExecutor } from '../../../platform/commands/execute';

/** Supplier roles that may answer an RFQ (doc 03 §2). */
function assertMayBid(actor: Actor): void {
  if (
    actor.organizationType !== 'supplier' ||
    !actor.roles.some((role) =>
      ['org_admin', 'supplier_estimator', 'supplier_production'].includes(role),
    )
  ) {
    throw new NotAuthorized('Only a supplier estimator answers an RFQ');
  }
}

/**
 * The supplier's side of a round (doc 06 §5, `FR-306`, `FR-401`).
 *
 * A draft is a convenience and is stored as one — free-form, overwritten, never
 * evidence. Submitting turns it into an immutable version with a content hash, and a
 * revision is a *new* version that supersedes the old one. Nothing here can edit what
 * was already submitted; the database refuses it even if this code tries.
 *
 * Every method resolves the round through the caller's own invitation, so a supplier can
 * only ever reach a round it was invited to, and never another supplier's bid.
 */
/** `FR-408`: a fixed-price round takes the offer as offered, never a free price. */
const FIXED_ROUND = (): OfferRefused => new OfferRefused('FIXED_PRICE_ROUND', 'This round is offered at a fixed price: accept the offer or decline it.');

@Injectable()
export class BidCommand {
  constructor(
    private readonly rfqs: RfqRepository,
    private readonly executor: CommandExecutor,
  ) {}

  private async ownInvitation(actor: Actor, rfqId: string) {
    const organizationId = requireOrganization(actor);
    assertMayBid(actor);
    const invitation = await this.rfqs.findInvitationForOrganization(rfqId, organizationId);
    // Not "forbidden": a round this supplier was not invited to does not exist for it.
    if (!invitation) throw new RfqNotFound();
    const rfq = await this.rfqs.findRfq(rfqId);
    if (!rfq) throw new RfqNotFound();
    return { organizationId, invitation, rfq };
  }

  async acknowledge(
    actor: Actor,
    rfqId: string,
    input: AcknowledgeRfqRequest,
    opts: { idempotencyKey?: string | undefined } = {},
  ): Promise<{ status: string }> {
    requireTransactionalStrength(actor);
    const { invitation, organizationId } = await this.ownInvitation(actor, rfqId);
    if (invitation.status === 'acknowledged') return { status: invitation.status };
    assertInvitationTransition(invitation.status, 'acknowledged');

    return this.executor.execute(
      {
        operation: 'sourcing.acknowledge-rfq',
        handler: async (tx, _ctx, cmd: AcknowledgeRfqRequest) => {
          const updated = await this.rfqs.setInvitationStatus(
            { invitationId: invitation.id, status: 'acknowledged' },
            tx,
          );
          return {
            result: { status: updated?.status ?? 'acknowledged' },
            audit: [
              {
                action: 'sourcing.rfq_acknowledged',
                subjectType: 'rfq_supplier',
                subjectId: invitation.id,
                ...(cmd.note ? { reason: cmd.note } : {}),
                data: { rfqId, supplierOrganizationId: organizationId },
              },
            ],
          };
        },
      },
      contextFromActor({ userId: actor.userId, organizationId }),
      input,
      opts,
    );
  }

  /** Declining is structured (`FR-306`): a code sourcing can count, and a sentence. */
  async decline(
    actor: Actor,
    rfqId: string,
    input: DeclineRfqRequest,
    opts: { idempotencyKey?: string | undefined } = {},
  ): Promise<{ status: string }> {
    requireTransactionalStrength(actor);
    const { invitation, organizationId } = await this.ownInvitation(actor, rfqId);
    assertInvitationTransition(invitation.status, 'declined');

    return this.executor.execute(
      {
        operation: 'sourcing.decline-rfq',
        handler: async (tx, _ctx, cmd: DeclineRfqRequest) => {
          await this.rfqs.setInvitationStatus(
            {
              invitationId: invitation.id,
              status: 'declined',
              declineCode: cmd.declineCode,
              declineReason: cmd.reason,
            },
            tx,
          );
          return {
            result: { status: 'declined' },
            audit: [
              {
                action: 'sourcing.rfq_declined',
                subjectType: 'rfq_supplier',
                subjectId: invitation.id,
                reason: cmd.reason,
                data: { rfqId, declineCode: cmd.declineCode },
              },
            ],
            outbox: [
              {
                eventType: 'sourcing.rfq_declined.v1',
                aggregateType: 'rfq',
                aggregateId: rfqId,
                data: { declineCode: cmd.declineCode },
              },
            ],
          };
        },
      },
      contextFromActor({ userId: actor.userId, organizationId }),
      input,
      opts,
    );
  }

  async saveDraft(
    actor: Actor,
    rfqId: string,
    input: SaveBidDraftRequest,
    opts: { idempotencyKey?: string | undefined } = {},
  ): Promise<{ saved: true }> {
    requireTransactionalStrength(actor);
    const { invitation, organizationId, rfq } = await this.ownInvitation(actor, rfqId);
    if (rfq.status !== 'open') throw new BidRejected('This round is not open for bids.');
    if (rfq.pricingMode === 'fixed') throw FIXED_ROUND();

    return this.executor.execute(
      {
        operation: 'sourcing.save-bid-draft',
        handler: async (tx, _ctx, cmd: SaveBidDraftRequest) => {
          const bid = await this.rfqs.ensureBid(
            {
              rfqId,
              rfqSupplierId: invitation.id,
              supplierOrganizationId: organizationId,
              createdBy: actor.userId,
            },
            tx,
          );
          await this.rfqs.saveDraft(bid.id, cmd.draft, tx);
          // A draft is working state, not an event: it is audited as one line, not as a
          // commercial act, because nothing has been offered to anybody yet.
          return {
            result: { saved: true as const },
            audit: [
              {
                action: 'sourcing.bid_draft_saved',
                subjectType: 'supplier_bid',
                subjectId: bid.id,
                data: { rfqId },
              },
            ],
          };
        },
      },
      contextFromActor({ userId: actor.userId, organizationId }),
      input,
      opts,
    );
  }

  async submit(
    actor: Actor,
    rfqId: string,
    input: SubmitBidRequest,
    opts: { idempotencyKey?: string | undefined } = {},
  ): Promise<{ bidVersionId: string; versionNo: number; late: boolean; contentHash: string }> {
    requireTransactionalStrength(actor);
    const { invitation, organizationId, rfq } = await this.ownInvitation(actor, rfqId);
    if (rfq.pricingMode === 'fixed') throw FIXED_ROUND();

    if (!['open', 'responses_received'].includes(rfq.status)) {
      throw new BidRejected(`This round is ${rfq.status}; it is not taking bids.`);
    }
    if (invitation.status === 'revoked' || invitation.status === 'declined') {
      throw new BidRejected('This invitation is no longer open to you.');
    }

    const now = new Date();
    // Late-bid policy decides before anything is written: an accepted late bid keeps its
    // receipt time and is flagged, a refused one never becomes a version (doc 19 §4).
    const { late } = lateness({
      deadlineAt: rfq.deadlineAt,
      now,
      policy: rfq.lateBidPolicy,
    });

    const rfqItems = await this.rfqs.listItems(rfqId);
    const validated = validateBid({
      draft: input,
      rfqLines: rfqItems.map((item) => ({
        rfqItemId: item.id,
        lineNo: item.lineNo,
        quantityBreakpoints: item.quantityBreakpoints,
      })),
      rfqCurrency: rfq.currency,
      now,
    });

    return this.executor.execute(
      {
        operation: 'sourcing.submit-bid',
        handler: async (tx, _ctx, cmd: SubmitBidRequest) => {
          const written = await this.appendVersion(tx, { actor, organizationId, invitation, rfqId, rfqItems, cmd, validated, late });
          return { result: written.result, audit: written.audit, outbox: written.outbox };
        },
      },
      contextFromActor({ userId: actor.userId, organizationId }),
      input,
      opts,
    );
  }

  /**
   * `FR-408`: the supplier takes JobWork's fixed-price offer as offered. The acceptance is a
   * bid version at exactly the offered price (the database refuses any other), and the first
   * one ends the offer: the round closes for evaluation and every other open invitation is
   * marked `offer_taken`, in the same transaction. The round row is locked first, so of two
   * suppliers accepting at once exactly one wins and the other gets `OFFER_TAKEN`.
   */
  async acceptOffer(
    actor: Actor,
    rfqId: string,
    input: AcceptOfferRequest,
    opts: { idempotencyKey?: string | undefined } = {},
  ): Promise<{ bidVersionId: string; versionNo: number; late: boolean; contentHash: string }> {
    requireTransactionalStrength(actor);
    const { organizationId, rfq } = await this.ownInvitation(actor, rfqId);
    if (rfq.pricingMode !== 'fixed') throw new OfferRefused('NOT_FIXED_PRICE', 'This round asks for bids; it has no offer to accept.');
    const rfqItems = await this.rfqs.listItems(rfqId);

    return this.executor.execute(
      {
        operation: 'sourcing.accept-offer',
        handler: async (tx, _ctx, cmd: AcceptOfferRequest) => {
          const locked = await this.rfqs.lockRfq(rfqId, tx);
          if (!locked || !['open', 'responses_received'].includes(locked.status)) {
            throw new OfferRefused('OFFER_TAKEN', 'This offer is no longer open: another supplier accepted it, or the round closed.', 409);
          }
          const invitation = (await this.rfqs.findInvitationForOrganization(rfqId, organizationId, tx))!;
          if (!OPEN_INVITATION_STATES.includes(invitation.status)) {
            throw new OfferRefused(invitation.status === 'offer_taken' ? 'OFFER_TAKEN' : 'INVITATION_CLOSED', `Your invitation is ${invitation.status.replace(/_/g, ' ')}.`, 409);
          }
          const now = new Date();
          const { late } = lateness({ deadlineAt: locked.deadlineAt, now, policy: locked.lateBidPolicy });

          // The offer, written as the supplier's bid: one line per item at its first quantity.
          const bid: SubmitBidRequest = {
            currency: locked.currency,
            taxTreatment: 'gst_extra',
            lines: rfqItems.map((item) => ({
              rfqItemId: item.id,
              lineNo: item.lineNo,
              quantity: item.quantityBreakpoints[0]!.quantity,
              unit: item.quantityBreakpoints[0]!.unit,
              unitPriceMinor: item.offeredUnitPriceMinor!,
              setupAmountMinor: 0,
              note: '',
            })),
            nreAmountMinor: 0,
            freightAmountMinor: 0,
            leadTimeDays: cmd.leadTimeDays,
            validityUntil: cmd.validityUntil,
            feasibility: 'feasible',
            assumptions: '',
            exclusions: '',
            paymentTerms: locked.offerPaymentTerms ?? '',
            note: cmd.note,
          };
          const validated = validateBid({
            draft: bid,
            rfqLines: rfqItems.map((item) => ({ rfqItemId: item.id, lineNo: item.lineNo, quantityBreakpoints: item.quantityBreakpoints })),
            rfqCurrency: locked.currency,
            now,
          });
          const written = await this.appendVersion(tx, { actor, organizationId, invitation, rfqId, rfqItems, cmd: bid, validated, late });

          const closed = await this.rfqs.setRfqStatus(
            { rfqId, expectedVersion: locked.aggregateVersion, status: 'evaluation', closed: { by: actor.userId, reason: 'Fixed-price offer accepted' } },
            tx,
          );
          if (!closed) throw new OfferRefused('OFFER_TAKEN', 'This offer is no longer open.', 409);
          const others = (await this.rfqs.listInvitations(rfqId, tx)).filter((i) => i.id !== invitation.id && OPEN_INVITATION_STATES.includes(i.status));
          for (const other of others) await this.rfqs.setInvitationStatus({ invitationId: other.id, status: 'offer_taken' }, tx);

          return {
            result: written.result,
            audit: [
              ...written.audit,
              {
                action: 'sourcing.offer_accepted',
                subjectType: 'rfq',
                subjectId: rfqId,
                data: { supplierOrganizationId: organizationId, bidVersionId: written.result.bidVersionId, closedInvitations: others.length },
              },
            ],
            outbox: [
              ...written.outbox,
              { eventType: 'sourcing.offer_accepted.v1', aggregateType: 'rfq', aggregateId: rfqId, data: { bidVersionId: written.result.bidVersionId } },
            ],
          };
        },
      },
      contextFromActor({ userId: actor.userId, organizationId }),
      input,
      opts,
    );
  }

  /**
   * Writes one submitted bid version and moves the invitation to `responded`, inside the
   * caller's transaction. `submit` and `acceptOffer` share it, so an accepted offer is a bid
   * version like any other (`FR-408`).
   */
  private async appendVersion(
    tx: PoolClient,
    a: {
      actor: Actor;
      organizationId: string;
      invitation: InvitationRow;
      rfqId: string;
      rfqItems: RfqItemRow[];
      cmd: SubmitBidRequest;
      validated: ReturnType<typeof validateBid>;
      late: boolean;
    },
  ): Promise<{ result: { bidVersionId: string; versionNo: number; late: boolean; contentHash: string }; audit: AuditSpec[]; outbox: OutboxSpec[] }> {
    const { actor, organizationId, invitation, rfqId, rfqItems, cmd, validated, late } = a;
    const bid = await this.rfqs.ensureBid(
      {
        rfqId,
        rfqSupplierId: invitation.id,
        supplierOrganizationId: organizationId,
        createdBy: actor.userId,
      },
      tx,
    );
    const previous = await this.rfqs.findLiveVersion(bid.id, tx);
    if (previous && !cmd.revisionReason) {
      throw new BidRejected(
        'A revision has to say what changed and why.',
        'BID_REVISION_REASON_REQUIRED',
      );
    }
    if (previous) {
      assertBidTransition(previous.status, 'superseded');
      await this.rfqs.setVersionStatus(
        {
          versionId: previous.id,
          status: 'superseded',
          reason: cmd.revisionReason ?? 'revised',
        },
        tx,
      );
    }

    const versionNo = (await this.rfqs.countBidVersions(bid.id, tx)) + 1;
    const lineNoByItem = new Map(rfqItems.map((item) => [item.id, item.lineNo]));
    const bidVersionId = await this.rfqs.appendBidVersion(
      {
        supplierBidId: bid.id,
        versionNo,
        currency: cmd.currency,
        taxTreatment: cmd.taxTreatment,
        linesTotalMinor: validated.linesTotalMinor,
        nreAmountMinor: cmd.nreAmountMinor ?? 0,
        freightAmountMinor: cmd.freightAmountMinor ?? 0,
        totalAmountMinor: validated.totalAmountMinor,
        leadTimeDays: cmd.leadTimeDays,
        validityUntil: cmd.validityUntil,
        feasibility: cmd.feasibility,
        assumptions: cmd.assumptions,
        exclusions: cmd.exclusions,
        paymentTerms: cmd.paymentTerms,
        note: cmd.note,
        contentHash: validated.contentHash,
        late,
        submittedBy: actor.userId,
        supersedesVersionId: previous?.id ?? null,
        revisionReason: cmd.revisionReason ?? null,
        lines: cmd.lines.map((line, index) => ({
          rfqItemId: line.rfqItemId,
          lineNo: lineNoByItem.get(line.rfqItemId) ?? index + 1,
          quantity: line.quantity,
          unit: line.unit,
          unitPriceMinor: line.unitPriceMinor,
          setupAmountMinor: line.setupAmountMinor ?? 0,
          leadTimeDays: line.leadTimeDays ?? null,
          note: line.note ?? '',
        })),
      },
      tx,
    );

    if (invitation.status !== 'responded') {
      assertInvitationTransition(invitation.status, 'responded');
      await this.rfqs.setInvitationStatus(
        { invitationId: invitation.id, status: 'responded' },
        tx,
      );
    }

    return {
      result: {
        bidVersionId,
        versionNo,
        late,
        contentHash: validated.contentHash,
      },
      audit: [
        {
          action: 'sourcing.bid_submitted',
          subjectType: 'supplier_bid_version',
          subjectId: bidVersionId,
          subjectVersion: versionNo,
          ...(cmd.revisionReason ? { reason: cmd.revisionReason } : {}),
          data: {
            rfqId,
            supplierOrganizationId: organizationId,
            versionNo,
            late,
            contentHash: validated.contentHash,
            // The amount is internal-audience data; the audit trail is internal.
            totalAmountMinor: validated.totalAmountMinor,
          },
        },
      ],
      outbox: [
        {
          eventType: 'sourcing.bid_submitted.v1',
          aggregateType: 'supplier_bid_version',
          aggregateId: bidVersionId,
          aggregateVersion: versionNo,
          data: { rfqId, versionNo, late },
        },
      ],
    };
  }

  /**
   * Withdrawing takes the live version out of consideration. The version stays exactly
   * as submitted — withdrawal is a disposition, not an erasure, and an evaluation that
   * happened before it still reads correctly.
   */
  async withdraw(
    actor: Actor,
    rfqId: string,
    input: WithdrawBidRequest,
    opts: { idempotencyKey?: string | undefined } = {},
  ): Promise<{ withdrawn: true }> {
    requireTransactionalStrength(actor);
    const { organizationId, invitation } = await this.ownInvitation(actor, rfqId);
    const bid = await this.rfqs.findBid(rfqId, organizationId);
    if (!bid) throw new BidNotFound();
    const live = await this.rfqs.findLiveVersion(bid.id);
    if (!live) throw new BidNotFound();
    assertBidTransition(live.status, 'withdrawn');

    return this.executor.execute(
      {
        operation: 'sourcing.withdraw-bid',
        handler: async (tx, _ctx, cmd: WithdrawBidRequest) => {
          await this.rfqs.setVersionStatus(
            {
              versionId: live.id,
              status: 'withdrawn',
              reason: cmd.reason,
              decidedBy: actor.userId,
            },
            tx,
          );
          return {
            result: { withdrawn: true as const },
            audit: [
              {
                action: 'sourcing.bid_withdrawn',
                subjectType: 'supplier_bid_version',
                subjectId: live.id,
                subjectVersion: live.versionNo,
                reason: cmd.reason,
                data: { rfqId, supplierOrganizationId: organizationId, invitationId: invitation.id },
              },
            ],
          };
        },
      },
      contextFromActor({ userId: actor.userId, organizationId }),
      input,
      opts,
    );
  }

  /** The hash a supplier can recompute for itself, so "immutable" is checkable. */
  static contentHashOf(input: SubmitBidRequest, totalAmountMinor: number): string {
    return hashBid(input, totalAmountMinor);
  }
}
