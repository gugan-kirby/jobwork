import { Controller, Get, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  acknowledgeRfqRequestSchema,
  declineRfqRequestSchema,
  saveBidDraftRequestSchema,
  submitBidRequestSchema,
  withdrawBidRequestSchema,
  type SupplierRfq,
  type SupplierRfqListItem,
} from '@jobwork/contracts';
import type { Actor } from '../../iam';
import { requireOrganization } from '../../iam';
import { NotAuthorized } from '../../iam/domain/errors';
import { BidCommand } from '../application/bid.command';
import { RfqView } from '../application/rfq-view';
import { RfqNotFound } from '../domain/rfq';
import { RfqRepository } from '../infrastructure/rfq.repository';
import { CurrentActor } from '../../../platform/http/actor.decorator';
import { parseBody } from '../../../platform/http/validation';

function idempotencyKey(request: FastifyRequest): string | undefined {
  const header = request.headers['idempotency-key'];
  return typeof header === 'string' ? header : undefined;
}

/**
 * The supplier's RFQ workspace (doc 14 §5, UC-12/13).
 *
 * Every route resolves the round through the caller's own invitation. A round a supplier
 * was not invited to answers 404 rather than 403: "forbidden" would confirm the round
 * exists, and enumeration is itself a leak (doc 03 §7).
 */
@Controller('supplier/rfqs')
export class SupplierRfqsController {
  constructor(
    private readonly bids: BidCommand,
    private readonly view: RfqView,
    private readonly repo: RfqRepository,
  ) {}

  private supplierOrganization(actor: Actor): string {
    const organizationId = requireOrganization(actor);
    if (actor.organizationType !== 'supplier') {
      throw new NotAuthorized('Only a supplier organization has RFQs');
    }
    return organizationId;
  }

  @Get()
  async list(@CurrentActor() actor: Actor): Promise<{ rfqs: SupplierRfqListItem[] }> {
    const organizationId = this.supplierOrganization(actor);
    return { rfqs: await this.view.supplierList(organizationId) };
  }

  @Get(':rfqId')
  async detail(
    @CurrentActor() actor: Actor,
    @Param('rfqId') rfqId: string,
  ): Promise<SupplierRfq> {
    const organizationId = this.supplierOrganization(actor);
    const row = await this.repo.findRfq(rfqId);
    if (!row) throw new RfqNotFound();
    const view = await this.view.supplierView(row, organizationId);
    if (!view) throw new RfqNotFound();
    return view;
  }

  @Post(':rfqId/acknowledge')
  async acknowledge(
    @CurrentActor() actor: Actor,
    @Param('rfqId') rfqId: string,
    @Req() request: FastifyRequest,
  ): Promise<{ status: string }> {
    const body = parseBody(acknowledgeRfqRequestSchema, request.body ?? {});
    return this.bids.acknowledge(actor, rfqId, body, { idempotencyKey: idempotencyKey(request) });
  }

  @Post(':rfqId/decline')
  async decline(
    @CurrentActor() actor: Actor,
    @Param('rfqId') rfqId: string,
    @Req() request: FastifyRequest,
  ): Promise<{ status: string }> {
    const body = parseBody(declineRfqRequestSchema, request.body);
    return this.bids.decline(actor, rfqId, body, { idempotencyKey: idempotencyKey(request) });
  }

  @Post(':rfqId/bid/draft')
  async saveDraft(
    @CurrentActor() actor: Actor,
    @Param('rfqId') rfqId: string,
    @Req() request: FastifyRequest,
  ): Promise<{ saved: true }> {
    const body = parseBody(saveBidDraftRequestSchema, request.body);
    return this.bids.saveDraft(actor, rfqId, body, { idempotencyKey: idempotencyKey(request) });
  }

  @Post(':rfqId/bid/submit')
  async submit(
    @CurrentActor() actor: Actor,
    @Param('rfqId') rfqId: string,
    @Req() request: FastifyRequest,
  ): Promise<{ bidVersionId: string; versionNo: number; late: boolean; contentHash: string }> {
    const body = parseBody(submitBidRequestSchema, request.body);
    return this.bids.submit(actor, rfqId, body, { idempotencyKey: idempotencyKey(request) });
  }

  @Post(':rfqId/bid/withdraw')
  async withdraw(
    @CurrentActor() actor: Actor,
    @Param('rfqId') rfqId: string,
    @Req() request: FastifyRequest,
  ): Promise<{ withdrawn: true }> {
    const body = parseBody(withdrawBidRequestSchema, request.body);
    return this.bids.withdraw(actor, rfqId, body, { idempotencyKey: idempotencyKey(request) });
  }
}
