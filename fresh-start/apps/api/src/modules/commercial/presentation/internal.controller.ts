import { Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  createEvaluationRequestSchema,
  decideApprovalRequestSchema,
  draftQuoteRequestSchema,
  proposeAwardRequestSchema,
  quoteVersionActionRequestSchema,
  replaceQuoteRequestSchema,
  saveCostSheetRequestSchema,
  withdrawQuoteRequestSchema,
  type ApprovalRequest,
  type Award,
  type CostSheet,
  type Evaluation,
  type Quote,
} from '@jobwork/contracts';
import { SCAN_WORKER_PRINCIPAL } from '@jobwork/service-auth';
import { z } from 'zod';
import { type Actor, requireRole } from '../../iam';
import { NotAuthorized } from '../../iam/domain/errors';
import { RfqRepository } from '../../sourcing';
import { RfqNotFound } from '../../sourcing/domain/rfq';
import { DecideApprovalCommand } from '../application/approval.command';
import { AwardNotFound, ProposeAwardCommand } from '../application/award.command';
import { CommercialView } from '../application/commercial-view';
import { CostSheetCommand } from '../application/cost-sheet.command';
import { COMMERCIAL_READ_ROLES, CreateEvaluationCommand } from '../application/evaluate.command';
import { QuoteCommand } from '../application/quote.command';
import { ApprovalNotFound } from '../domain/approval-policy';
import { QuoteNotFound } from '../domain/quote';
import { CommercialRepository } from '../infrastructure/commercial.repository';
import { renderQuoteDocument } from './quote-document';
import { CurrentActor } from '../../../platform/http/actor.decorator';
import { ServiceOnly } from '../../../platform/http/service-principal.guard';
import { parseBody } from '../../../platform/http/validation';
import { RateLimit } from '../../../platform/http/rate-limit/rate-limit.decorator';

function idempotencyKey(request: FastifyRequest): string | undefined {
  const header = request.headers['idempotency-key'];
  return typeof header === 'string' ? header : undefined;
}

function requireReader(actor: Actor): void {
  if (!actor.isInternal) throw new NotAuthorized('JobWork only');
  requireRole(actor, ...COMMERCIAL_READ_ROLES);
}

const approvalListQuerySchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'returned', 'superseded']).optional(),
  kind: z.enum(['award', 'cost_sheet', 'quote', 'allocation', 'change', 'deviation']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

const quoteListQuerySchema = z.object({
  status: z
    .enum(['draft', 'internal_approval', 'approved', 'sent', 'revision_requested', 'accepted', 'rejected', 'expired', 'withdrawn'])
    .optional(),
  enquiryId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

/** Evaluation and award: the sourcing side of the commercial module. */
@Controller()
export class EvaluationAwardController {
  constructor(
    private readonly evaluate: CreateEvaluationCommand,
    private readonly propose: ProposeAwardCommand,
    private readonly repo: CommercialRepository,
    private readonly rfqs: RfqRepository,
    private readonly view: CommercialView,
  ) {}

  @Post('rfqs/:rfqId/evaluations')
  async createEvaluation(
    @CurrentActor() actor: Actor,
    @Param('rfqId') rfqId: string,
    @Req() request: FastifyRequest,
  ): Promise<Evaluation> {
    const body = parseBody(createEvaluationRequestSchema, request.body ?? {});
    return this.evaluate.execute(actor, rfqId, body, { idempotencyKey: idempotencyKey(request) });
  }

  @Get('rfqs/:rfqId/evaluations')
  async listEvaluations(
    @CurrentActor() actor: Actor,
    @Param('rfqId') rfqId: string,
  ): Promise<{ evaluations: Array<{ evaluationId: string; scenarioHash: string; createdAt: string; rowCount: number }>; awards: Award[] }> {
    requireReader(actor);
    const rfq = await this.rfqs.findRfq(rfqId);
    if (!rfq) throw new RfqNotFound();
    const [evaluations, awards] = await Promise.all([
      this.repo.listEvaluationsForRfq(rfqId),
      this.repo.listAwardsForRfq(rfqId),
    ]);
    return {
      evaluations: evaluations.map((e) => ({ evaluationId: e.id, scenarioHash: e.scenarioHash, createdAt: e.createdAt.toISOString(), rowCount: e.rowCount })),
      awards: await Promise.all(awards.map((a) => this.view.award(a))),
    };
  }

  @Get('evaluations/:evaluationId')
  async getEvaluation(@CurrentActor() actor: Actor, @Param('evaluationId') evaluationId: string): Promise<Evaluation> {
    requireReader(actor);
    const record = await this.repo.findEvaluation(evaluationId);
    if (!record) throw new RfqNotFound();
    const rfq = await this.rfqs.findRfq(record.rfqId);
    return this.view.evaluation(record, rfq?.currency ?? 'INR');
  }

  @Post('awards')
  async proposeAward(@CurrentActor() actor: Actor, @Req() request: FastifyRequest): Promise<Award> {
    const body = parseBody(proposeAwardRequestSchema, request.body);
    return this.propose.execute(actor, body, { idempotencyKey: idempotencyKey(request) });
  }

  @Get('awards/:awardId')
  async getAward(@CurrentActor() actor: Actor, @Param('awardId') awardId: string): Promise<Award> {
    requireReader(actor);
    const award = await this.repo.findAward(awardId);
    if (!award) throw new AwardNotFound();
    return this.view.award(award);
  }
}

/** Approval queue and decisions. */
@Controller('approvals')
export class ApprovalsController {
  constructor(
    private readonly decide: DecideApprovalCommand,
    private readonly repo: CommercialRepository,
    private readonly view: CommercialView,
  ) {}

  @Get()
  async list(@CurrentActor() actor: Actor, @Query() query: unknown): Promise<{ approvals: ApprovalRequest[] }> {
    requireReader(actor);
    const { status, kind, limit } = parseBody(approvalListQuerySchema, query);
    const rows = await this.repo.listApprovalRequests({ status, kind }, limit);
    return { approvals: rows.map((row) => this.view.approval(row)) };
  }

  @Get(':approvalRequestId')
  async get(@CurrentActor() actor: Actor, @Param('approvalRequestId') id: string): Promise<ApprovalRequest> {
    requireReader(actor);
    const row = await this.repo.findApprovalRequest(id);
    if (!row) throw new ApprovalNotFound();
    return this.view.approval(row);
  }

  @Post(':approvalRequestId/decide')
  async decideRequest(
    @CurrentActor() actor: Actor,
    @Param('approvalRequestId') id: string,
    @Req() request: FastifyRequest,
  ): Promise<ApprovalRequest> {
    const body = parseBody(decideApprovalRequestSchema, request.body);
    return this.decide.execute(actor, id, body, { idempotencyKey: idempotencyKey(request) });
  }
}

/** Cost sheets: JobWork-only, platform admin excluded by role (BR-AUTH-03). */
@Controller()
export class CostSheetsController {
  constructor(private readonly costSheets: CostSheetCommand) {}

  @Post('awards/:awardId/cost-sheet')
  async save(@CurrentActor() actor: Actor, @Param('awardId') awardId: string, @Req() request: FastifyRequest): Promise<CostSheet> {
    const body = parseBody(saveCostSheetRequestSchema, request.body);
    return this.costSheets.save(actor, awardId, body, { idempotencyKey: idempotencyKey(request) });
  }

  @Get('awards/:awardId/cost-sheet')
  async byAward(@CurrentActor() actor: Actor, @Param('awardId') awardId: string): Promise<{ costSheet: CostSheet | null }> {
    return { costSheet: await this.costSheets.getByAward(actor, awardId) };
  }

  @Get('cost-sheets/:costSheetId')
  async get(@CurrentActor() actor: Actor, @Param('costSheetId') id: string): Promise<CostSheet> {
    return this.costSheets.get(actor, id);
  }

  @Post('cost-sheets/:costSheetId/request-approval')
  async requestApproval(@CurrentActor() actor: Actor, @Param('costSheetId') id: string, @Req() request: FastifyRequest): Promise<CostSheet> {
    return this.costSheets.requestApproval(actor, id, { idempotencyKey: idempotencyKey(request) });
  }
}

/** Internal quote authoring. */
@Controller('quotes')
export class QuotesController {
  constructor(
    private readonly quotes: QuoteCommand,
    private readonly repo: CommercialRepository,
  ) {}

  @Post()
  async draft(@CurrentActor() actor: Actor, @Req() request: FastifyRequest): Promise<Quote> {
    const body = parseBody(draftQuoteRequestSchema, request.body);
    return this.quotes.draft(actor, body, { idempotencyKey: idempotencyKey(request) });
  }

  @Get()
  async list(@CurrentActor() actor: Actor, @Query() query: unknown): Promise<{ quotes: Quote[] }> {
    const { status, enquiryId, limit } = parseBody(quoteListQuerySchema, query);
    return { quotes: await this.quotes.list(actor, { status, enquiryId }, limit) };
  }

  @Get(':quoteId')
  async get(@CurrentActor() actor: Actor, @Param('quoteId') quoteId: string): Promise<Quote> {
    return this.quotes.get(actor, quoteId);
  }

  @Post(':quoteId/request-approval')
  async requestApproval(@CurrentActor() actor: Actor, @Param('quoteId') quoteId: string, @Req() request: FastifyRequest): Promise<Quote> {
    const body = parseBody(quoteVersionActionRequestSchema, request.body);
    return this.quotes.requestApproval(actor, quoteId, body, { idempotencyKey: idempotencyKey(request) });
  }

  @Post(':quoteId/send')
  async send(@CurrentActor() actor: Actor, @Param('quoteId') quoteId: string, @Req() request: FastifyRequest): Promise<Quote> {
    const body = parseBody(quoteVersionActionRequestSchema, request.body);
    return this.quotes.send(actor, quoteId, body, { idempotencyKey: idempotencyKey(request) });
  }

  @Post(':quoteId/replace')
  async replace(@CurrentActor() actor: Actor, @Param('quoteId') quoteId: string, @Req() request: FastifyRequest): Promise<Quote> {
    const body = parseBody(replaceQuoteRequestSchema, request.body);
    return this.quotes.replace(actor, quoteId, body, { idempotencyKey: idempotencyKey(request) });
  }

  @Post(':quoteId/withdraw')
  async withdraw(@CurrentActor() actor: Actor, @Param('quoteId') quoteId: string, @Req() request: FastifyRequest): Promise<Quote> {
    const body = parseBody(withdrawQuoteRequestSchema, request.body);
    return this.quotes.withdraw(actor, quoteId, body, { idempotencyKey: idempotencyKey(request) });
  }

  /** Internal preview of the document for any version. */
  @RateLimit('export')
  @Get(':quoteId/versions/:versionNo/document')
  async document(
    @CurrentActor() actor: Actor,
    @Param('quoteId') quoteId: string,
    @Param('versionNo') versionNo: string,
  ): Promise<{ html: string; contentHash: string }> {
    requireReader(actor);
    const quote = await this.repo.findQuote(quoteId);
    const version = quote?.versions.find((v) => v.versionNo === Number(versionNo));
    if (!quote || !version) throw new QuoteNotFound();
    return { html: renderQuoteDocument(quote, version, quote.customerDisplayName), contentHash: version.contentHash };
  }
}

/** Worker-driven sweeps run as the named service principal, never as a user. */
@ServiceOnly(SCAN_WORKER_PRINCIPAL.name)
@Controller('internal/quotes')
export class InternalQuotesController {
  constructor(private readonly quotes: QuoteCommand) {}

  @Post('expiry-sweep')
  async expirySweep(@CurrentActor() actor: Actor): Promise<{ expired: number }> {
    // The actor decorator maps the verified service principal onto the actor shape;
    // its id is the principal's stable uuid, which audit and idempotency scope by.
    return this.quotes.expireDue({ id: actor.userId });
  }
}
