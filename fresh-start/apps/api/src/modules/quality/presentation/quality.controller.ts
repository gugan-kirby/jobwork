import { Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  approveReworkRequestSchema,
  calibrationDispositionRequestSchema,
  closeNcrRequestSchema,
  containNcrRequestSchema,
  ncrVersionRequestSchema,
  openNcrRequestSchema,
  planReinspectionRequestSchema,
  recordReworkRequestSchema,
  rejectLotRequestSchema,
  respondCorrectiveActionRequestSchema,
  reviewCorrectiveActionRequestSchema,
  verifyCorrectiveActionRequestSchema,
  correctResultRequestSchema,
  createQualityPlanRequestSchema,
  decideInspectionRequestSchema,
  inspectionVersionRequestSchema,
  invalidateInspectionRequestSchema,
  planInspectionRequestSchema,
  qualityPlanVersionRequestSchema,
  recordCalibrationRequestSchema,
  registerInstrumentRequestSchema,
  retireInstrumentRequestSchema,
  saveQualityPlanDraftRequestSchema,
  submitResultsRequestSchema,
  type Inspection,
  type Instrument,
  type Ncr,
  type QualityPlan,
  type QualityTemplate,
  type QualityUnit,
} from '@jobwork/contracts';
import type { Actor } from '../../iam';
import { CurrentActor } from '../../../platform/http/actor.decorator';
import { parseBody } from '../../../platform/http/validation';
import { InspectionCommand } from '../application/inspection.command';
import { InstrumentCommand } from '../application/instrument.command';
import { NcrCommand } from '../application/ncr.command';
import { QualityPlanCommand } from '../application/quality-plan.command';

function idempotencyKey(request: FastifyRequest): string | undefined {
  const header = request.headers['idempotency-key'];
  return typeof header === 'string' ? header : undefined;
}

const opts = (request: FastifyRequest) => ({ idempotencyKey: idempotencyKey(request) });

/** Quality plans (doc 08 §5 `/quality-plans`): JobWork quality writes and approves them. */
@Controller()
export class QualityPlanController {
  constructor(private readonly plans: QualityPlanCommand) {}

  @Get('quality-units')
  units(@CurrentActor() actor: Actor): Promise<QualityUnit[]> {
    return this.plans.units(actor);
  }

  @Get('quality-templates')
  templates(@CurrentActor() actor: Actor): Promise<QualityTemplate[]> {
    return this.plans.templates(actor);
  }

  @Get('quality-plans')
  list(@CurrentActor() actor: Actor, @Query('workPackageId') workPackageId: string): Promise<QualityPlan[]> {
    return this.plans.forWorkPackage(actor, workPackageId);
  }

  @Post('quality-plans')
  create(@CurrentActor() actor: Actor, @Req() request: FastifyRequest): Promise<QualityPlan> {
    return this.plans.create(actor, parseBody(createQualityPlanRequestSchema, request.body), opts(request));
  }

  @Get('quality-plans/:planId')
  get(@CurrentActor() actor: Actor, @Param('planId') planId: string): Promise<QualityPlan> {
    return this.plans.get(actor, planId);
  }

  @Post('quality-plans/:planId/draft')
  saveDraft(@CurrentActor() actor: Actor, @Param('planId') planId: string, @Req() request: FastifyRequest): Promise<QualityPlan> {
    return this.plans.saveDraft(actor, planId, parseBody(saveQualityPlanDraftRequestSchema, request.body), opts(request));
  }

  @Post('quality-plans/:planId/approve')
  approve(@CurrentActor() actor: Actor, @Param('planId') planId: string, @Req() request: FastifyRequest): Promise<QualityPlan> {
    return this.plans.approve(actor, planId, parseBody(qualityPlanVersionRequestSchema, request.body), opts(request));
  }

  @Post('quality-plans/:planId/revise')
  revise(@CurrentActor() actor: Actor, @Param('planId') planId: string, @Req() request: FastifyRequest): Promise<QualityPlan> {
    return this.plans.revise(actor, planId, parseBody(qualityPlanVersionRequestSchema, request.body), opts(request));
  }
}

/** JobWork's inspection desk (doc 08 §5 `/inspections`; doc 06 §10). */
@Controller('inspections')
export class InspectionController {
  constructor(private readonly inspections: InspectionCommand) {}

  @Get()
  list(@CurrentActor() actor: Actor, @Query('workPackageId') workPackageId?: string, @Query('awaitingReview') awaitingReview?: string): Promise<Inspection[]> {
    return this.inspections.list(actor, { ...(workPackageId ? { workPackageId } : {}), awaitingReview: awaitingReview === 'true' });
  }

  @Post()
  plan(@CurrentActor() actor: Actor, @Req() request: FastifyRequest): Promise<Inspection> {
    return this.inspections.plan(actor, parseBody(planInspectionRequestSchema, request.body), opts(request));
  }

  @Get(':inspectionId')
  get(@CurrentActor() actor: Actor, @Param('inspectionId') id: string): Promise<Inspection> {
    return this.inspections.get(actor, id);
  }

  /** JobWork's own stage (jobwork_incoming) is started and recorded here too. */
  @Post(':inspectionId/start')
  start(@CurrentActor() actor: Actor, @Param('inspectionId') id: string, @Req() request: FastifyRequest): Promise<Inspection> {
    return this.inspections.start(actor, id, parseBody(inspectionVersionRequestSchema, request.body), opts(request));
  }

  @Post(':inspectionId/results')
  results(@CurrentActor() actor: Actor, @Param('inspectionId') id: string, @Req() request: FastifyRequest): Promise<Inspection> {
    return this.inspections.submitResults(actor, id, parseBody(submitResultsRequestSchema, request.body), opts(request));
  }

  @Post(':inspectionId/corrections')
  correct(@CurrentActor() actor: Actor, @Param('inspectionId') id: string, @Req() request: FastifyRequest): Promise<Inspection> {
    return this.inspections.correctResult(actor, id, parseBody(correctResultRequestSchema, request.body), opts(request));
  }

  @Post(':inspectionId/review')
  review(@CurrentActor() actor: Actor, @Param('inspectionId') id: string, @Req() request: FastifyRequest): Promise<Inspection> {
    return this.inspections.startReview(actor, id, parseBody(inspectionVersionRequestSchema, request.body), opts(request));
  }

  @Post(':inspectionId/dispositions')
  disposition(@CurrentActor() actor: Actor, @Param('inspectionId') id: string, @Req() request: FastifyRequest): Promise<Inspection> {
    return this.inspections.dispositionCalibration(actor, id, parseBody(calibrationDispositionRequestSchema, request.body), opts(request));
  }

  @Post(':inspectionId/decide')
  decide(@CurrentActor() actor: Actor, @Param('inspectionId') id: string, @Req() request: FastifyRequest): Promise<Inspection> {
    return this.inspections.decide(actor, id, parseBody(decideInspectionRequestSchema, request.body), opts(request));
  }

  @Post(':inspectionId/invalidate')
  invalidate(@CurrentActor() actor: Actor, @Param('inspectionId') id: string, @Req() request: FastifyRequest): Promise<Inspection> {
    return this.inspections.invalidate(actor, id, parseBody(invalidateInspectionRequestSchema, request.body), opts(request));
  }
}

/** The supplier's side: only inspections it carries out, and only results it records. */
@Controller('supplier/inspections')
export class SupplierInspectionController {
  constructor(private readonly inspections: InspectionCommand) {}

  @Get()
  list(@CurrentActor() actor: Actor, @Query('workPackageId') workPackageId?: string): Promise<Inspection[]> {
    return this.inspections.list(actor, workPackageId ? { workPackageId } : {});
  }

  @Get(':inspectionId')
  get(@CurrentActor() actor: Actor, @Param('inspectionId') id: string): Promise<Inspection> {
    return this.inspections.get(actor, id);
  }

  @Post(':inspectionId/start')
  start(@CurrentActor() actor: Actor, @Param('inspectionId') id: string, @Req() request: FastifyRequest): Promise<Inspection> {
    return this.inspections.start(actor, id, parseBody(inspectionVersionRequestSchema, request.body), opts(request));
  }

  @Post(':inspectionId/results')
  results(@CurrentActor() actor: Actor, @Param('inspectionId') id: string, @Req() request: FastifyRequest): Promise<Inspection> {
    return this.inspections.submitResults(actor, id, parseBody(submitResultsRequestSchema, request.body), opts(request));
  }

  @Post(':inspectionId/corrections')
  correct(@CurrentActor() actor: Actor, @Param('inspectionId') id: string, @Req() request: FastifyRequest): Promise<Inspection> {
    return this.inspections.correctResult(actor, id, parseBody(correctResultRequestSchema, request.body), opts(request));
  }
}

/** Measuring equipment: JobWork's at `/instruments` (and every supplier's, read-only), a supplier's own at `/supplier/instruments`. */
@Controller()
export class InstrumentController {
  constructor(private readonly instruments: InstrumentCommand) {}

  @Get(['instruments', 'supplier/instruments'])
  list(@CurrentActor() actor: Actor): Promise<Instrument[]> {
    return this.instruments.list(actor);
  }

  @Post(['instruments', 'supplier/instruments'])
  register(@CurrentActor() actor: Actor, @Req() request: FastifyRequest): Promise<Instrument> {
    return this.instruments.register(actor, parseBody(registerInstrumentRequestSchema, request.body), opts(request));
  }

  @Get(['instruments/:instrumentId', 'supplier/instruments/:instrumentId'])
  get(@CurrentActor() actor: Actor, @Param('instrumentId') id: string): Promise<Instrument> {
    return this.instruments.get(actor, id);
  }

  @Post(['instruments/:instrumentId/calibrations', 'supplier/instruments/:instrumentId/calibrations'])
  calibrate(@CurrentActor() actor: Actor, @Param('instrumentId') id: string, @Req() request: FastifyRequest): Promise<Instrument> {
    return this.instruments.recordCalibration(actor, id, parseBody(recordCalibrationRequestSchema, request.body), opts(request));
  }

  @Post(['instruments/:instrumentId/retire', 'supplier/instruments/:instrumentId/retire'])
  retire(@CurrentActor() actor: Actor, @Param('instrumentId') id: string, @Req() request: FastifyRequest): Promise<Instrument> {
    return this.instruments.retire(actor, id, parseBody(retireInstrumentRequestSchema, request.body), opts(request));
  }
}

/** JobWork's NCR desk (doc 08 §5 `/ncrs`; doc 06 §10). */
@Controller('ncrs')
export class NcrController {
  constructor(private readonly ncrs: NcrCommand) {}

  @Get()
  list(@CurrentActor() actor: Actor, @Query('workPackageId') workPackageId?: string, @Query('open') open?: string): Promise<Ncr[]> {
    return this.ncrs.list(actor, { ...(workPackageId ? { workPackageId } : {}), open: open === 'true' });
  }

  @Post()
  open(@CurrentActor() actor: Actor, @Req() request: FastifyRequest): Promise<Ncr> {
    return this.ncrs.open(actor, parseBody(openNcrRequestSchema, request.body), opts(request));
  }

  @Get(':ncrId')
  get(@CurrentActor() actor: Actor, @Param('ncrId') id: string): Promise<Ncr> {
    return this.ncrs.get(actor, id);
  }

  @Post(':ncrId/containment')
  contain(@CurrentActor() actor: Actor, @Param('ncrId') id: string, @Req() request: FastifyRequest): Promise<Ncr> {
    return this.ncrs.contain(actor, id, parseBody(containNcrRequestSchema, request.body), opts(request));
  }

  @Post(':ncrId/to-disposition')
  toDisposition(@CurrentActor() actor: Actor, @Param('ncrId') id: string, @Req() request: FastifyRequest): Promise<Ncr> {
    return this.ncrs.toDisposition(actor, id, parseBody(ncrVersionRequestSchema, request.body), opts(request));
  }

  @Post(':ncrId/approve-rework')
  approveRework(@CurrentActor() actor: Actor, @Param('ncrId') id: string, @Req() request: FastifyRequest): Promise<Ncr> {
    return this.ncrs.approveRework(actor, id, parseBody(approveReworkRequestSchema, request.body), opts(request));
  }

  @Post(':ncrId/reinspection')
  reinspect(@CurrentActor() actor: Actor, @Param('ncrId') id: string, @Req() request: FastifyRequest): Promise<Ncr> {
    return this.ncrs.planReinspection(actor, id, parseBody(planReinspectionRequestSchema, request.body), opts(request));
  }

  @Post(':ncrId/reject')
  reject(@CurrentActor() actor: Actor, @Param('ncrId') id: string, @Req() request: FastifyRequest): Promise<Ncr> {
    return this.ncrs.rejectLot(actor, id, parseBody(rejectLotRequestSchema, request.body), opts(request));
  }

  @Post(':ncrId/close')
  close(@CurrentActor() actor: Actor, @Param('ncrId') id: string, @Req() request: FastifyRequest): Promise<Ncr> {
    return this.ncrs.close(actor, id, parseBody(closeNcrRequestSchema, request.body), opts(request));
  }

  @Post(':ncrId/corrective-action/review')
  reviewCa(@CurrentActor() actor: Actor, @Param('ncrId') id: string, @Req() request: FastifyRequest): Promise<Ncr> {
    return this.ncrs.reviewCorrectiveAction(actor, id, parseBody(reviewCorrectiveActionRequestSchema, request.body), opts(request));
  }

  @Post(':ncrId/corrective-action/verify')
  verifyCa(@CurrentActor() actor: Actor, @Param('ncrId') id: string, @Req() request: FastifyRequest): Promise<Ncr> {
    return this.ncrs.verifyCorrectiveAction(actor, id, parseBody(verifyCorrectiveActionRequestSchema, request.body), opts(request));
  }
}

/** The supplier's side of its own NCRs: containment, the rework record, the corrective action. */
@Controller('supplier/ncrs')
export class SupplierNcrController {
  constructor(private readonly ncrs: NcrCommand) {}

  @Get()
  list(@CurrentActor() actor: Actor): Promise<Ncr[]> {
    return this.ncrs.list(actor, {});
  }

  @Get(':ncrId')
  get(@CurrentActor() actor: Actor, @Param('ncrId') id: string): Promise<Ncr> {
    return this.ncrs.get(actor, id);
  }

  @Post(':ncrId/containment')
  contain(@CurrentActor() actor: Actor, @Param('ncrId') id: string, @Req() request: FastifyRequest): Promise<Ncr> {
    return this.ncrs.contain(actor, id, parseBody(containNcrRequestSchema, request.body), opts(request));
  }

  @Post(':ncrId/rework')
  rework(@CurrentActor() actor: Actor, @Param('ncrId') id: string, @Req() request: FastifyRequest): Promise<Ncr> {
    return this.ncrs.recordRework(actor, id, parseBody(recordReworkRequestSchema, request.body), opts(request));
  }

  @Post(':ncrId/corrective-action')
  respond(@CurrentActor() actor: Actor, @Param('ncrId') id: string, @Req() request: FastifyRequest): Promise<Ncr> {
    return this.ncrs.respondCorrectiveAction(actor, id, parseBody(respondCorrectiveActionRequestSchema, request.body), opts(request));
  }
}
