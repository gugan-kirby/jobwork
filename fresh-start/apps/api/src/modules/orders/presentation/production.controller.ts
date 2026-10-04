import { Controller, Get, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  acknowledgeTransmittalRequestSchema,
  assembleBaselineRequestSchema,
  baselineVersionRequestSchema,
  issueTransmittalsRequestSchema,
  milestoneVersionRequestSchema,
  planWorkPackageRequestSchema,
  recordContainmentRequestSchema,
  reportDelayRequestSchema,
  submitEvidenceRequestSchema,
  verifyMilestoneRequestSchema,
  waiveMilestoneRequestSchema,
  workPackageVersionRequestSchema,
  type BaselineCandidate,
  type Milestone,
  type ProductionView,
  type SupplierProduction,
  type VerificationQueueItem,
} from '@jobwork/contracts';
import type { Actor } from '../../iam';
import { ProductionCommand } from '../application/production.command';
import { CurrentActor } from '../../../platform/http/actor.decorator';
import { parseBody } from '../../../platform/http/validation';

function idempotencyKey(request: FastifyRequest): string | undefined {
  const header = request.headers['idempotency-key'];
  return typeof header === 'string' ? header : undefined;
}

/** JobWork's production surface (IN-09): baselines, transmittals, planning, release, verification. */
@Controller()
export class ProductionController {
  constructor(private readonly production: ProductionCommand) {}

  @Get('sales-orders/:orderId/production')
  view(@CurrentActor() actor: Actor, @Param('orderId') orderId: string): Promise<ProductionView> {
    return this.production.view(actor, orderId);
  }

  @Get('production/verification-queue')
  async queue(@CurrentActor() actor: Actor): Promise<{ milestones: VerificationQueueItem[] }> {
    return { milestones: await this.production.verificationQueue(actor) };
  }

  @Get('sales-orders/:orderId/baseline-candidates')
  async candidates(@CurrentActor() actor: Actor, @Param('orderId') orderId: string): Promise<{ candidates: BaselineCandidate[] }> {
    return { candidates: await this.production.candidates(actor, orderId) };
  }

  @Post('sales-orders/:orderId/baselines')
  assemble(@CurrentActor() actor: Actor, @Param('orderId') orderId: string, @Req() request: FastifyRequest): Promise<ProductionView> {
    return this.production.assembleBaseline(actor, orderId, parseBody(assembleBaselineRequestSchema, request.body), { idempotencyKey: idempotencyKey(request) });
  }

  @Post('baselines/:baselineId/release')
  release(@CurrentActor() actor: Actor, @Param('baselineId') baselineId: string, @Req() request: FastifyRequest): Promise<ProductionView> {
    return this.production.releaseBaseline(actor, baselineId, parseBody(baselineVersionRequestSchema, request.body), { idempotencyKey: idempotencyKey(request) });
  }

  @Post('sales-orders/:orderId/transmittals')
  transmit(@CurrentActor() actor: Actor, @Param('orderId') orderId: string, @Req() request: FastifyRequest): Promise<ProductionView> {
    return this.production.issueTransmittals(actor, orderId, parseBody(issueTransmittalsRequestSchema, request.body), { idempotencyKey: idempotencyKey(request) });
  }

  @Post('purchase-orders/:purchaseOrderId/work-package')
  plan(@CurrentActor() actor: Actor, @Param('purchaseOrderId') purchaseOrderId: string, @Req() request: FastifyRequest): Promise<ProductionView> {
    return this.production.planWorkPackage(actor, purchaseOrderId, parseBody(planWorkPackageRequestSchema, request.body), { idempotencyKey: idempotencyKey(request) });
  }

  @Post('purchase-orders/:purchaseOrderId/containment')
  containment(@CurrentActor() actor: Actor, @Param('purchaseOrderId') purchaseOrderId: string, @Req() request: FastifyRequest): Promise<ProductionView> {
    return this.production.recordContainment(actor, purchaseOrderId, parseBody(recordContainmentRequestSchema, request.body), { idempotencyKey: idempotencyKey(request) });
  }

  @Post('work-packages/:workPackageId/release')
  releaseWorkPackage(@CurrentActor() actor: Actor, @Param('workPackageId') workPackageId: string, @Req() request: FastifyRequest): Promise<ProductionView> {
    return this.production.releaseWorkPackage(actor, workPackageId, parseBody(workPackageVersionRequestSchema, request.body), { idempotencyKey: idempotencyKey(request) });
  }

  @Post('milestones/:milestoneId/verify')
  verify(@CurrentActor() actor: Actor, @Param('milestoneId') milestoneId: string, @Req() request: FastifyRequest): Promise<ProductionView> {
    return this.production.verifyMilestone(actor, milestoneId, parseBody(verifyMilestoneRequestSchema, request.body), { idempotencyKey: idempotencyKey(request) });
  }

  @Post('milestones/:milestoneId/waive')
  waive(@CurrentActor() actor: Actor, @Param('milestoneId') milestoneId: string, @Req() request: FastifyRequest): Promise<ProductionView> {
    return this.production.waiveMilestone(actor, milestoneId, parseBody(waiveMilestoneRequestSchema, request.body), { idempotencyKey: idempotencyKey(request) });
  }

  /** Shared by JobWork and the supplier; the command decides which rules apply. */
  @Post('milestones/:milestoneId/delay')
  delay(@CurrentActor() actor: Actor, @Param('milestoneId') milestoneId: string, @Req() request: FastifyRequest): Promise<Milestone> {
    return this.production.reportDelay(actor, milestoneId, parseBody(reportDelayRequestSchema, request.body), { idempotencyKey: idempotencyKey(request) });
  }
}

/** The supplier's production surface: the transmitted baseline, acknowledgment, milestones, evidence. */
@Controller('supplier')
export class SupplierProductionController {
  constructor(private readonly production: ProductionCommand) {}

  @Get('purchase-orders/:purchaseOrderId/production')
  view(@CurrentActor() actor: Actor, @Param('purchaseOrderId') purchaseOrderId: string): Promise<SupplierProduction> {
    return this.production.supplierProduction(actor, purchaseOrderId);
  }

  @Post('transmittals/:transmittalId/acknowledge')
  acknowledge(@CurrentActor() actor: Actor, @Param('transmittalId') transmittalId: string, @Req() request: FastifyRequest): Promise<SupplierProduction> {
    return this.production.acknowledgeTransmittal(actor, transmittalId, parseBody(acknowledgeTransmittalRequestSchema, request.body), { idempotencyKey: idempotencyKey(request) });
  }

  @Post('milestones/:milestoneId/start')
  start(@CurrentActor() actor: Actor, @Param('milestoneId') milestoneId: string, @Req() request: FastifyRequest): Promise<SupplierProduction> {
    return this.production.startMilestone(actor, milestoneId, parseBody(milestoneVersionRequestSchema, request.body), { idempotencyKey: idempotencyKey(request) });
  }

  @Post('milestones/:milestoneId/evidence')
  evidence(@CurrentActor() actor: Actor, @Param('milestoneId') milestoneId: string, @Req() request: FastifyRequest): Promise<SupplierProduction> {
    return this.production.submitEvidence(actor, milestoneId, parseBody(submitEvidenceRequestSchema, request.body), { idempotencyKey: idempotencyKey(request) });
  }
}
