import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type {
  BillVersionRequest,
  MarkSettlementPaidRequest,
  RejectBillRequest,
  RequestBillExceptionRequest,
  ScheduleSettlementRequest,
  SubmitSupplierBillRequest,
  SupplierBill,
  SupplierBillStatus,
} from '@jobwork/contracts';
import { ApprovalEffectRegistry, CommercialRepository, type ApprovalEffectInput } from '../../commercial';
import { type Actor, requireTransactionalStrength } from '../../iam';
import { contextFromActor, type AuditSpec, type OutboxSpec } from '../../../platform/commands/command';
import { CommandExecutor } from '../../../platform/commands/execute';
import { DomainError } from '../../../platform/http/domain-error';
import { settlementEligibility, threeWayMatch } from '../domain/three-way-match';
import { FinanceRepository } from '../infrastructure/finance.repository';
import { type BillRow, SettlementRepository } from '../infrastructure/settlement.repository';
import { OrderClosure } from './order-closure';

type Opts = { idempotencyKey?: string | undefined };

const FINANCE = ['jobwork_finance'];
/** Who at the supplier bills JobWork: its admin and its commercial people (owner default). */
const SUPPLIER_BILLERS = ['org_admin', 'supplier_estimator'];
const TOLERANCE = { basisPoints: 100, capMinor: 50_000 };

class SettlementRefused extends DomainError {
  constructor(code: string, title: string, detail?: string, status = 409) {
    super(code, status, title, detail);
  }
}

/**
 * Supplier bills and settlement (IN-18 F-18.1; UC-31; doc 10 §5; FR-805; BR-FIN-03, BR-FIN-04,
 * BR-FIN-07). The supplier submits its bill against a purchase order; finance matches it against the
 * PO and what JobWork accepted; a mismatch is an exception a second finance member decides. A matched
 * bill posts the payable and opens a settlement whose eligibility is computed from facts; it is paid
 * only while eligible, with its own journal, and nothing about it touches the customer's money.
 */
@Injectable()
export class SettlementCommand {
  constructor(
    private readonly repo: SettlementRepository,
    private readonly finance: FinanceRepository,
    private readonly commercial: CommercialRepository,
    private readonly closure: OrderClosure,
    private readonly executor: CommandExecutor,
    effects: ApprovalEffectRegistry,
  ) {
    effects.register('bill_exception', (input, tx) => this.applyException(input, tx));
  }

  // ----------------------------------------------------------------- helpers

  private audit(b: { id: string; number: string }, version: number, action: string, data: Record<string, unknown> = {}, reason?: string): AuditSpec {
    return { action, subjectType: 'supplier_bill', subjectId: b.id, subjectVersion: version, ...(reason ? { reason } : {}), data: { number: b.number, ...data } };
  }

  private event(b: BillRow, version: number, type: string, data: Record<string, unknown> = {}): OutboxSpec {
    return { eventType: type, aggregateType: 'supplier_bill', aggregateId: b.id, aggregateVersion: version, data: { billId: b.id, number: b.number, purchaseOrderId: b.purchaseOrderId, supplierOrganizationId: b.supplierOrganizationId, ...data } };
  }

  private requireFinance(actor: Actor): void {
    if (!actor.isInternal || !actor.roles.some((r) => FINANCE.includes(r))) throw new DomainError('NOT_AUTHORIZED', 403, 'Not permitted', 'Requires jobwork_finance.');
    requireTransactionalStrength(actor);
  }

  private async locked(id: string, expectedVersion: number | null, tx: PoolClient): Promise<BillRow> {
    const b = await this.repo.findBill(id, tx, true);
    if (!b) throw new DomainError('BILL_NOT_FOUND', 404, 'Bill not found');
    if (expectedVersion !== null && b.aggregateVersion !== expectedVersion) throw new DomainError('VERSION_CONFLICT', 409, 'The bill moved on', 'Reload it and try again.');
    return b;
  }

  /** Doc 10 §5, read now. */
  private async eligibility(b: BillRow, status: SupplierBillStatus, tx: PoolClient): Promise<{ pass: boolean; reasons: string[]; computedAt: string }> {
    const po = (await this.repo.purchaseOrder(b.purchaseOrderId, tx))!;
    const standing = await this.repo.supplierStanding(po.supplierOrganizationId, tx);
    const result = settlementEligibility({
      billStatus: status,
      purchaseOrderStatus: po.status,
      workReleased: ['released', 'in_production', 'completed'].includes(po.workPackageStatus ?? ''),
      qualityReleased: po.workPackageId ? await this.repo.qualityReleased(po.workPackageId, tx) : false,
      openNcrs: po.workPackageId ? await this.repo.openNcrs(po.workPackageId, tx) : [],
      supplierActive: standing.active,
      bankVerified: standing.bankVerified,
      holdingCases: await this.repo.holdingCases(po.id, tx),
    });
    return { ...result, computedAt: new Date().toISOString() };
  }

  /** The payable: cost of the supplier's work and its input tax against what JobWork owes it (doc 10 §6). */
  private async postPayable(b: BillRow, correlationId: string, tx: PoolClient): Promise<{ journalId: string; audit: AuditSpec[] }> {
    const po = (await this.repo.purchaseOrder(b.purchaseOrderId, tx))!;
    const journalId = await this.finance.postJournal(
      {
        sourceType: 'supplier_bill',
        sourceId: b.id,
        description: `Supplier bill ${b.number} (${b.supplierReference}) on ${b.purchaseOrderNumber}`,
        currency: b.currency,
        correlationId,
        lines: [
          { account: 'cost_of_goods', debitMinor: b.taxableMinor, costObjectType: 'sales_order', costObjectId: po.salesOrderId },
          { account: 'gst_input', debitMinor: b.taxMinor },
          { account: 'supplier_payable', creditMinor: b.totalMinor, costObjectType: 'purchase_order', costObjectId: po.id },
        ],
      },
      tx,
    );
    const status: SupplierBillStatus = b.status === 'match_exception' ? 'exception_approved' : 'matched';
    const eligibility = await this.eligibility(b, status, tx);
    await this.repo.insertSettlement({ supplierBillId: b.id, status: eligibility.pass ? 'eligible' : 'held', eligibility }, tx);
    return { journalId, audit: [this.audit(b, b.aggregateVersion, 'finance.supplier_payable_posted', { journalId, totalMinor: b.totalMinor, settlementEligible: eligibility.pass })] };
  }

  // ----------------------------------------------------------------- the supplier bills

  async submit(actor: Actor, input: SubmitSupplierBillRequest, opts: Opts = {}): Promise<SupplierBill> {
    if (actor.isInternal || actor.organizationType !== 'supplier' || !actor.roles.some((r) => SUPPLIER_BILLERS.includes(r))) throw new DomainError('NOT_AUTHORIZED', 403, 'Not permitted', `Requires one of: ${SUPPLIER_BILLERS.join(', ')}.`);
    const id = await this.executor.execute(
      {
        operation: 'finance.submit-supplier-bill',
        handler: async (tx, _ctx, cmd: SubmitSupplierBillRequest) => {
          const po = await this.repo.purchaseOrder(cmd.purchaseOrderId, tx);
          if (!po || po.supplierOrganizationId !== actor.organizationId) throw new DomainError('PURCHASE_ORDER_NOT_FOUND', 404, 'Purchase order not found');
          if (po.status !== 'acknowledged') throw new SettlementRefused('PURCHASE_ORDER_STATUS', `${po.number} is ${po.status}`, 'Bill a purchase order you have acknowledged.');
          if (cmd.documentVersionId && !(await this.repo.ownCleanVersion(cmd.documentVersionId, actor.organizationId!, tx))) throw new SettlementRefused('BILL_DOCUMENT_UNAVAILABLE', 'Upload the bill first', 'It must be your own file and scanned clean.', 422);
          const number = await this.repo.allocateNumber('SB', 'finance.supplier_bill', new Date(), tx);
          const billId = await this.repo.insertBill(
            { number, purchaseOrderId: po.id, supplierOrganizationId: po.supplierOrganizationId, supplierReference: cmd.supplierReference, billDate: cmd.billDate, currency: po.currency, quantity: cmd.quantity, taxableMinor: cmd.taxableMinor, taxMinor: cmd.taxMinor, documentVersionId: cmd.documentVersionId ?? null, by: actor.userId },
            tx,
          ).catch((err: unknown) => {
            if (err instanceof Error && /supplier_bill_supplier_organization_id_supplier_reference_key/.test(err.message)) throw new SettlementRefused('BILL_DUPLICATE', `You already submitted bill ${cmd.supplierReference}`);
            throw err;
          });
          const b = (await this.repo.findBill(billId, tx))!;
          return { result: billId, audit: [this.audit(b, 1, 'finance.supplier_bill_submitted', { purchaseOrder: po.number, supplierReference: cmd.supplierReference, totalMinor: b.totalMinor })], outbox: [this.event(b, 1, 'finance.supplier_bill_submitted.v1')] };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.get(actor, id);
  }

  // ----------------------------------------------------------------- finance matches

  async match(actor: Actor, billId: string, input: BillVersionRequest, opts: Opts = {}): Promise<SupplierBill> {
    this.requireFinance(actor);
    await this.executor.execute(
      {
        operation: 'finance.match-supplier-bill',
        handler: async (tx, ctx, cmd: BillVersionRequest) => {
          const b = await this.locked(billId, cmd.expectedVersion, tx);
          if (b.status !== 'submitted') throw new SettlementRefused('BILL_STATUS', `${b.number} is ${b.status.replace(/_/g, ' ')}`);
          const po = (await this.repo.purchaseOrder(b.purchaseOrderId, tx))!;
          const result = threeWayMatch({
            purchaseOrder: { number: po.number, quantity: po.quantity, totalMinor: po.totalMinor },
            acceptedQuantity: po.workPackageId ? await this.repo.acceptedQuantity(po.workPackageId, tx) : 0,
            billedBefore: await this.repo.billedBefore(po.id, b.id, tx),
            bill: { quantity: Number(b.quantity), taxableMinor: b.taxableMinor },
            tolerance: TOLERANCE,
          });
          if (!result.pass) {
            const version = await this.repo.updateBill(b.id, { status: 'match_exception', matchSnapshot: result }, tx);
            return { result: undefined, audit: [this.audit(b, version, 'finance.supplier_bill_match_exception', { reasons: result.reasons })], outbox: [this.event(b, version, 'finance.supplier_bill_match_exception.v1')] };
          }
          await this.repo.updateBill(b.id, { matchSnapshot: result }, tx);
          const payable = await this.postPayable(b, ctx.correlationId, tx);
          const version = await this.repo.updateBill(b.id, { status: 'matched', journalId: payable.journalId, decidedBy: actor.userId }, tx);
          return { result: undefined, audit: [this.audit(b, version, 'finance.supplier_bill_matched', { receiptValueMinor: result.receipt.valueMinor }), ...payable.audit], outbox: [this.event(b, version, 'finance.supplier_bill_matched.v1')] };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.get(actor, billId);
  }

  /** Doc 19 §7: a bill beyond the PO or the receipt goes to a second finance member, never adjusted silently. */
  async requestException(actor: Actor, billId: string, input: RequestBillExceptionRequest, opts: Opts = {}): Promise<SupplierBill> {
    this.requireFinance(actor);
    const policy = await this.commercial.activePolicy('bill_exception');
    if (!policy) throw new DomainError('POLICY_RULES_INVALID', 500, 'No active bill exception policy');
    await this.executor.execute(
      {
        operation: 'finance.request-bill-exception',
        handler: async (tx, _ctx, cmd: RequestBillExceptionRequest) => {
          const b = await this.locked(billId, cmd.expectedVersion, tx);
          if (b.status !== 'match_exception') throw new SettlementRefused('BILL_STATUS', 'Only a bill that failed its match goes to an exception');
          if (b.approvalRequestId) {
            const pending = await this.commercial.findApprovalRequest(b.approvalRequestId, tx);
            if (pending?.status === 'pending') throw new SettlementRefused('EXCEPTION_PENDING', 'An exception for this bill is already waiting');
          }
          const requestId = await this.commercial.createApprovalRequest(
            {
              kind: 'bill_exception',
              subjectType: 'supplier_bill',
              subjectId: b.id,
              subjectVersionNo: b.aggregateVersion,
              subjectHash: b.number,
              policyVersionId: policy.id,
              requestedBy: actor.userId,
              amountMinor: b.totalMinor,
              currency: b.currency,
              marginBp: null,
              context: { label: `Bill ${b.number} (${b.supplierReference}) on ${b.purchaseOrderNumber}`, billId: b.id, reasons: b.matchSnapshot?.reasons ?? [], justification: cmd.justification },
              requiredRoles: (policy.rules as { approverRoles?: string[] }).approverRoles ?? FINANCE,
            },
            tx,
          );
          const version = await this.repo.updateBill(b.id, { approvalRequestId: requestId }, tx);
          return { result: undefined, audit: [this.audit(b, version, 'finance.bill_exception_requested', { approvalRequestId: requestId }, cmd.justification)], outbox: [this.event(b, version, 'finance.bill_exception_requested.v1', { approvalRequestId: requestId })] };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.get(actor, billId);
  }

  /** The approval rail's decision: an approved exception posts the payable as matched would. */
  private async applyException(input: ApprovalEffectInput, tx: PoolClient): Promise<Record<string, unknown>> {
    const b = await this.repo.findBillByApproval(input.requestId, tx);
    if (!b) throw new DomainError('BILL_NOT_FOUND', 404, 'Bill not found');
    if (b.status !== 'match_exception') return { billId: b.id, unchanged: true };
    if (input.decision !== 'approved') {
      await this.repo.updateBill(b.id, { decisionNote: `Exception ${input.decision}.`, decidedBy: input.decidedBy }, tx);
      return { billId: b.id, decision: input.decision };
    }
    const payable = await this.postPayable(b, `approval:${input.requestId}`, tx);
    await this.repo.updateBill(b.id, { status: 'exception_approved', journalId: payable.journalId, decidedBy: input.decidedBy }, tx);
    return { billId: b.id, decision: 'approved', journalId: payable.journalId };
  }

  async reject(actor: Actor, billId: string, input: RejectBillRequest, opts: Opts = {}): Promise<SupplierBill> {
    this.requireFinance(actor);
    await this.executor.execute(
      {
        operation: 'finance.reject-supplier-bill',
        handler: async (tx, _ctx, cmd: RejectBillRequest) => {
          const b = await this.locked(billId, cmd.expectedVersion, tx);
          if (!['submitted', 'match_exception'].includes(b.status)) throw new SettlementRefused('BILL_STATUS', `${b.number} is ${b.status.replace(/_/g, ' ')}`);
          const version = await this.repo.updateBill(b.id, { status: 'rejected', decisionNote: cmd.reason, decidedBy: actor.userId }, tx);
          return { result: undefined, audit: [this.audit(b, version, 'finance.supplier_bill_rejected', {}, cmd.reason)], outbox: [this.event(b, version, 'finance.supplier_bill_rejected.v1')] };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.get(actor, billId);
  }

  // ----------------------------------------------------------------- settlement

  /** Recompute a settlement's eligibility from today's facts (doc 10 §5). */
  async recheck(actor: Actor, billId: string, opts: Opts = {}): Promise<SupplierBill> {
    this.requireFinance(actor);
    await this.executor.execute(
      {
        operation: 'finance.recheck-settlement',
        handler: async (tx) => {
          const b = await this.locked(billId, null, tx);
          const s = await this.repo.settlementForBill(b.id, tx, true);
          if (!s || s.status === 'paid' || s.status === 'scheduled') return { result: undefined, audit: [] };
          const eligibility = await this.eligibility(b, b.status, tx);
          const version = await this.repo.updateSettlement(s.id, { eligibility, status: eligibility.pass ? 'eligible' : 'held' }, tx);
          return { result: undefined, audit: [this.audit(b, b.aggregateVersion, 'finance.settlement_rechecked', { settlementVersion: version, pass: eligibility.pass, reasons: eligibility.reasons })] };
        },
      },
      contextFromActor(actor),
      { billId },
      opts,
    );
    return this.get(actor, billId);
  }

  async schedule(actor: Actor, billId: string, input: ScheduleSettlementRequest, opts: Opts = {}): Promise<SupplierBill> {
    this.requireFinance(actor);
    await this.executor.execute(
      {
        operation: 'finance.schedule-settlement',
        handler: async (tx, _ctx, cmd: ScheduleSettlementRequest) => {
          const b = await this.locked(billId, null, tx);
          const s = await this.repo.settlementForBill(b.id, tx, true);
          if (!s) throw new SettlementRefused('NO_SETTLEMENT', 'The bill is not matched yet');
          if (s.aggregateVersion !== cmd.expectedVersion) throw new DomainError('VERSION_CONFLICT', 409, 'The settlement moved on', 'Reload it and try again.');
          const eligibility = await this.eligibility(b, b.status, tx);
          if (!eligibility.pass) {
            await this.repo.updateSettlement(s.id, { eligibility, status: 'held' }, tx);
            throw new SettlementRefused('SETTLEMENT_HELD', 'Not eligible for payment', eligibility.reasons.join(' '));
          }
          const version = await this.repo.updateSettlement(s.id, { eligibility, status: 'scheduled', scheduledFor: cmd.scheduledFor }, tx);
          return { result: undefined, audit: [this.audit(b, b.aggregateVersion, 'finance.settlement_scheduled', { settlementVersion: version, scheduledFor: cmd.scheduledFor })] };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.get(actor, billId);
  }

  /** BR-FIN-04: paying the supplier settles the payable and nothing else; the customer's receivable is untouched. */
  async markPaid(actor: Actor, billId: string, input: MarkSettlementPaidRequest, opts: Opts = {}): Promise<SupplierBill> {
    this.requireFinance(actor);
    await this.executor.execute(
      {
        operation: 'finance.pay-settlement',
        handler: async (tx, ctx, cmd: MarkSettlementPaidRequest) => {
          const b = await this.locked(billId, null, tx);
          const s = await this.repo.settlementForBill(b.id, tx, true);
          if (!s || !['eligible', 'scheduled'].includes(s.status)) throw new SettlementRefused('SETTLEMENT_STATUS', 'Only an eligible or scheduled settlement is paid');
          if (s.aggregateVersion !== cmd.expectedVersion) throw new DomainError('VERSION_CONFLICT', 409, 'The settlement moved on', 'Reload it and try again.');
          const eligibility = await this.eligibility(b, b.status, tx);
          if (!eligibility.pass) {
            await this.repo.updateSettlement(s.id, { eligibility, status: 'held' }, tx);
            throw new SettlementRefused('SETTLEMENT_HELD', 'No longer eligible for payment', eligibility.reasons.join(' '));
          }
          const po = (await this.repo.purchaseOrder(b.purchaseOrderId, tx))!;
          const journalId = await this.finance.postJournal(
            {
              sourceType: 'settlement',
              sourceId: s.id,
              description: `Payment of ${b.number} (${b.supplierReference}), ${cmd.paymentReference}`,
              currency: b.currency,
              correlationId: ctx.correlationId,
              lines: [
                { account: 'supplier_payable', debitMinor: b.totalMinor, costObjectType: 'purchase_order', costObjectId: po.id },
                { account: 'bank', creditMinor: b.totalMinor },
              ],
            },
            tx,
          );
          const version = await this.repo.updateSettlement(s.id, { status: 'paid', eligibility, paymentReference: cmd.paymentReference, paidBy: actor.userId, journalId }, tx);
          const closed = await this.closure.closeIfDone(po.salesOrderId, `settlement of ${b.number} paid`, tx);
          return {
            result: undefined,
            audit: [this.audit(b, b.aggregateVersion, 'finance.settlement_paid', { settlementVersion: version, journalId, paymentReference: cmd.paymentReference, totalMinor: b.totalMinor }), ...closed],
            outbox: [this.event(b, b.aggregateVersion, 'finance.settlement_paid.v1', { supplierReference: b.supplierReference, purchaseOrderNumber: b.purchaseOrderNumber, paymentReference: cmd.paymentReference })],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.get(actor, billId);
  }

  // ----------------------------------------------------------------- reads

  /** `finance` is the JobWork route: it answers JobWork finance only, never a supplier (deny by default). */
  async list(actor: Actor, filter: { status?: SupplierBillStatus; purchaseOrderId?: string }, audience: 'supplier' | 'finance' = 'supplier'): Promise<SupplierBill[]> {
    if (actor.isInternal || audience === 'finance') this.requireFinance(actor);
    else if (actor.organizationType !== 'supplier' || !actor.roles.some((r) => SUPPLIER_BILLERS.includes(r))) throw new DomainError('NOT_AUTHORIZED', 403, 'Not permitted');
    const rows = await this.repo.listBills({ ...filter, ...(actor.isInternal ? {} : { supplierOrganizationId: actor.organizationId! }) });
    return Promise.all(rows.map((b) => this.view(actor, b)));
  }

  async get(actor: Actor, billId: string, audience: 'supplier' | 'finance' = 'supplier'): Promise<SupplierBill> {
    if (audience === 'finance' && !actor.isInternal) throw new DomainError('NOT_AUTHORIZED', 403, 'Not permitted', 'Requires jobwork_finance.');
    const b = await this.repo.findBill(billId);
    if (!b || (!actor.isInternal && b.supplierOrganizationId !== actor.organizationId)) throw new DomainError('BILL_NOT_FOUND', 404, 'Bill not found');
    if (actor.isInternal && !actor.roles.some((r) => FINANCE.includes(r))) throw new DomainError('NOT_AUTHORIZED', 403, 'Not permitted');
    return this.view(actor, b);
  }

  private async view(actor: Actor, b: BillRow): Promise<SupplierBill> {
    const s = await this.repo.settlementForBill(b.id);
    return {
      billId: b.id,
      number: b.number,
      purchaseOrderId: b.purchaseOrderId,
      purchaseOrderNumber: b.purchaseOrderNumber,
      supplierDisplayName: actor.isInternal ? b.supplierDisplayName : '',
      supplierReference: b.supplierReference,
      billDate: b.billDate,
      currency: b.currency,
      quantity: String(Number(b.quantity)),
      taxableMinor: b.taxableMinor,
      taxMinor: b.taxMinor,
      totalMinor: b.totalMinor,
      status: b.status,
      match: b.matchSnapshot,
      decisionNote: b.decisionNote,
      approvalRequestId: actor.isInternal ? b.approvalRequestId : null,
      submittedAt: b.submittedAt.toISOString(),
      settlement: s
        ? { settlementId: s.id, status: s.status, eligibility: s.eligibility, scheduledFor: s.scheduledFor, paidAt: s.paidAt ? s.paidAt.toISOString() : null, paymentReference: s.paymentReference, aggregateVersion: s.aggregateVersion }
        : null,
      aggregateVersion: b.aggregateVersion,
    };
  }
}
