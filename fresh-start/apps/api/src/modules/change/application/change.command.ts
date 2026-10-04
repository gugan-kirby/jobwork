import { createHash } from 'node:crypto';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type {
  ChangeRequest,
  ChangeVersionRequest,
  ClassifyChange,
  CustomerChange,
  CustomerChangeDecision,
  IssueInterimDecision,
  LiftInterimDecision,
  ProposeChangeRequest,
  ProvideChangeInfo,
  RecordImpact,
  RequestChangeInfo,
  SupplierChange,
  SupplierChangeAcknowledge,
  SupplierImpact,
  VerifyChange,
  WithdrawChange,
} from '@jobwork/contracts';
import { ApprovalEffectRegistry, CommercialRepository, type ApprovalEffectInput } from '../../commercial';
import { DocumentRevisionHooks, type DocumentRevisionInput } from '../../dms';
import { type Actor, IamRepository, requireTransactionalStrength } from '../../iam';
import { baselineHash, FinanceRepository, governingConflicts, OrdersRepository, ProductionRepository } from '../../orders';
import { contextFromActor, type AuditSpec, type CommandContext, type OutboxSpec } from '../../../platform/commands/command';
import { CommandExecutor } from '../../../platform/commands/execute';
import { OutboxWriter } from '../../../platform/commands/outbox.writer';
import { DomainError } from '../../../platform/http/domain-error';
import { approverRoles, assertChangeTransition, ChangeNotFound, ChangeRefused, customerApprovalRequired, missingImpactAreas, OPEN_STATUSES } from '../domain/change';
import { ChangeRepository, type ChangeRow, type ImpactRow, type InterimRow, type PoAmendmentRow } from '../infrastructure/change.repository';

type Opts = { idempotencyKey?: string | undefined };

const ENGINEERING = ['jobwork_engineering'];
const INTERNAL_PROPOSERS = ['jobwork_engineering', 'jobwork_sourcing', 'jobwork_sales'];
const INTERIM_ROLES = ['jobwork_engineering', 'jobwork_sourcing'];
const VERIFY_ROLES = ['jobwork_engineering', 'jobwork_quality'];
const INTERNAL_READERS = ['jobwork_engineering', 'jobwork_sourcing', 'jobwork_sales', 'jobwork_quality', 'jobwork_finance', 'platform_admin'];
const MAX_INTERIM_DAYS = 30;
const ACK_DAYS = 3;

const hashOf = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/**
 * Engineering change control (IN-13 F-13.2; doc 06 §9; doc 09 §§7–8). The only path that
 * replaces a released baseline (F-13.1 refuses every other), and the only path from a
 * post-baseline revision to new work: triage, impact, internal approval, the customer's
 * decision where its price, date or scope moves, a superseding baseline with its
 * transmittals and amendments, the suppliers' acknowledgment, verification, closure.
 */
@Injectable()
export class ChangeCommand implements OnModuleInit {
  constructor(
    private readonly repo: ChangeRepository,
    private readonly orders: OrdersRepository,
    private readonly production: ProductionRepository,
    private readonly finance: FinanceRepository,
    private readonly commercial: CommercialRepository,
    private readonly iam: IamRepository,
    private readonly executor: CommandExecutor,
    private readonly outbox: OutboxWriter,
    private readonly effects: ApprovalEffectRegistry,
    private readonly revisions: DocumentRevisionHooks,
  ) {}

  onModuleInit(): void {
    this.effects.register('change', (input, tx) => this.applyApproval(input, tx));
    this.revisions.register((input, tx) => this.openForRevision(input, tx));
  }

  // ----------------------------------------------------------------- access

  private requireInternal(actor: Actor, roles: readonly string[]): void {
    if (!actor.isInternal || !actor.roles.some((r) => roles.includes(r))) {
      throw new DomainError('NOT_AUTHORIZED', 403, 'Not permitted', `Requires one of: ${roles.join(', ')}.`);
    }
    requireTransactionalStrength(actor);
  }

  private customerOrganization(actor: Actor): string {
    if (actor.organizationType !== 'customer' || !actor.organizationId) throw new DomainError('NOT_AUTHORIZED', 403, 'Customers only');
    return actor.organizationId;
  }

  private supplierOrganization(actor: Actor): string {
    if (actor.organizationType !== 'supplier' || !actor.organizationId) throw new DomainError('NOT_AUTHORIZED', 403, 'Suppliers only');
    return actor.organizationId;
  }

  private async locked(changeId: string, expectedVersion: number | null, tx: PoolClient): Promise<ChangeRow> {
    const change = await this.repo.find(changeId, tx, true);
    if (!change) throw new ChangeNotFound();
    if (expectedVersion !== null && change.aggregateVersion !== expectedVersion) {
      throw new DomainError('VERSION_CONFLICT', 409, 'The change moved on', 'Reload it and try again.');
    }
    return change;
  }

  private audit(change: ChangeRow, version: number, action: string, data: Record<string, unknown> = {}, reason?: string): AuditSpec {
    return { action, subjectType: 'change_request', subjectId: change.id, subjectVersion: version, ...(reason ? { reason } : {}), data: { number: change.number, ...data } };
  }

  private event(change: ChangeRow, version: number, type: string, data: Record<string, unknown> = {}): OutboxSpec {
    return {
      eventType: type,
      aggregateType: 'change_request',
      aggregateId: change.id,
      aggregateVersion: version,
      data: { changeRequestId: change.id, number: change.number, salesOrderId: change.salesOrderId, ...data },
    };
  }

  // ----------------------------------------------------------------- proposal and triage

  async propose(actor: Actor, input: ProposeChangeRequest, opts: Opts = {}): Promise<{ changeRequestId: string; number: string }> {
    let origin: 'customer' | 'internal' | 'supplier';
    if (actor.isInternal) {
      this.requireInternal(actor, INTERNAL_PROPOSERS);
      origin = input.origin ?? 'internal';
    } else {
      const organizationId = this.customerOrganization(actor);
      if (!actor.roles.some((r) => r === 'customer_requester' || r === 'customer_approver' || r === 'org_admin')) throw new DomainError('NOT_AUTHORIZED', 403, 'Requires a customer requester or approver');
      const order = await this.orders.findSalesOrder(input.salesOrderId);
      if (!order || order.customerOrganizationId !== organizationId) throw new DomainError('ORDER_NOT_FOUND', 404, 'Order not found');
      origin = 'customer';
    }
    return this.executor.execute(
      {
        operation: 'change.propose',
        handler: async (tx, _ctx, cmd: ProposeChangeRequest) => {
          const order = await this.orders.findSalesOrder(cmd.salesOrderId, tx);
          if (!order) throw new DomainError('ORDER_NOT_FOUND', 404, 'Order not found');
          if (order.status === 'closed' || order.status === 'cancelled') throw new ChangeRefused('ORDER_NOT_OPEN', 'This order is no longer open for change', `It is ${order.status}.`);
          // Context documents become baseline candidates for a drawing pack sent to suppliers: a
          // customer may only point at its own documents; JobWork at documents that exist.
          const owners = await this.repo.versionOwners(cmd.contextDocumentVersionIds, tx);
          const unusable = cmd.contextDocumentVersionIds.filter((id) => {
            const owner = owners.find((o) => o.versionId === id);
            return !owner || (!actor.isInternal && owner.organizationId !== order.customerOrganizationId);
          });
          if (unusable.length > 0) throw new ChangeRefused('CONTEXT_DOCUMENT_UNAVAILABLE', 'A referenced document is not available to this change', `${unusable.length} document version(s) are unknown or not yours.`, 422);
          const number = await this.repo.allocateNumber(new Date(), tx);
          const id = await this.repo.create({ number, salesOrderId: order.id, origin, urgency: cmd.urgency, title: cmd.title, reason: cmd.reason, contextDocumentVersionIds: cmd.contextDocumentVersionIds, proposedBy: actor.userId }, tx);
          const change = (await this.repo.find(id, tx))!;
          return {
            result: { changeRequestId: id, number },
            audit: [this.audit(change, 1, 'change.change_proposed', { origin, urgency: cmd.urgency, salesOrderId: order.id })],
            outbox: [this.event(change, 1, 'change.change_proposed.v1', { origin })],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
  }

  /** A transition owned by engineering, with its fields and its audit, in one place. */
  private async move(
    actor: Actor,
    changeId: string,
    operation: string,
    input: { expectedVersion: number },
    to: ChangeRow['status'],
    build: (change: ChangeRow, tx: PoolClient) => Promise<{ fields?: Parameters<ChangeRepository['update']>[1]; action: string; data?: Record<string, unknown>; reason?: string; eventType?: string }>,
    opts: Opts,
    view = true,
  ): Promise<ChangeRequest> {
    await this.executor.execute(
      {
        operation,
        handler: async (tx, _ctx, cmd: { expectedVersion: number }) => {
          const change = await this.locked(changeId, cmd.expectedVersion, tx);
          assertChangeTransition(change.status, to);
          const plan = await build(change, tx);
          const version = await this.repo.update(change.id, { ...plan.fields, status: to }, tx);
          return {
            result: undefined,
            audit: [this.audit(change, version, plan.action, { from: change.status, to, ...plan.data }, plan.reason)],
            outbox: plan.eventType ? [this.event(change, version, plan.eventType, { status: to })] : [],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return view ? this.get(actor, changeId) : (null as never);
  }

  async startTriage(actor: Actor, changeId: string, input: ChangeVersionRequest, opts: Opts = {}): Promise<ChangeRequest> {
    this.requireInternal(actor, ENGINEERING);
    return this.move(actor, changeId, 'change.start-triage', input, 'triage', async () => ({ action: 'change.triage_started' }), opts);
  }

  async requestInfo(actor: Actor, changeId: string, input: RequestChangeInfo, opts: Opts = {}): Promise<ChangeRequest> {
    this.requireInternal(actor, ENGINEERING);
    return this.move(actor, changeId, 'change.request-info', input, 'clarification', async () => ({ fields: { infoRequest: input.question, infoResponse: null }, action: 'change.info_requested', data: { question: input.question } }), opts);
  }

  /** The proposer's side answers: the customer for its own proposal, or JobWork. */
  async provideInfo(actor: Actor, changeId: string, input: ProvideChangeInfo, opts: Opts = {}): Promise<void> {
    if (actor.isInternal) {
      this.requireInternal(actor, INTERNAL_PROPOSERS);
    } else {
      const organizationId = this.customerOrganization(actor);
      const change = await this.repo.find(changeId);
      if (!change || change.customerOrganizationId !== organizationId) throw new ChangeNotFound();
    }
    await this.move(actor, changeId, 'change.provide-info', input, 'triage', async () => ({ fields: { infoResponse: input.answer }, action: 'change.info_provided' }), opts, false);
  }

  /** Clarification closes here with its answer; a correction or scope change goes to impact. */
  async classify(actor: Actor, changeId: string, input: ClassifyChange, opts: Opts = {}): Promise<ChangeRequest> {
    this.requireInternal(actor, ENGINEERING);
    const to = input.classification === 'clarification' ? 'closed' : 'impact_analysis';
    if (to === 'closed' && input.note.length < 3) throw new DomainError('VALIDATION_FAILED', 400, 'Request validation failed', undefined, [{ path: 'note', message: 'Say what the clarification settled' }]);
    return this.move(
      actor,
      changeId,
      'change.classify',
      input,
      to,
      async () => ({
        fields: { classification: input.classification, supplierBrief: input.supplierBrief, ...(to === 'closed' ? { outcomeNote: input.note, closedAt: new Date() } : {}) },
        action: 'change.change_classified',
        data: { classification: input.classification },
        ...(to === 'closed' ? { eventType: 'change.change_closed.v1' } : {}),
      }),
      opts,
    );
  }

  async withdraw(actor: Actor, changeId: string, input: WithdrawChange, opts: Opts = {}): Promise<void> {
    if (actor.isInternal) {
      this.requireInternal(actor, ENGINEERING);
    } else {
      const organizationId = this.customerOrganization(actor);
      const change = await this.repo.find(changeId);
      if (!change || change.customerOrganizationId !== organizationId || change.origin !== 'customer') throw new ChangeNotFound();
    }
    await this.move(
      actor,
      changeId,
      'change.withdraw',
      input,
      'withdrawn',
      async (change, tx) => {
        await this.repo.liftAllForChange({ changeId: change.id, by: actor.userId, reason: 'Change withdrawn' }, tx);
        return {
          fields: { outcomeNote: input.reason, closedAt: new Date() },
          action: 'change.change_withdrawn',
          reason: input.reason,
          eventType: 'change.change_closed.v1',
        };
      },
      opts,
      false,
    );
  }

  // ----------------------------------------------------------------- interim decisions

  async issueInterim(actor: Actor, changeId: string, input: IssueInterimDecision, opts: Opts = {}): Promise<ChangeRequest> {
    this.requireInternal(actor, INTERIM_ROLES);
    const expiresAt = new Date(input.expiresAt);
    if (expiresAt.getTime() <= Date.now() || expiresAt.getTime() > Date.now() + MAX_INTERIM_DAYS * 86_400_000) {
      throw new DomainError('VALIDATION_FAILED', 400, 'Request validation failed', undefined, [{ path: 'expiresAt', message: `Between now and ${MAX_INTERIM_DAYS} days ahead` }]);
    }
    await this.executor.execute(
      {
        operation: 'change.issue-interim-decision',
        handler: async (tx, _ctx, cmd: IssueInterimDecision) => {
          const change = await this.locked(changeId, null, tx);
          if (!OPEN_STATUSES.includes(change.status)) throw new ChangeRefused('CHANGE_NOT_OPEN', 'Interim decisions belong to an open change', `This change is ${change.status}.`);
          const pos = new Map((await this.orders.listPurchaseOrdersForSalesOrder(change.salesOrderId, tx)).filter((p) => p.status !== 'cancelled').map((p) => [p.id, p]));
          const audit: AuditSpec[] = [];
          const outbox: OutboxSpec[] = [];
          for (const purchaseOrderId of new Set(cmd.purchaseOrderIds)) {
            const po = pos.get(purchaseOrderId);
            if (!po) throw new ChangeRefused('PURCHASE_ORDER_NOT_IN_ORDER', 'That purchase order is not part of this order', undefined, 422);
            const id = await this.repo.insertInterim({ changeId: change.id, purchaseOrderId, decision: cmd.decision, reason: cmd.reason, expiresAt, issuedBy: actor.userId }, tx);
            audit.push(this.audit(change, change.aggregateVersion, 'change.interim_decision_issued', { interimDecisionId: id, purchaseOrderId, decision: cmd.decision, expiresAt: expiresAt.toISOString() }, cmd.reason));
            outbox.push({
              eventType: 'change.interim_decision_issued.v1',
              aggregateType: 'change_request',
              aggregateId: change.id,
              data: { interimDecisionId: id, purchaseOrderId, purchaseOrderNumber: po.number, supplierOrganizationId: po.supplierOrganizationId, decision: cmd.decision },
            });
          }
          return { result: undefined, audit, outbox };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.get(actor, changeId);
  }

  async liftInterim(actor: Actor, changeId: string, interimId: string, input: LiftInterimDecision, opts: Opts = {}): Promise<ChangeRequest> {
    this.requireInternal(actor, INTERIM_ROLES);
    await this.executor.execute(
      {
        operation: 'change.lift-interim-decision',
        handler: async (tx, _ctx, cmd: LiftInterimDecision) => {
          const change = await this.locked(changeId, null, tx);
          const decision = (await this.repo.interimDecisions(change.id, tx)).find((d) => d.id === interimId);
          if (!decision) throw new DomainError('INTERIM_DECISION_NOT_FOUND', 404, 'Interim decision not found');
          if (!(await this.repo.liftInterim({ id: interimId, by: actor.userId, reason: cmd.reason }, tx))) throw new ChangeRefused('INTERIM_DECISION_LIFTED', 'Already lifted');
          return { result: undefined, audit: [this.audit(change, change.aggregateVersion, 'change.interim_decision_lifted', { interimDecisionId: interimId, purchaseOrderId: decision.purchaseOrderId }, cmd.reason)] };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.get(actor, changeId);
  }

  // ----------------------------------------------------------------- impact

  async recordImpact(actor: Actor, changeId: string, input: RecordImpact, opts: Opts = {}): Promise<ChangeRequest> {
    this.requireInternal(actor, ENGINEERING);
    await this.executor.execute(
      {
        operation: 'change.record-impact',
        handler: async (tx, _ctx, cmd: RecordImpact) => {
          const change = await this.locked(changeId, cmd.expectedVersion, tx);
          if (change.status !== 'impact_analysis') throw new ChangeRefused('CHANGE_NOT_IN_IMPACT', 'Impact is recorded during impact analysis', `This change is ${change.status}.`);
          const pos = new Set((await this.orders.listPurchaseOrdersForSalesOrder(change.salesOrderId, tx)).filter((p) => p.status !== 'cancelled').map((p) => p.id));
          for (const id of [...cmd.purchaseOrders.map((p) => p.purchaseOrderId), ...cmd.wip.map((w) => w.purchaseOrderId)]) {
            if (!pos.has(id)) throw new ChangeRefused('PURCHASE_ORDER_NOT_IN_ORDER', 'A purchase order in the impact is not part of this order', undefined, 422);
          }
          if (cmd.candidateBaselineId) {
            const candidate = await this.production.findBaseline(cmd.candidateBaselineId, tx);
            if (!candidate || candidate.salesOrderId !== change.salesOrderId || candidate.status !== 'draft') {
              throw new ChangeRefused('CANDIDATE_BASELINE_INVALID', 'The candidate must be a draft baseline of this order', undefined, 422);
            }
          }
          const versionNo = await this.repo.insertImpact(
            { changeId: change.id, areas: cmd.areas, customerPriceDeltaMinor: cmd.customerPriceDeltaMinor, deliveryDateDeltaDays: cmd.deliveryDateDeltaDays, purchaseOrders: cmd.purchaseOrders, wip: cmd.wip, recordedBy: actor.userId },
            tx,
          );
          const version = await this.repo.update(change.id, { candidateBaselineId: cmd.candidateBaselineId ?? change.candidateBaselineId }, tx);
          return {
            result: undefined,
            audit: [this.audit(change, version, 'change.impact_recorded', { impactVersion: versionNo, missingAreas: missingImpactAreas(cmd.areas), customerPriceDeltaMinor: cmd.customerPriceDeltaMinor, deliveryDateDeltaDays: cmd.deliveryDateDeltaDays })],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.get(actor, changeId);
  }

  /** A supplier's own estimate for its purchase order; engineering decides what enters the impact. */
  async submitSupplierImpact(actor: Actor, changeId: string, input: SupplierImpact, opts: Opts = {}): Promise<SupplierChange> {
    const organizationId = this.supplierOrganization(actor);
    await this.executor.execute(
      {
        operation: 'change.submit-supplier-impact',
        handler: async (tx, _ctx, cmd: SupplierImpact) => {
          const change = await this.locked(changeId, null, tx);
          const po = await this.orders.findPurchaseOrder(cmd.purchaseOrderId, tx);
          if (!po || po.supplierOrganizationId !== organizationId || po.salesOrderId !== change.salesOrderId) throw new ChangeNotFound();
          if (change.status !== 'impact_analysis') throw new ChangeRefused('CHANGE_NOT_IN_IMPACT', 'JobWork is not collecting impact for this change now', `It is ${change.status}.`);
          await this.repo.insertSupplierImpact({ changeId: change.id, purchaseOrderId: po.id, supplierOrganizationId: organizationId, costDeltaMinor: cmd.costDeltaMinor, leadTimeDeltaDays: cmd.leadTimeDeltaDays, wip: cmd.wip, note: cmd.note, submittedBy: actor.userId }, tx);
          return { result: undefined, audit: [this.audit(change, change.aggregateVersion, 'change.supplier_impact_submitted', { purchaseOrderId: po.id, costDeltaMinor: cmd.costDeltaMinor, leadTimeDeltaDays: cmd.leadTimeDeltaDays })] };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.supplierGet(actor, changeId);
  }

  /** Every area answered, a candidate baseline, then the approval rail (policy `change`). */
  async completeImpact(actor: Actor, changeId: string, input: ChangeVersionRequest, opts: Opts = {}): Promise<ChangeRequest> {
    this.requireInternal(actor, ENGINEERING);
    const policy = await this.commercial.activePolicy('change');
    if (!policy) throw new DomainError('POLICY_RULES_INVALID', 500, 'No active change approval policy');
    await this.executor.execute(
      {
        operation: 'change.complete-impact',
        handler: async (tx, _ctx, cmd: ChangeVersionRequest) => {
          const change = await this.locked(changeId, cmd.expectedVersion, tx);
          assertChangeTransition(change.status, 'commercial_approval');
          const impact = await this.repo.latestImpact(change.id, tx);
          const missing = missingImpactAreas(impact?.areas ?? null);
          if (!impact || missing.length > 0) throw new ChangeRefused('IMPACT_INCOMPLETE', 'Every impact area needs an answer or a reason it does not apply', `Missing: ${missing.join(', ')}.`, 422);
          if (!change.candidateBaselineId) throw new ChangeRefused('CANDIDATE_BASELINE_MISSING', 'Name the draft baseline this change will release', undefined, 422);
          const required = customerApprovalRequired(change.classification!, impact);
          const roles = approverRoles(policy.rules as Record<string, unknown>, impact);
          const requestId = await this.commercial.createApprovalRequest(
            {
              kind: 'change',
              subjectType: 'change_request',
              subjectId: change.id,
              subjectVersionNo: impact.versionNo,
              subjectHash: hashOf(impact),
              policyVersionId: policy.id,
              requestedBy: actor.userId,
              amountMinor: impact.customerPriceDeltaMinor,
              currency: change.currency,
              marginBp: null,
              context: { label: `${change.number} ${change.title}`, changeNumber: change.number, customerApprovalRequired: required },
              requiredRoles: roles,
            },
            tx,
          );
          const version = await this.repo.update(change.id, { status: 'commercial_approval', approvalRequestId: requestId, customerApprovalRequired: required }, tx);
          return {
            result: undefined,
            audit: [this.audit(change, version, 'change.impact_completed', { impactVersion: impact.versionNo, approvalRequestId: requestId, requiredRoles: roles, customerApprovalRequired: required })],
            outbox: [this.event(change, version, 'change.approval_requested.v1', { approvalRequestId: requestId })],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.get(actor, changeId);
  }

  /** The approval rail's effect (registered as kind `change`). */
  private async applyApproval(input: ApprovalEffectInput, tx: PoolClient): Promise<Record<string, unknown>> {
    const change = await this.locked(input.subjectId, null, tx);
    if (change.status !== 'commercial_approval') throw new ChangeRefused('CHANGE_NOT_AWAITING_APPROVAL', 'This change is not waiting for approval', `It is ${change.status}.`);
    const to = input.decision === 'approved' ? 'approved' : input.decision === 'rejected' ? 'rejected' : 'impact_analysis';
    const version = await this.repo.update(change.id, { status: to, ...(to === 'impact_analysis' ? { approvalRequestId: null } : {}) }, tx);
    if (to === 'approved' && change.customerApprovalRequired) {
      const order = await this.orders.findSalesOrder(change.salesOrderId, tx);
      const ctx: CommandContext = { actor: { type: 'user', id: input.decidedBy, organizationId: null }, correlationId: input.requestId };
      await this.outbox.write(tx, ctx, this.event(change, version, 'change.customer_decision_requested.v1', { customerOrganizationId: change.customerOrganizationId, orderNumber: order?.number ?? '' }));
    }
    return { changeRequestId: change.id, changeStatus: to };
  }

  // ----------------------------------------------------------------- the customer's decision

  async customerDecide(actor: Actor, changeId: string, input: CustomerChangeDecision, opts: Opts = {}): Promise<CustomerChange> {
    const organizationId = this.customerOrganization(actor);
    if (!actor.roles.includes('customer_approver')) throw new DomainError('NOT_AUTHORIZED', 403, 'Requires customer_approver');
    if (input.decision === 'rejected' && input.reason.length < 3) throw new DomainError('VALIDATION_FAILED', 400, 'Request validation failed', undefined, [{ path: 'reason', message: 'Say why' }]);
    await this.executor.execute(
      {
        operation: 'change.customer-decide',
        handler: async (tx, _ctx, cmd: CustomerChangeDecision) => {
          const change = await this.locked(changeId, cmd.expectedVersion, tx);
          if (change.customerOrganizationId !== organizationId) throw new ChangeNotFound();
          if (change.status !== 'approved' || !change.customerApprovalRequired) throw new ChangeRefused('CHANGE_NOT_AWAITING_CUSTOMER', 'This change is not waiting for your decision');
          if (await this.repo.customerDecision(change.id, tx)) throw new ChangeRefused('CHANGE_ALREADY_DECIDED', 'This change has been decided');
          // Authority read inside the transaction, as for quote acceptance (doc 02 §8).
          const membership = await this.iam.findActiveMembership(actor.userId, organizationId, tx);
          if (!membership || !membership.roles.includes('customer_approver')) throw new DomainError('NOT_AUTHORIZED', 403, 'Requires customer_approver');
          const impact = (await this.repo.latestImpact(change.id, tx))!;
          const limit = await this.repo.changeApprovalLimit(membership.membershipId, change.currency, tx);
          if (cmd.decision === 'approved' && limit !== null && impact.customerPriceDeltaMinor > limit) {
            throw new DomainError('APPROVAL_LIMIT_EXCEEDED', 403, 'This change is above your approval limit', `Your limit for changes is ${limit} ${change.currency} minor units.`);
          }
          await this.repo.insertCustomerDecision(
            { changeId: change.id, decision: cmd.decision, reason: cmd.reason, decidedBy: actor.userId, membershipId: membership.membershipId, authoritySnapshot: { roles: membership.roles, limitMinor: limit, currency: change.currency, priceDeltaMinor: impact.customerPriceDeltaMinor, impactVersion: impact.versionNo } },
            tx,
          );
          const version = cmd.decision === 'rejected' ? await this.repo.update(change.id, { status: 'rejected', outcomeNote: cmd.reason }, tx) : await this.repo.update(change.id, {}, tx);
          return {
            result: undefined,
            audit: [this.audit(change, version, 'change.customer_decided', { decision: cmd.decision, impactVersion: impact.versionNo }, cmd.reason || undefined)],
            outbox: [this.event(change, version, 'change.customer_decided.v1', { decision: cmd.decision })],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.customerGet(actor, changeId);
  }

  // ----------------------------------------------------------------- release

  /**
   * The only command that supersedes a released baseline (F-13.1). In one transaction:
   * the candidate is released in the change's name, every purchase order gets the new
   * transmittal and an amendment, stale grants are revoked, the order is amended (and a
   * positive price delta becomes a `change` installment), scrap and rework are journalled
   * against the order, and interim decisions end.
   */
  async release(actor: Actor, changeId: string, input: ChangeVersionRequest, opts: Opts = {}): Promise<ChangeRequest> {
    this.requireInternal(actor, ENGINEERING);
    await this.executor.execute(
      {
        operation: 'change.release-new-baseline',
        handler: async (tx, ctx, cmd: ChangeVersionRequest) => {
          const change = await this.locked(changeId, cmd.expectedVersion, tx);
          assertChangeTransition(change.status, 'released');
          if (change.customerApprovalRequired) {
            const decision = await this.repo.customerDecision(change.id, tx);
            if (decision?.decision !== 'approved') throw new ChangeRefused('CUSTOMER_DECISION_PENDING', 'The customer has not approved this change', 'Its price, date or scope moves; the customer decides before release.');
          }
          const candidate = change.candidateBaselineId ? await this.production.findBaseline(change.candidateBaselineId, tx, true) : null;
          if (!candidate || candidate.status !== 'draft' || candidate.salesOrderId !== change.salesOrderId) throw new ChangeRefused('CANDIDATE_BASELINE_INVALID', 'The candidate baseline is no longer a draft of this order', undefined, 422);
          if (candidate.items.length === 0) throw new ChangeRefused('BASELINE_EMPTY', 'The candidate baseline has no documents', undefined, 422);
          const conflicts = governingConflicts(candidate.items);
          if (conflicts.length > 0) throw new ChangeRefused('BASELINE_CONFLICT', 'Conflicting governing documents block release (BR-ENG-06)', conflicts.join(' '));
          const eligible = new Map((await this.production.baselineCandidates(change.salesOrderId, tx)).map((c) => [c.documentVersionId, c]));
          for (const item of candidate.items) {
            const c = eligible.get(item.documentVersionId);
            if (!c?.selectable) throw new ChangeRefused('BASELINE_ITEM_NOT_ELIGIBLE', `${item.title} is no longer releasable`, c?.reason ?? 'It is no longer linked to this order.', 422);
          }

          const impact = (await this.repo.latestImpact(change.id, tx))!;
          const old = await this.production.releasedBaseline(change.salesOrderId, tx);
          await this.production.supersedeReleasedBaselines(change.salesOrderId, tx);
          const manifestHash = baselineHash(candidate.items);
          await this.production.releaseBaseline({ baselineId: candidate.id, manifestHash, releasedBy: actor.userId, supersedes: old?.id ?? null, changeRequestId: change.id }, tx);
          const released = (await this.production.findBaseline(candidate.id, tx))!;

          const audit: AuditSpec[] = [];
          const outbox: OutboxSpec[] = [];
          const now = new Date();
          const keep = released.items.map((i) => i.documentVersionId);
          const order = (await this.orders.findSalesOrder(change.salesOrderId, tx))!;
          for (const po of (await this.orders.listPurchaseOrdersForSalesOrder(change.salesOrderId, tx)).filter((p) => p.status !== 'cancelled')) {
            const sent = await this.production.transmitBaseline({ baseline: released, purchaseOrderId: po.id, supplierOrganizationId: po.supplierOrganizationId, dueAt: new Date(now.getTime() + ACK_DAYS * 86_400_000), issuedBy: actor.userId, now }, tx);
            if (!sent) continue;
            const revoked = old ? await this.production.revokeStaleGrants({ organizationId: po.supplierOrganizationId, oldBaselineId: old.id, keepVersionIds: keep, by: actor.userId }, tx) : 0;
            const delta = impact.purchaseOrders.find((p) => p.purchaseOrderId === po.id);
            await this.repo.insertPoAmendment({ purchaseOrderId: po.id, changeId: change.id, transmittalId: sent.transmittalId, currency: order.currency, costDeltaMinor: delta?.costDeltaMinor ?? 0, leadTimeDeltaDays: delta?.leadTimeDeltaDays ?? 0 }, tx);
            audit.push({ action: 'dms.transmittal_issued', subjectType: 'transmittal', subjectId: sent.transmittalId, data: { number: sent.number, baselineId: released.id, purchaseOrderId: po.id, recipientOrganizationId: po.supplierOrganizationId, manifestHash, grants: sent.grants, supersedes: sent.supersedes, revokedGrants: revoked, changeRequestId: change.id } });
            outbox.push({
              eventType: 'dms.transmittal_issued.v1',
              aggregateType: 'transmittal',
              aggregateId: sent.transmittalId,
              data: { transmittalId: sent.transmittalId, number: sent.number, recipientOrganizationId: po.supplierOrganizationId },
            });
          }

          let installmentId: string | null = null;
          if (impact.customerPriceDeltaMinor > 0) {
            installmentId = await this.repo.addChangeInstallment({ salesOrderId: order.id, label: `Change ${change.number}`, amountMinor: impact.customerPriceDeltaMinor, currency: order.currency }, tx);
          }
          if (impact.customerPriceDeltaMinor !== 0 || impact.deliveryDateDeltaDays !== 0) {
            await this.repo.insertOrderAmendment({ salesOrderId: order.id, changeId: change.id, currency: order.currency, priceDeltaMinor: impact.customerPriceDeltaMinor, deliveryDateDeltaDays: impact.deliveryDateDeltaDays, installmentId, createdBy: actor.userId }, tx);
          }
          // Doc 05 §8: what the change cost in scrap and rework, against the order it belongs to.
          const wipCost = impact.wip.filter((w) => w.disposition !== 'reuse').reduce((sum, w) => sum + w.costMinor, 0);
          if (wipCost > 0) {
            await this.finance.postJournal(
              {
                sourceType: 'change_request',
                sourceId: change.id,
                description: `Scrap and rework under ${change.number} on ${order.number}`,
                currency: order.currency,
                correlationId: ctx.correlationId,
                lines: [
                  { account: 'change_cost', debitMinor: wipCost, costObjectType: 'sales_order', costObjectId: order.id },
                  { account: 'supplier_accrual', creditMinor: wipCost, costObjectType: 'sales_order', costObjectId: order.id },
                ],
              },
              tx,
            );
          }
          const lifted = await this.repo.liftAllForChange({ changeId: change.id, by: actor.userId, reason: `Superseded by baseline ${released.number}` }, tx);
          const version = await this.repo.update(change.id, { status: 'released', releasedBaselineId: released.id }, tx);
          audit.unshift(this.audit(change, version, 'change.change_released', { baselineId: released.id, baselineNumber: released.number, supersedes: old?.id ?? null, manifestHash, priceDeltaMinor: impact.customerPriceDeltaMinor, deliveryDateDeltaDays: impact.deliveryDateDeltaDays, wipCostMinor: wipCost, installmentId, liftedInterimDecisions: lifted }));
          outbox.unshift(this.event(change, version, 'change.change_released.v1', { baselineId: released.id }));
          return { result: undefined, audit, outbox };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.get(actor, changeId);
  }

  // ----------------------------------------------------------------- the suppliers' acknowledgment

  /**
   * The supplier accepts the new baseline and its amendment for one purchase order. When
   * every affected order has, the change is implemented (doc 09 §7 step 8).
   */
  async supplierAcknowledge(actor: Actor, changeId: string, input: SupplierChangeAcknowledge, opts: Opts = {}): Promise<SupplierChange> {
    const organizationId = this.supplierOrganization(actor);
    await this.executor.execute(
      {
        operation: 'change.supplier-acknowledge',
        handler: async (tx, _ctx, cmd: SupplierChangeAcknowledge) => {
          const change = await this.locked(changeId, null, tx);
          const amendment = (await this.repo.amendments(change.id, tx)).find((a) => a.purchaseOrderId === cmd.purchaseOrderId);
          if (!amendment || amendment.supplierOrganizationId !== organizationId) throw new ChangeNotFound();
          if (change.status !== 'released') throw new ChangeRefused('CHANGE_NOT_RELEASED', 'There is nothing to acknowledge yet', `This change is ${change.status}.`);
          if (amendment.acknowledgedAt) throw new ChangeRefused('AMENDMENT_ACKNOWLEDGED', 'Already acknowledged');
          const audit: AuditSpec[] = [];
          const outbox: OutboxSpec[] = [];
          const transmittal = await this.production.findTransmittal(amendment.transmittalId, tx, true);
          if (!transmittal || (transmittal.status !== 'issued' && transmittal.status !== 'acknowledged')) throw new ChangeRefused('TRANSMITTAL_NOT_LIVE', 'This change’s transmittal is no longer live');
          if (transmittal.status === 'issued') {
            await this.production.acknowledgeTransmittal({ transmittalId: transmittal.id, by: actor.userId, note: cmd.note }, tx);
            audit.push({ action: 'dms.transmittal_acknowledged', subjectType: 'transmittal', subjectId: transmittal.id, data: { number: transmittal.number, manifestHash: transmittal.manifestHash, note: cmd.note, late: transmittal.acknowledgmentDueAt.getTime() < Date.now(), changeRequestId: change.id } });
            outbox.push({
              eventType: 'dms.transmittal_acknowledged.v1',
              aggregateType: 'transmittal',
              aggregateId: transmittal.id,
              data: { transmittalId: transmittal.id, purchaseOrderId: transmittal.purchaseOrderId },
            });
          }
          await this.repo.acknowledgePoAmendment({ purchaseOrderId: cmd.purchaseOrderId, changeId: change.id, by: actor.userId, note: cmd.note }, tx);
          const wpId = await this.production.workPackageIdForPurchaseOrder(cmd.purchaseOrderId, tx);
          const wp = wpId ? await this.production.findWorkPackage(wpId, tx) : null;
          if (wp?.releasedAt) await this.production.recordWorkPackageBaseline({ workPackageId: wp.id, baselineId: transmittal.baselineId, transmittalId: transmittal.id, by: actor.userId }, tx);
          const outstanding = (await this.repo.amendments(change.id, tx)).filter((a) => !a.acknowledgedAt);
          const version = await this.repo.update(change.id, outstanding.length === 0 ? { status: 'implemented' } : {}, tx);
          audit.unshift(this.audit(change, version, 'change.supplier_acknowledged', { purchaseOrderId: cmd.purchaseOrderId, outstanding: outstanding.length }));
          if (outstanding.length === 0) outbox.push(this.event(change, version, 'change.change_implemented.v1'));
          return { result: undefined, audit, outbox };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.supplierGet(actor, changeId);
  }

  async verify(actor: Actor, changeId: string, input: VerifyChange, opts: Opts = {}): Promise<ChangeRequest> {
    this.requireInternal(actor, VERIFY_ROLES);
    return this.move(actor, changeId, 'change.verify', input, 'verified', async () => ({ fields: { outcomeNote: input.note }, action: 'change.change_verified', reason: input.note }), opts);
  }

  async close(actor: Actor, changeId: string, input: ChangeVersionRequest, opts: Opts = {}): Promise<ChangeRequest> {
    this.requireInternal(actor, ENGINEERING);
    return this.move(
      actor,
      changeId,
      'change.close',
      input,
      'closed',
      async () => ({
        fields: { closedAt: new Date() },
        action: 'change.change_closed',
        eventType: 'change.change_closed.v1',
      }),
      opts,
    );
  }

  // ----------------------------------------------------------------- a new revision of a baselined document

  /** `BR-ENG-05`: a new version of a document in a released baseline opens a change on each open order. */
  private async openForRevision(input: DocumentRevisionInput, tx: PoolClient): Promise<{ audit: AuditSpec[]; outbox: OutboxSpec[] }> {
    const audit: AuditSpec[] = [];
    const outbox: OutboxSpec[] = [];
    for (const hit of await this.repo.ordersBaseliningDocument(input.documentId, tx)) {
      const number = await this.repo.allocateNumber(new Date(), tx);
      const id = await this.repo.create(
        {
          number,
          salesOrderId: hit.salesOrderId,
          origin: 'document_revision',
          urgency: 'normal',
          title: `New revision of ${input.title}`.slice(0, 200),
          reason: `Version ${input.versionNo} of "${input.title}" was uploaded. Baseline ${hit.baselineNumber} of this order is built on an earlier version; decide whether it changes the work.`.slice(0, 2000),
          contextDocumentVersionIds: [input.documentVersionId],
          proposedBy: input.uploadedBy,
        },
        tx,
      );
      const change = (await this.repo.find(id, tx))!;
      audit.push(this.audit(change, 1, 'change.change_proposed', { origin: 'document_revision', documentVersionId: input.documentVersionId }));
      outbox.push(this.event(change, 1, 'change.change_proposed.v1', { origin: 'document_revision' }));
    }
    return { audit, outbox };
  }

  // ----------------------------------------------------------------- reads

  async list(actor: Actor, filter: { salesOrderId?: string }): Promise<ChangeRequest[]> {
    this.requireReader(actor);
    return Promise.all((await this.repo.list(filter)).map((row) => this.view(row)));
  }

  async get(actor: Actor, changeId: string): Promise<ChangeRequest> {
    this.requireReader(actor);
    const row = await this.repo.find(changeId);
    if (!row) throw new ChangeNotFound();
    return this.view(row);
  }

  private requireReader(actor: Actor): void {
    if (!actor.isInternal || !actor.roles.some((r) => INTERNAL_READERS.includes(r))) throw new DomainError('NOT_AUTHORIZED', 403, 'Internal audience only');
  }

  private interim(d: InterimRow) {
    return {
      interimDecisionId: d.id,
      purchaseOrderId: d.purchaseOrderId,
      purchaseOrderNumber: d.purchaseOrderNumber,
      decision: d.decision,
      reason: d.reason,
      expiresAt: d.expiresAt.toISOString(),
      issuedAt: d.issuedAt.toISOString(),
      liftedAt: d.liftedAt ? d.liftedAt.toISOString() : null,
      liftReason: d.liftReason,
      active: !d.liftedAt && d.expiresAt.getTime() > Date.now(),
    };
  }

  private amendment(a: PoAmendmentRow) {
    return { purchaseOrderId: a.purchaseOrderId, purchaseOrderNumber: a.purchaseOrderNumber, costDeltaMinor: a.costDeltaMinor, leadTimeDeltaDays: a.leadTimeDeltaDays, transmittalId: a.transmittalId, acknowledgedAt: a.acknowledgedAt ? a.acknowledgedAt.toISOString() : null };
  }

  private impactView(impact: ImpactRow) {
    return { ...impact, recordedAt: impact.recordedAt.toISOString() };
  }

  private async view(row: ChangeRow): Promise<ChangeRequest> {
    const [impact, supplierImpacts, interim, decision, amendments] = await Promise.all([
      this.repo.latestImpact(row.id),
      this.repo.supplierImpacts(row.id),
      this.repo.interimDecisions(row.id),
      this.repo.customerDecision(row.id),
      this.repo.amendments(row.id),
    ]);
    const missing = missingImpactAreas(impact?.areas ?? null);
    return {
      changeRequestId: row.id,
      number: row.number,
      salesOrderId: row.salesOrderId,
      salesOrderNumber: row.salesOrderNumber,
      origin: row.origin,
      classification: row.classification,
      urgency: row.urgency,
      title: row.title,
      reason: row.reason,
      status: row.status,
      infoRequest: row.infoRequest,
      infoResponse: row.infoResponse,
      supplierBrief: row.supplierBrief,
      customerApprovalRequired: row.customerApprovalRequired,
      approvalRequestId: row.approvalRequestId,
      candidateBaselineId: row.candidateBaselineId,
      releasedBaselineId: row.releasedBaselineId,
      contextDocumentVersionIds: row.contextDocumentVersionIds,
      outcomeNote: row.outcomeNote,
      impact: impact ? this.impactView(impact) : null,
      impactComplete: impact !== null && missing.length === 0,
      missingAreas: missing,
      supplierImpacts: supplierImpacts.map((s) => ({ purchaseOrderId: s.purchaseOrderId, supplierDisplayName: s.supplierDisplayName, costDeltaMinor: s.costDeltaMinor, leadTimeDeltaDays: s.leadTimeDeltaDays, wip: s.wip, note: s.note, submittedAt: s.submittedAt.toISOString() })),
      interimDecisions: interim.map((d) => this.interim(d)),
      customerDecision: decision ? { decision: decision.decision, reason: decision.reason, decidedAt: decision.decidedAt.toISOString() } : null,
      amendments: amendments.map((a) => this.amendment(a)),
      proposedAt: row.proposedAt.toISOString(),
      closedAt: row.closedAt ? row.closedAt.toISOString() : null,
      aggregateVersion: row.aggregateVersion,
    };
  }

  /** The customer sees the change and its effect on its own price and date, never the buy side. */
  async customerList(actor: Actor, orderId?: string): Promise<CustomerChange[]> {
    const organizationId = this.customerOrganization(actor);
    const rows = await this.repo.list({ customerOrganizationId: organizationId, ...(orderId ? { salesOrderId: orderId } : {}) });
    return Promise.all(rows.map((row) => this.customerView(actor, row)));
  }

  async customerGet(actor: Actor, changeId: string): Promise<CustomerChange> {
    const organizationId = this.customerOrganization(actor);
    const row = await this.repo.find(changeId);
    if (!row || row.customerOrganizationId !== organizationId) throw new ChangeNotFound();
    return this.customerView(actor, row);
  }

  private async customerView(actor: Actor, row: ChangeRow): Promise<CustomerChange> {
    const [impact, decision] = await Promise.all([this.repo.latestImpact(row.id), this.repo.customerDecision(row.id)]);
    // The effect is shown once JobWork has approved it: an estimate in progress is not an offer.
    const offered = ['approved', 'released', 'implemented', 'verified', 'closed'].includes(row.status) || (row.status === 'rejected' && decision !== null);
    const decisionNeeded = row.status === 'approved' && row.customerApprovalRequired === true && decision === null;
    return {
      changeRequestId: row.id,
      number: row.number,
      orderId: row.salesOrderId,
      orderNumber: row.salesOrderNumber,
      title: row.title,
      reason: row.reason,
      status: row.status,
      infoRequest: row.infoRequest,
      infoResponse: row.infoResponse,
      priceDeltaMinor: offered && impact ? impact.customerPriceDeltaMinor : null,
      currency: row.currency,
      deliveryDateDeltaDays: offered && impact ? impact.deliveryDateDeltaDays : null,
      decisionNeeded,
      canDecide: decisionNeeded && actor.roles.includes('customer_approver'),
      decision: decision ? { decision: decision.decision, reason: decision.reason, decidedAt: decision.decidedAt.toISOString() } : null,
      proposedAt: row.proposedAt.toISOString(),
      aggregateVersion: row.aggregateVersion,
    };
  }

  /** A supplier sees JobWork's brief and only its own purchase orders' decisions and amendments. */
  async supplierList(actor: Actor): Promise<SupplierChange[]> {
    const organizationId = this.supplierOrganization(actor);
    return Promise.all((await this.repo.listForSupplier(organizationId)).map((row) => this.supplierView(organizationId, row)));
  }

  async supplierGet(actor: Actor, changeId: string): Promise<SupplierChange> {
    const organizationId = this.supplierOrganization(actor);
    const row = (await this.repo.listForSupplier(organizationId)).find((r) => r.id === changeId);
    if (!row) throw new ChangeNotFound();
    return this.supplierView(organizationId, row);
  }

  private async supplierView(organizationId: string, row: ChangeRow): Promise<SupplierChange> {
    const [pos, interim, amendments, impacts] = await Promise.all([
      this.orders.listPurchaseOrdersForSalesOrder(row.salesOrderId),
      this.repo.interimDecisions(row.id),
      this.repo.amendments(row.id),
      this.repo.supplierImpacts(row.id),
    ]);
    const mine = pos.filter((p) => p.supplierOrganizationId === organizationId && p.status !== 'cancelled');
    return {
      changeRequestId: row.id,
      number: row.number,
      brief: row.supplierBrief,
      status: row.status,
      purchaseOrders: mine.map((p) => {
        const amendment = amendments.find((a) => a.purchaseOrderId === p.id);
        return {
          purchaseOrderId: p.id,
          purchaseOrderNumber: p.number,
          interimDecisions: interim.filter((d) => d.purchaseOrderId === p.id).map((d) => this.interim(d)),
          amendment: amendment ? this.amendment(amendment) : null,
          impactSubmitted: impacts.some((i) => i.purchaseOrderId === p.id),
        };
      }),
      impactInvited: row.status === 'impact_analysis',
    };
  }
}
