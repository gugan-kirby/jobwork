import { createHash } from 'node:crypto';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { CustomerDeviation, CustomerDeviationDecision, Deviation, RequestDeviationRequest, WithdrawDeviationRequest } from '@jobwork/contracts';
import { ApprovalEffectRegistry, CommercialRepository, type ApprovalEffectInput } from '../../commercial';
import { type Actor, IamRepository, requireTransactionalStrength } from '../../iam';
import { contextFromActor, type AuditSpec, type CommandContext, type OutboxSpec } from '../../../platform/commands/command';
import { CommandExecutor } from '../../../platform/commands/execute';
import { OutboxWriter } from '../../../platform/commands/outbox.writer';
import { DomainError } from '../../../platform/http/domain-error';
import { customerLotMarking } from '../../logistics/domain/lot-marking';
import { QualityRefused } from '../domain/inspection';
import { assertNcrTransition } from '../domain/ncr';
import { Rational } from '../domain/rational';
import { type DeviationRow, NcrRepository } from '../infrastructure/ncr.repository';
import { QualityRepository } from '../infrastructure/quality.repository';
import { QUALITY, QUALITY_READERS, requireInternal } from './quality-plan.command';

type Opts = { idempotencyKey?: string | undefined };

const MAX_DAYS = 180;
const hashOf = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Owner default: the customer decides whenever the characteristic or NCR is critical or major, or price, warranty or labelling moves. */
export function customerMustDecide(input: { ncrSeverity: string; criticalities: string[]; priceEffect: string; warrantyEffect: string; labelingEffect: string }): boolean {
  return (
    ['critical', 'major'].includes(input.ncrSeverity) ||
    input.criticalities.some((c) => c === 'critical' || c === 'major') ||
    [input.priceEffect, input.warrantyEffect, input.labelingEffect].some((e) => e.trim() !== '')
  );
}

const active = (d: DeviationRow): boolean => d.status === 'approved' && d.expiresAt.getTime() > Date.now();
/** It reached the customer: required, and approved inside JobWork first. */
const customerFacing = (d: DeviationRow): boolean => d.customerApprovalRequired && d.approvalStatus === 'approved';

/**
 * Deviations (concessions) (IN-15 F-15.3; doc 09 §12; FR-704; BR-QLT-02; doc 03 §4).
 * JobWork quality asks to use nonconforming parts as they are, within an exact scope and
 * period. Another member of quality or engineering decides through the approval rail; then,
 * where it matters to the customer, the customer's approver decides. Nothing else makes a
 * deviation authoritative, and nothing turns the failed results into passes.
 */
@Injectable()
export class DeviationCommand implements OnModuleInit {
  constructor(
    private readonly repo: NcrRepository,
    private readonly quality: QualityRepository,
    private readonly commercial: CommercialRepository,
    private readonly iam: IamRepository,
    private readonly executor: CommandExecutor,
    private readonly outbox: OutboxWriter,
    private readonly effects: ApprovalEffectRegistry,
  ) {}

  onModuleInit(): void {
    this.effects.register('deviation', (input, tx) => this.applyApproval(input, tx));
  }

  private audit(d: { id: string; number: string }, version: number, action: string, data: Record<string, unknown> = {}, reason?: string): AuditSpec {
    return { action, subjectType: 'deviation', subjectId: d.id, subjectVersion: version, ...(reason ? { reason } : {}), data: { number: d.number, ...data } };
  }

  private event(d: { id: string; number: string; ncrId: string }, version: number, type: string, data: Record<string, unknown> = {}): OutboxSpec {
    return {
      eventType: type,
      aggregateType: 'deviation',
      aggregateId: d.id,
      aggregateVersion: version,
      data: { deviationId: d.id, number: d.number, ncrId: d.ncrId, ...data },
    };
  }

  /** The NCR follows its deviation: accepted under it, or back to a disposition. */
  private async settleNcr(d: DeviationRow, approved: boolean, decidedBy: string | null, tx: PoolClient): Promise<{ audit: AuditSpec[] }> {
    const ncr = (await this.repo.find(d.ncrId, tx, true))!;
    const to = approved ? 'accepted_under_deviation' : 'disposition_pending';
    assertNcrTransition(ncr.status, to);
    const disposition = (await this.repo.dispositions(ncr.id, tx)).at(-1)!;
    await this.repo.setOutcome(disposition.id, approved ? 'deviation_approved' : 'deviation_rejected', tx);
    const version = await this.repo.update(ncr.id, { status: to, ...(approved && decidedBy ? { dispositionDecidedBy: decidedBy } : {}) }, tx);
    return {
      audit: [{ action: approved ? 'quality.ncr_accepted_under_deviation' : 'quality.ncr_deviation_rejected', subjectType: 'ncr', subjectId: ncr.id, subjectVersion: version, data: { number: ncr.number, deviation: d.number } }],
    };
  }

  // ----------------------------------------------------------------- request

  async request(actor: Actor, ncrId: string, input: RequestDeviationRequest, opts: Opts = {}): Promise<Deviation> {
    requireInternal(actor, QUALITY);
    requireTransactionalStrength(actor);
    const policy = await this.commercial.activePolicy('deviation');
    if (!policy) throw new DomainError('POLICY_RULES_INVALID', 500, 'No active deviation approval policy');
    const id = await this.executor.execute(
      {
        operation: 'quality.request-deviation',
        handler: async (tx, _ctx, cmd: RequestDeviationRequest) => {
          const ncr = await this.repo.find(ncrId, tx, true);
          if (!ncr) throw new DomainError('NCR_NOT_FOUND', 404, 'NCR not found');
          if (ncr.aggregateVersion !== cmd.expectedVersion) throw new DomainError('VERSION_CONFLICT', 409, 'The NCR moved on', 'Reload it and try again.');
          assertNcrTransition(ncr.status, 'deviation_pending');
          // The scope stays inside the NCR's (doc 19 §6: the rest stays held).
          const defects = await this.repo.defects(ncr.id, tx);
          if (cmd.characteristicIds.some((c) => !defects.some((d) => d.characteristicId === c))) throw new QualityRefused('DEVIATION_SCOPE', 'A deviation covers only characteristics the NCR found failing', undefined, 422);
          if (Rational.parse(cmd.quantity).compare(Rational.parse(ncr.affectedQuantity)) > 0) throw new QualityRefused('DEVIATION_SCOPE', `A deviation covers at most the NCR's ${Number(ncr.affectedQuantity)} parts`, undefined, 422);
          if (ncr.lots.length > 0 && (cmd.lots.length === 0 || cmd.lots.some((l) => !ncr.lots.includes(l)))) throw new QualityRefused('DEVIATION_SCOPE', 'Name the lots it covers, from the NCR’s lots', ncr.lots.join(', '), 422);
          if (ncr.serials.length > 0 && cmd.serials.some((x) => !ncr.serials.includes(x))) throw new QualityRefused('DEVIATION_SCOPE', 'Serials must come from the NCR’s serials', undefined, 422);
          const expiresAt = new Date(cmd.expiresAt);
          if (expiresAt.getTime() <= Date.now() || expiresAt.getTime() > Date.now() + MAX_DAYS * 86_400_000) throw new QualityRefused('DEVIATION_EXPIRY', `A deviation ends within ${MAX_DAYS} days`, undefined, 422);
          const plan = (await this.quality.plansFor(ncr.workPackageId, tx)).find((p) => p.status === 'approved' || p.status === 'superseded');
          const characteristics = plan ? (await this.quality.characteristics((await this.quality.findInspection(ncr.inspectionId, tx))!.planId, tx)).filter((c) => cmd.characteristicIds.includes(c.id)) : [];
          const required = customerMustDecide({ ncrSeverity: ncr.severity, criticalities: characteristics.map((c) => c.criticality), priceEffect: cmd.priceEffect, warrantyEffect: cmd.warrantyEffect, labelingEffect: cmd.labelingEffect });
          const number = await this.repo.allocateNumber('DV', 'deviation', new Date(), tx);
          const deviationId = await this.repo.insertDeviation({ number, ncrId: ncr.id, ...cmd, expiresAt, customerApprovalRequired: required, by: actor.userId }, tx);
          const requestId = await this.commercial.createApprovalRequest(
            {
              kind: 'deviation',
              subjectType: 'deviation',
              subjectId: deviationId,
              subjectVersionNo: 1,
              subjectHash: hashOf({ ...cmd, ncrId: ncr.id }),
              policyVersionId: policy.id,
              requestedBy: actor.userId,
              amountMinor: null,
              currency: null,
              marginBp: null,
              context: { label: `${number} on ${ncr.number}: ${ncr.title}`, ncrId: ncr.id, deviationNumber: number, customerApprovalRequired: required },
              requiredRoles: ((policy.rules as { approverRoles?: string[] }).approverRoles ?? ['jobwork_quality']),
            },
            tx,
          );
          await this.repo.updateDeviation(deviationId, { approvalRequestId: requestId }, tx);
          // Use-as-is is this attempt's disposition; it is decided by the approvals that follow.
          const attemptNo = ncr.attemptNo + 1;
          await this.repo.insertDisposition({ ncrId: ncr.id, attemptNo, disposition: 'use_as_is', plan: cmd.rationale, by: actor.userId }, tx);
          const ncrVersion = await this.repo.update(ncr.id, { status: 'deviation_pending', attemptNo }, tx);
          const created = { id: deviationId, number, ncrId: ncr.id };
          return {
            result: deviationId,
            audit: [
              this.audit(created, 2, 'quality.deviation_requested', { ncr: ncr.number, quantity: cmd.quantity, lots: cmd.lots, expiresAt: cmd.expiresAt, customerApprovalRequired: required, approvalRequestId: requestId }),
              { action: 'quality.ncr_deviation_requested', subjectType: 'ncr', subjectId: ncr.id, subjectVersion: ncrVersion, data: { number: ncr.number, deviation: number, attemptNo } },
            ],
            outbox: [this.event(created, 2, 'quality.deviation_requested.v1', { approvalRequestId: requestId, customerApprovalRequired: required })],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.get(actor, id);
  }

  /** The approval rail's decision (another quality or engineering member; never the requester). */
  private async applyApproval(input: ApprovalEffectInput, tx: PoolClient): Promise<Record<string, unknown>> {
    const d = await this.repo.findDeviation(input.subjectId, tx, true);
    if (!d || d.status !== 'pending_internal') throw new QualityRefused('DEVIATION_NOT_PENDING', 'This deviation is not waiting for an internal decision');
    const ctx: CommandContext = { actor: { type: 'user', id: input.decidedBy, organizationId: null }, correlationId: input.requestId };
    if (input.decision !== 'approved') {
      const version = await this.repo.updateDeviation(d.id, { status: 'rejected', decidedAt: new Date(), decisionReason: input.decision === 'returned' ? 'Returned by the approver' : 'Rejected by the approver' }, tx);
      await this.settleNcr(d, false, null, tx);
      await this.outbox.write(tx, ctx, this.event(d, version, 'quality.deviation_rejected.v1', { by: 'jobwork' }));
      return { deviationId: d.id, deviationStatus: 'rejected' };
    }
    if (d.customerApprovalRequired) {
      const version = await this.repo.updateDeviation(d.id, { status: 'pending_customer' }, tx);
      // The internal approver is who decided the disposition inside JobWork (BR-QLT-06 independence at closure).
      await this.repo.update(d.ncrId, { dispositionDecidedBy: input.decidedBy }, tx);
      await this.outbox.write(tx, ctx, this.event(d, version, 'quality.deviation_customer_decision_requested.v1', { customerOrganizationId: d.customerOrganizationId, orderNumber: d.salesOrderNumber, salesOrderId: d.salesOrderId }));
      return { deviationId: d.id, deviationStatus: 'pending_customer' };
    }
    const version = await this.repo.updateDeviation(d.id, { status: 'approved', decidedAt: new Date() }, tx);
    await this.settleNcr(d, true, input.decidedBy, tx);
    await this.outbox.write(tx, ctx, this.event(d, version, 'quality.deviation_approved.v1', { ...this.supplierFacts(d) }));
    return { deviationId: d.id, deviationStatus: 'approved' };
  }

  private supplierFacts(d: DeviationRow): Record<string, unknown> {
    return { supplierOrganizationId: d.supplierOrganizationId, purchaseOrderId: d.purchaseOrderId, purchaseOrderNumber: d.purchaseOrderNumber, number: d.number, ncrNumber: d.ncrNumber, dispositionLabel: `accepted as they are under ${d.number}, for the stated parts and period` };
  }

  async withdraw(actor: Actor, deviationId: string, input: WithdrawDeviationRequest, opts: Opts = {}): Promise<Deviation> {
    requireInternal(actor, QUALITY);
    requireTransactionalStrength(actor);
    await this.executor.execute(
      {
        operation: 'quality.withdraw-deviation',
        handler: async (tx, _ctx, cmd: WithdrawDeviationRequest) => {
          const d = await this.repo.findDeviation(deviationId, tx, true);
          if (!d) throw new DomainError('DEVIATION_NOT_FOUND', 404, 'Deviation not found');
          if (d.aggregateVersion !== cmd.expectedVersion) throw new DomainError('VERSION_CONFLICT', 409, 'The deviation moved on', 'Reload it and try again.');
          if (d.status !== 'pending_internal' && d.status !== 'pending_customer') throw new QualityRefused('DEVIATION_NOT_PENDING', 'Only a pending deviation can be withdrawn');
          const version = await this.repo.updateDeviation(d.id, { status: 'withdrawn', decidedAt: new Date(), decisionReason: cmd.reason }, tx);
          const ncr = await this.settleNcr(d, false, null, tx);
          return {
            result: undefined,
            audit: [this.audit(d, version, 'quality.deviation_withdrawn', {}, cmd.reason), ...ncr.audit],
            outbox: [this.event(d, version, 'quality.deviation_withdrawn.v1')],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.get(actor, deviationId);
  }

  // ----------------------------------------------------------------- the customer's decision (UC-06)

  async customerDecide(actor: Actor, deviationId: string, input: CustomerDeviationDecision, opts: Opts = {}): Promise<CustomerDeviation> {
    if (actor.organizationType !== 'customer' || !actor.organizationId) throw new DomainError('NOT_AUTHORIZED', 403, 'Customers only');
    if (!actor.roles.includes('customer_approver')) throw new DomainError('NOT_AUTHORIZED', 403, 'Requires customer_approver');
    if (input.decision === 'rejected' && input.reason.length < 3) throw new DomainError('VALIDATION_FAILED', 400, 'Request validation failed', undefined, [{ path: 'reason', message: 'Say why' }]);
    const organizationId = actor.organizationId;
    await this.executor.execute(
      {
        operation: 'quality.customer-decide-deviation',
        handler: async (tx, _ctx, cmd: CustomerDeviationDecision) => {
          const d = await this.repo.findDeviation(deviationId, tx, true);
          if (!d || d.customerOrganizationId !== organizationId) throw new DomainError('DEVIATION_NOT_FOUND', 404, 'Deviation not found');
          if (d.aggregateVersion !== cmd.expectedVersion) throw new DomainError('VERSION_CONFLICT', 409, 'The deviation moved on', 'Reload it and try again.');
          if (d.status !== 'pending_customer') throw new QualityRefused('DEVIATION_NOT_AWAITING_CUSTOMER', 'This deviation is not waiting for your decision');
          // Authority read inside the transaction (doc 02 §8; no email-only approval, D-07).
          const membership = await this.iam.findActiveMembership(actor.userId, organizationId, tx);
          if (!membership || !membership.roles.includes('customer_approver')) throw new DomainError('NOT_AUTHORIZED', 403, 'Requires customer_approver');
          await this.repo.insertDeviationCustomerDecision(
            {
              deviationId: d.id,
              decision: cmd.decision,
              reason: cmd.reason,
              decidedBy: actor.userId,
              membershipId: membership.membershipId,
              authoritySnapshot: { roles: membership.roles, quantity: d.quantity, lots: d.lots, serials: d.serials, expiresAt: d.expiresAt.toISOString(), scopeAcknowledged: true },
            },
            tx,
          );
          const approved = cmd.decision === 'approved';
          const version = await this.repo.updateDeviation(d.id, { status: approved ? 'approved' : 'rejected', decidedAt: new Date(), ...(cmd.reason ? { decisionReason: cmd.reason } : {}) }, tx);
          const ncr = await this.settleNcr(d, approved, null, tx);
          return {
            result: undefined,
            audit: [this.audit(d, version, 'quality.deviation_customer_decided', { decision: cmd.decision }, cmd.reason || undefined), ...ncr.audit],
            outbox: [
              {
                eventType: approved ? 'quality.deviation_approved.v1' : 'quality.deviation_rejected.v1',
                aggregateType: 'deviation',
                aggregateId: d.id,
                aggregateVersion: version,
                data: { deviationId: d.id, ncrId: d.ncrId, by: 'customer', ...this.supplierFacts(d) },
              },
            ],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.customerGet(actor, deviationId);
  }

  // ----------------------------------------------------------------- reads

  async get(actor: Actor, deviationId: string): Promise<Deviation> {
    requireInternal(actor, QUALITY_READERS);
    const d = await this.repo.findDeviation(deviationId);
    if (!d) throw new DomainError('DEVIATION_NOT_FOUND', 404, 'Deviation not found');
    return this.view(d);
  }

  async forNcr(actor: Actor, ncrId: string): Promise<Deviation[]> {
    requireInternal(actor, QUALITY_READERS);
    return Promise.all((await this.repo.deviations({ ncrId })).map((d) => this.view(d)));
  }

  private async view(d: DeviationRow): Promise<Deviation> {
    const names = await this.characteristicNames(d);
    const decision = await this.repo.deviationCustomerDecision(d.id);
    return {
      deviationId: d.id,
      number: d.number,
      ncrId: d.ncrId,
      ncrNumber: d.ncrNumber,
      status: d.status,
      active: active(d),
      characteristics: d.characteristicIds.map((id) => ({ characteristicId: id, name: names.get(id) ?? '' })),
      quantity: d.quantity,
      lots: d.lots,
      serials: d.serials,
      expiresAt: d.expiresAt.toISOString(),
      rationale: d.rationale,
      riskAssessment: d.riskAssessment,
      fitFunctionSafety: d.fitFunctionSafety,
      effects: { price: d.priceEffect, warranty: d.warrantyEffect, traceability: d.traceabilityEffect, labeling: d.labelingEffect },
      customerApprovalRequired: d.customerApprovalRequired,
      approvalRequestId: d.approvalRequestId,
      customerDecision: decision ? { decision: decision.decision, reason: decision.reason, decidedAt: decision.decidedAt.toISOString() } : null,
      requestedAt: d.requestedAt.toISOString(),
      decidedAt: d.decidedAt ? d.decidedAt.toISOString() : null,
      decisionReason: d.decisionReason,
      aggregateVersion: d.aggregateVersion,
    };
  }

  private async characteristicNames(d: DeviationRow): Promise<Map<string, string>> {
    const defects = await this.repo.defects(d.ncrId);
    return new Map(defects.map((x) => [x.characteristicId, x.characteristicName]));
  }

  /** A customer's deviations on one of its orders, the decided ones as well. */
  async customerList(actor: Actor, orderId: string): Promise<CustomerDeviation[]> {
    if (actor.organizationType !== 'customer' || !actor.organizationId) throw new DomainError('NOT_AUTHORIZED', 403, 'Customers only');
    const rows = (await this.repo.deviations({ salesOrderId: orderId })).filter((d) => d.customerOrganizationId === actor.organizationId && customerFacing(d));
    return Promise.all(rows.map((d) => this.customerView(actor, d)));
  }

  async customerGet(actor: Actor, deviationId: string): Promise<CustomerDeviation> {
    const d = await this.repo.findDeviation(deviationId);
    if (!d || d.customerOrganizationId !== actor.organizationId || !customerFacing(d)) throw new DomainError('DEVIATION_NOT_FOUND', 404, 'Deviation not found');
    return this.customerView(actor, d);
  }

  private async customerView(actor: Actor, d: DeviationRow): Promise<CustomerDeviation> {
    const defects = (await this.repo.defects(d.ncrId)).filter((x) => d.characteristicIds.includes(x.characteristicId));
    const inspection = (await this.repo.find(d.ncrId))!;
    const characteristics = (await this.quality.characteristics((await this.quality.findInspection(inspection.inspectionId))!.planId)).filter((c) => d.characteristicIds.includes(c.id));
    const decision = await this.repo.deviationCustomerDecision(d.id);
    const limits = (c: (typeof characteristics)[number]): string =>
      c.kind === 'attribute'
        ? `one of: ${c.acceptedValues.join(', ')}`
        : [c.lowerLimit !== null ? `${c.lowerInclusive ? '≥' : '>'} ${c.lowerLimit}` : null, c.upperLimit !== null ? `${c.upperInclusive ? '≤' : '<'} ${c.upperLimit}` : null].filter(Boolean).join(' and ') + ` ${c.unit ?? ''}`;
    return {
      deviationId: d.id,
      number: d.number,
      orderId: d.salesOrderId,
      orderNumber: d.salesOrderNumber,
      status: d.status,
      requirements: characteristics.map((c) => ({
        name: c.name,
        drawingReference: c.drawingReference,
        limits: limits(c).trim(),
        actual: defects.filter((x) => x.characteristicId === c.id).map((x) => ({ sampleNo: x.sampleNo, value: x.originalValue, unit: x.originalUnit })),
      })),
      quantity: d.quantity,
      // The workshop's lot codes never reach the customer (D13): JobWork's markings once the lots are in its stock.
      lots: (await this.repo.stockLotsFor(d.ncrId, d.lots)).map(customerLotMarking),
      serials: d.serials,
      expiresAt: d.expiresAt.toISOString(),
      rationale: d.rationale,
      fitFunctionSafety: d.fitFunctionSafety,
      effects: { price: d.priceEffect, warranty: d.warrantyEffect, traceability: d.traceabilityEffect, labeling: d.labelingEffect },
      decisionNeeded: d.status === 'pending_customer',
      canDecide: d.status === 'pending_customer' && actor.roles.includes('customer_approver'),
      decision: decision ? { decision: decision.decision, reason: decision.reason, decidedAt: decision.decidedAt.toISOString() } : null,
      aggregateVersion: d.aggregateVersion,
    };
  }
}
