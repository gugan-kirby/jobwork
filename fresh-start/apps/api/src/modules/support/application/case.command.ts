import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type {
  AddCaseEventRequest,
  CaseReasonRequest,
  CaseStatus,
  CaseVersionRequest,
  CustomerCase,
  ExecuteActionRequest,
  OpenCaseRequest,
  ProposeResolutionRequest,
  ResolutionActionKind,
  SupportCase,
  VerifyActionRequest,
} from '@jobwork/contracts';
import { ApprovalEffectRegistry, CommercialRepository, type ApprovalEffectInput } from '../../commercial';
import { type Actor, requireTransactionalStrength } from '../../iam';
import { CaseLogistics } from '../../logistics';
import { CustomerRemedy, OrderClosure, OrdersRepository } from '../../orders';
import { type CommandContext, contextFromActor, type AuditSpec, type OutboxSpec } from '../../../platform/commands/command';
import { CommandExecutor } from '../../../platform/commands/execute';
import { DomainError } from '../../../platform/http/domain-error';
import { type ActionRow, type CaseRow, SupportRepository } from '../infrastructure/support.repository';

type Opts = { idempotencyKey?: string | undefined };

const SUPPORT = ['jobwork_support'];
const OPENERS = ['jobwork_support', 'jobwork_sales'];
const CUSTOMER = ['customer_requester', 'customer_approver', 'org_admin'];
const MONEY: readonly ResolutionActionKind[] = ['credit_note', 'refund', 'supplier_recovery'];
const PHYSICAL: readonly ResolutionActionKind[] = ['return_to_jobwork', 'return_to_supplier', 'rework'];
/** Who carries out each kind of action: the module that owns it (doc 06 §15). */
const EXECUTORS = (kind: ResolutionActionKind): string[] => (MONEY.includes(kind) ? ['jobwork_finance'] : PHYSICAL.includes(kind) ? ['jobwork_logistics'] : ['jobwork_support']);
const VERIFIERS = ['jobwork_support', 'jobwork_quality', 'jobwork_finance'];

export const CASE_STATUS_LABEL: Record<CaseStatus, string> = {
  open: 'Received',
  triage: 'Being looked at',
  investigating: 'Being investigated',
  resolution_proposed: 'Resolution proposed',
  resolution_approved: 'Resolution agreed',
  executing: 'Being put right',
  verifying: 'Being checked',
  closed: 'Closed',
  rejected: 'Not accepted',
  withdrawn: 'Withdrawn',
};
/** Statuses the customer is told about. */
const TELL_CUSTOMER: readonly CaseStatus[] = ['triage', 'resolution_approved', 'closed', 'rejected'];

class CaseRefused extends DomainError {
  constructor(code: string, title: string, detail?: string, status = 409) {
    super(code, status, title, detail);
  }
}

/**
 * Support cases (IN-18 F-18.2; UC-34; doc 06 §15; doc 10 §15; FR-906). A case gathers what went
 * wrong with an order — delivery issues handed over from IN-17, a warranty claim, a dispute — and
 * resolves it through actions each carried out by the module that owns it: finance credits or refunds
 * the customer and books what the supplier owes; logistics brings goods back or sends them for rework.
 * Another person verifies each action, and the case closes only when every one is verified, lifting
 * the delivery holds it carried. Physical, quality, customer and supplier remedies stay separate records.
 */
@Injectable()
export class CaseCommand {
  constructor(
    private readonly repo: SupportRepository,
    private readonly orders: OrdersRepository,
    private readonly remedy: CustomerRemedy,
    private readonly closure: OrderClosure,
    private readonly logistics: CaseLogistics,
    private readonly commercial: CommercialRepository,
    private readonly executor: CommandExecutor,
    effects: ApprovalEffectRegistry,
  ) {
    effects.register('case_resolution', (input, tx) => this.applyResolution(input, tx));
  }

  // ----------------------------------------------------------------- helpers

  private audit(c: { id: string; number: string }, version: number, action: string, data: Record<string, unknown> = {}, reason?: string): AuditSpec {
    return { action, subjectType: 'case', subjectId: c.id, subjectVersion: version, ...(reason ? { reason } : {}), data: { number: c.number, ...data } };
  }

  private updated(c: CaseRow, version: number, status: CaseStatus): OutboxSpec[] {
    if (!TELL_CUSTOMER.includes(status)) return [];
    return [{ eventType: 'support.case_updated.v1', aggregateType: 'case', aggregateId: c.id, aggregateVersion: version, data: { caseId: c.id, number: c.number, status, statusLabel: CASE_STATUS_LABEL[status], customerOrganizationId: c.customerOrganizationId, orderNumber: c.orderNumber } }];
  }

  private requireJobWork(actor: Actor, roles: readonly string[]): void {
    if (!actor.isInternal || !actor.roles.some((r) => roles.includes(r))) throw new DomainError('NOT_AUTHORIZED', 403, 'Not permitted', `Requires ${roles.join(' or ')}.`);
    requireTransactionalStrength(actor);
  }

  private requireCustomerOf(actor: Actor, c: CaseRow | null): CaseRow {
    if (!c || actor.isInternal || actor.organizationId !== c.customerOrganizationId) throw new DomainError('CASE_NOT_FOUND', 404, 'Case not found');
    if (!actor.roles.some((r) => CUSTOMER.includes(r))) throw new DomainError('NOT_AUTHORIZED', 403, 'Not permitted');
    return c;
  }

  private async locked(id: string, expectedVersion: number | null, tx: PoolClient): Promise<CaseRow> {
    const c = await this.repo.find(id, tx, true);
    if (!c) throw new DomainError('CASE_NOT_FOUND', 404, 'Case not found');
    if (expectedVersion !== null && c.aggregateVersion !== expectedVersion) throw new DomainError('VERSION_CONFLICT', 409, 'The case moved on', 'Reload it and try again.');
    return c;
  }

  private move(c: CaseRow, from: readonly CaseStatus[], to: CaseStatus): void {
    if (!from.includes(c.status)) throw new CaseRefused('CASE_STATUS', `${c.number} is ${CASE_STATUS_LABEL[c.status].toLowerCase()}`, `This needs it to be ${from.map((s) => CASE_STATUS_LABEL[s].toLowerCase()).join(' or ')}.`);
    void to;
  }

  // ----------------------------------------------------------------- opening

  async open(actor: Actor, input: OpenCaseRequest, opts: Opts = {}): Promise<{ caseId: string }> {
    if (actor.isInternal) this.requireJobWork(actor, OPENERS);
    else if (!actor.roles.some((r) => CUSTOMER.includes(r))) throw new DomainError('NOT_AUTHORIZED', 403, 'Not permitted');
    const caseId = await this.executor.execute(
      {
        operation: 'support.open-case',
        handler: async (tx, _ctx, cmd: OpenCaseRequest) => {
          const order = await this.orders.findSalesOrder(cmd.salesOrderId, tx);
          if (!order || (!actor.isInternal && order.customerOrganizationId !== actor.organizationId)) throw new DomainError('ORDER_NOT_FOUND', 404, 'Order not found');
          if (!actor.isInternal && (cmd.deliveryExceptionIds.length > 0 || cmd.purchaseOrderId)) throw new DomainError('NOT_AUTHORIZED', 403, 'Not permitted', 'JobWork links exceptions and purchase orders.');
          if (cmd.purchaseOrderId && !(await this.orders.findPurchaseOrder(cmd.purchaseOrderId, tx))) throw new DomainError('PURCHASE_ORDER_NOT_FOUND', 404, 'Purchase order not found');
          for (const id of cmd.evidenceDocumentVersionIds) {
            if (!(await this.repo.ownCleanVersion(id, actor.organizationId!, tx))) throw new CaseRefused('EVIDENCE_UNAVAILABLE', 'Upload the files first', 'Each must be your own file and scanned clean.', 422);
          }
          const number = await this.repo.allocateNumber(new Date(), tx);
          const party = actor.isInternal ? 'jobwork' : 'customer';
          const id = await this.repo.insertCase({ number, kind: cmd.kind, salesOrderId: order.id, customerOrganizationId: order.customerOrganizationId, shipmentId: cmd.shipmentId ?? null, purchaseOrderId: cmd.purchaseOrderId ?? null, title: cmd.title, description: cmd.description, by: actor.userId, party }, tx);
          await this.repo.addEvent({ caseId: id, audience: 'customer', kind: 'opened', note: cmd.description, evidence: cmd.evidenceDocumentVersionIds, by: actor.userId, party }, tx);
          const linked = await this.logistics.handToCase({ exceptionIds: cmd.deliveryExceptionIds, caseId: id, caseNumber: number, salesOrderId: order.id, by: actor.userId }, tx);
          return {
            result: id,
            audit: [this.audit({ id, number }, 1, 'support.case_opened', { kind: cmd.kind, order: order.number, party, exceptions: cmd.deliveryExceptionIds.length }), ...linked],
            outbox: [{ eventType: 'support.case_opened.v1', aggregateType: 'case', aggregateId: id, aggregateVersion: 1, data: { caseId: id, number, kind: cmd.kind, salesOrderId: order.id } }],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return { caseId };
  }

  // ----------------------------------------------------------------- triage and investigation

  private async step(actor: Actor, caseId: string, input: CaseVersionRequest, operation: string, from: readonly CaseStatus[], to: CaseStatus, opts: Opts, owner = false): Promise<void> {
    this.requireJobWork(actor, SUPPORT);
    await this.executor.execute(
      {
        operation,
        handler: async (tx, _ctx, cmd: CaseVersionRequest) => {
          const c = await this.locked(caseId, cmd.expectedVersion, tx);
          this.move(c, from, to);
          const version = await this.repo.update(c.id, { status: to, ...(owner ? { ownerId: actor.userId } : {}) }, tx);
          await this.repo.addEvent({ caseId: c.id, audience: 'internal', kind: to, note: '', evidence: [], by: actor.userId, party: 'jobwork' }, tx);
          return { result: undefined, audit: [this.audit(c, version, `support.case_${to}`, { from: c.status })], outbox: this.updated(c, version, to) };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
  }

  async triage(actor: Actor, caseId: string, input: CaseVersionRequest, opts: Opts = {}): Promise<SupportCase> {
    await this.step(actor, caseId, input, 'support.triage-case', ['open'], 'triage', opts, true);
    return this.get(actor, caseId);
  }

  async investigate(actor: Actor, caseId: string, input: CaseVersionRequest, opts: Opts = {}): Promise<SupportCase> {
    await this.step(actor, caseId, input, 'support.investigate-case', ['triage'], 'investigating', opts);
    return this.get(actor, caseId);
  }

  async reject(actor: Actor, caseId: string, input: CaseReasonRequest, opts: Opts = {}): Promise<SupportCase> {
    this.requireJobWork(actor, SUPPORT);
    await this.executor.execute(
      {
        operation: 'support.reject-case',
        handler: async (tx, _ctx, cmd: CaseReasonRequest) => {
          const c = await this.locked(caseId, cmd.expectedVersion, tx);
          this.move(c, ['open', 'triage'], 'rejected');
          const version = await this.repo.update(c.id, { status: 'rejected', closeNote: cmd.reason, closed: true }, tx);
          await this.repo.addEvent({ caseId: c.id, audience: 'customer', kind: 'rejected', note: cmd.reason, evidence: [], by: actor.userId, party: 'jobwork' }, tx);
          const lifted = await this.logistics.liftForCase(c.id, tx);
          return { result: undefined, audit: [this.audit(c, version, 'support.case_rejected', {}, cmd.reason), ...lifted], outbox: this.updated(c, version, 'rejected') };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.get(actor, caseId);
  }

  /** The customer takes back its own case before JobWork has started on it. */
  async withdraw(actor: Actor, caseId: string, input: CaseReasonRequest, opts: Opts = {}): Promise<CustomerCase> {
    await this.executor.execute(
      {
        operation: 'support.withdraw-case',
        handler: async (tx, _ctx, cmd: CaseReasonRequest) => {
          const c = this.requireCustomerOf(actor, await this.repo.find(caseId, tx, true));
          if (c.aggregateVersion !== cmd.expectedVersion) throw new DomainError('VERSION_CONFLICT', 409, 'The case moved on', 'Reload it and try again.');
          if (c.openedByParty !== 'customer') throw new CaseRefused('NOT_YOURS', 'JobWork opened this case');
          this.move(c, ['open', 'triage'], 'withdrawn');
          const version = await this.repo.update(c.id, { status: 'withdrawn', closeNote: cmd.reason, closed: true }, tx);
          await this.repo.addEvent({ caseId: c.id, audience: 'customer', kind: 'withdrawn', note: cmd.reason, evidence: [], by: actor.userId, party: 'customer' }, tx);
          const lifted = await this.logistics.liftForCase(c.id, tx);
          return { result: undefined, audit: [this.audit(c, version, 'support.case_withdrawn', {}, cmd.reason), ...lifted], outbox: [] };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.customerGet(actor, caseId);
  }

  async addEvent(actor: Actor, caseId: string, input: AddCaseEventRequest, opts: Opts = {}): Promise<void> {
    if (actor.isInternal) this.requireJobWork(actor, [...SUPPORT, 'jobwork_sales', 'jobwork_quality', 'jobwork_logistics', 'jobwork_finance']);
    await this.executor.execute(
      {
        operation: 'support.add-case-event',
        handler: async (tx, _ctx, cmd: AddCaseEventRequest) => {
          const c = actor.isInternal ? await this.locked(caseId, null, tx) : this.requireCustomerOf(actor, await this.repo.find(caseId, tx, true));
          if (['closed', 'rejected', 'withdrawn'].includes(c.status)) throw new CaseRefused('CASE_CLOSED', `${c.number} is ${CASE_STATUS_LABEL[c.status].toLowerCase()}`);
          for (const id of cmd.evidenceDocumentVersionIds) {
            if (!(await this.repo.ownCleanVersion(id, actor.organizationId!, tx))) throw new CaseRefused('EVIDENCE_UNAVAILABLE', 'Upload the files first', undefined, 422);
          }
          const audience = actor.isInternal ? cmd.audience : 'customer';
          await this.repo.addEvent({ caseId: c.id, audience, kind: 'note', note: cmd.note, evidence: cmd.evidenceDocumentVersionIds, by: actor.userId, party: actor.isInternal ? 'jobwork' : 'customer' }, tx);
          const version = await this.repo.update(c.id, {}, tx);
          return { result: undefined, audit: [this.audit(c, version, 'support.case_note_added', { audience, evidence: cmd.evidenceDocumentVersionIds.length })] };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
  }

  // ----------------------------------------------------------------- resolution

  /** Support proposes what will put it right; finance decides money, quality decides the rest. */
  async propose(actor: Actor, caseId: string, input: ProposeResolutionRequest, opts: Opts = {}): Promise<SupportCase> {
    this.requireJobWork(actor, SUPPORT);
    const policy = await this.commercial.activePolicy('case_resolution');
    if (!policy) throw new DomainError('POLICY_RULES_INVALID', 500, 'No active case resolution policy');
    const rules = policy.rules as { moneyRoles?: string[]; physicalRoles?: string[] };
    await this.executor.execute(
      {
        operation: 'support.propose-resolution',
        handler: async (tx, _ctx, cmd: ProposeResolutionRequest) => {
          const c = await this.locked(caseId, cmd.expectedVersion, tx);
          this.move(c, ['investigating'], 'resolution_proposed');
          for (const a of cmd.actions) {
            if (MONEY.includes(a.kind) && !a.amountMinor) throw new CaseRefused('AMOUNT_REQUIRED', `Give the amount of the ${a.kind.replace(/_/g, ' ')}`, undefined, 422);
            if ((a.kind === 'return_to_supplier' || a.kind === 'rework') && (!a.stockLotId || !a.quantity)) throw new CaseRefused('LOT_REQUIRED', 'Name the stock lot and quantity that go back', undefined, 422);
          }
          await this.repo.replacePlanned(c.id, cmd.actions.map((a) => ({ kind: a.kind, description: a.description, amountMinor: a.amountMinor ?? null, quantity: a.quantity ?? null, stockLotId: a.stockLotId ?? null })), tx);
          const money = cmd.actions.some((a) => MONEY.includes(a.kind));
          const total = cmd.actions.reduce((t, a) => t + (a.amountMinor ?? 0), 0);
          const order = (await this.orders.findSalesOrder(c.salesOrderId, tx))!;
          const requestId = await this.commercial.createApprovalRequest(
            {
              kind: 'case_resolution',
              subjectType: 'case',
              subjectId: c.id,
              subjectVersionNo: c.aggregateVersion,
              subjectHash: c.number,
              policyVersionId: policy.id,
              requestedBy: actor.userId,
              amountMinor: money ? total : null,
              currency: money ? order.currency : null,
              marginBp: null,
              context: { label: `Resolution of ${c.number}: ${c.title}`, caseId: c.id, actions: cmd.actions.map((a) => `${a.kind.replace(/_/g, ' ')}: ${a.description}`) },
              requiredRoles: money ? (rules.moneyRoles ?? ['jobwork_finance']) : (rules.physicalRoles ?? ['jobwork_quality']),
            },
            tx,
          );
          const version = await this.repo.update(c.id, { status: 'resolution_proposed', approvalRequestId: requestId }, tx);
          await this.repo.addEvent({ caseId: c.id, audience: 'internal', kind: 'resolution_proposed', note: cmd.actions.map((a) => a.description).join('; '), evidence: [], by: actor.userId, party: 'jobwork' }, tx);
          return {
            result: undefined,
            audit: [this.audit(c, version, 'support.resolution_proposed', { actions: cmd.actions.map((a) => a.kind), approvalRequestId: requestId, amountMinor: total })],
            outbox: [{ eventType: 'support.resolution_proposed.v1', aggregateType: 'case', aggregateId: c.id, aggregateVersion: version, data: { caseId: c.id, number: c.number, approvalRequestId: requestId } }],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.get(actor, caseId);
  }

  private async applyResolution(input: ApprovalEffectInput, tx: PoolClient): Promise<Record<string, unknown>> {
    const c = await this.repo.findByApproval(input.requestId, tx);
    if (!c) throw new DomainError('CASE_NOT_FOUND', 404, 'Case not found');
    if (c.status !== 'resolution_proposed') return { caseId: c.id, unchanged: true };
    const to: CaseStatus = input.decision === 'approved' ? 'resolution_approved' : 'investigating';
    await this.repo.update(c.id, { status: to }, tx);
    await this.repo.addEvent({ caseId: c.id, audience: input.decision === 'approved' ? 'customer' : 'internal', kind: to, note: input.decision === 'approved' ? 'JobWork has agreed how to put this right.' : 'The proposal was sent back.', evidence: [], by: input.decidedBy, party: 'system' }, tx);
    return { caseId: c.id, status: to };
  }

  /** The owning module carries out one action; the case moves to verification when none is left to do. */
  async execute(actor: Actor, actionId: string, input: ExecuteActionRequest, opts: Opts = {}): Promise<SupportCase> {
    const caseId = await this.executor.execute(
      {
        operation: 'support.execute-resolution-action',
        handler: async (tx, ctx: CommandContext, cmd: ExecuteActionRequest) => {
          const found = await this.repo.findAction(actionId, tx);
          if (!found) throw new DomainError('ACTION_NOT_FOUND', 404, 'Action not found');
          this.requireJobWork(actor, EXECUTORS(found.kind));
          const c = await this.locked(found.caseId, null, tx);
          this.move(c, ['resolution_approved', 'executing'], 'executing');
          if (found.status !== 'planned') throw new CaseRefused('ACTION_STATUS', 'This action was already carried out or cancelled');
          const order = (await this.orders.findSalesOrder(c.salesOrderId, tx))!;
          const audit: AuditSpec[] = [];
          const outbox: OutboxSpec[] = [];
          let result: Record<string, unknown> = { note: cmd.note, reference: cmd.reference };
          switch (found.kind) {
            case 'credit_note': {
              if (!cmd.invoiceId) throw new CaseRefused('INVOICE_REQUIRED', 'Choose the invoice the credit note corrects', undefined, 422);
              const done = await this.remedy.creditNote({ salesOrderId: c.salesOrderId, invoiceId: cmd.invoiceId, totalMinor: found.amountMinor!, reason: found.description, caseId: c.id, by: actor.userId, correlationId: ctx.correlationId }, tx);
              audit.push(...done.audit);
              outbox.push(...done.outbox);
              result = { ...result, creditNoteId: done.creditNoteId, creditNoteNumber: done.number };
              break;
            }
            case 'refund': {
              if (cmd.reference.length < 3) throw new CaseRefused('REFERENCE_REQUIRED', 'Give the bank reference of the refund', undefined, 422);
              const done = await this.remedy.refund({ salesOrderId: c.salesOrderId, currency: order.currency, amountMinor: found.amountMinor!, reference: cmd.reference, caseId: c.id, correlationId: ctx.correlationId }, tx);
              audit.push(...done.audit);
              outbox.push(...done.outbox);
              result = { ...result, journalId: done.journalId };
              break;
            }
            case 'supplier_recovery': {
              const done = await this.remedy.recovery({ salesOrderId: c.salesOrderId, purchaseOrderId: c.purchaseOrderId, currency: order.currency, amountMinor: found.amountMinor!, reference: cmd.reference, caseId: c.id, correlationId: ctx.correlationId }, tx);
              audit.push(...done.audit);
              result = { ...result, journalId: done.journalId };
              break;
            }
            case 'return_to_jobwork': {
              const shipmentId = cmd.shipmentId ?? c.shipmentId;
              if (!shipmentId) throw new CaseRefused('SHIPMENT_REQUIRED', 'Name the delivery that comes back', undefined, 422);
              const done = await this.logistics.customerReturn({ shipmentId, salesOrderId: c.salesOrderId, by: actor.userId }, tx);
              audit.push(...done.audit);
              result = { ...result, shipmentId: done.shipmentId, shipmentNumber: done.number };
              break;
            }
            case 'return_to_supplier':
            case 'rework': {
              const purchaseOrderId = cmd.purchaseOrderId ?? c.purchaseOrderId;
              if (!purchaseOrderId) throw new CaseRefused('PURCHASE_ORDER_REQUIRED', 'Name the purchase order it goes back on', undefined, 422);
              const done = await this.logistics.toSupplier({ purchaseOrderId, stockLotId: found.stockLotId!, quantity: found.quantity!, from: cmd.from, purpose: found.kind === 'rework' ? 'rework' : 'return', challanNumber: cmd.challanNumber, by: actor.userId }, tx);
              audit.push(...done.audit);
              result = { ...result, shipmentId: done.shipmentId, shipmentNumber: done.number };
              break;
            }
            default:
              if (cmd.note.length < 3 && cmd.reference.length < 3) throw new CaseRefused('NOTE_REQUIRED', 'Say what was done, or give its reference', undefined, 422);
          }
          await this.repo.markAction(found.id, { status: 'done', result, by: actor.userId }, tx);
          const actions = await this.repo.actions(c.id, tx);
          const to: CaseStatus = actions.every((a) => a.status !== 'planned') ? 'verifying' : 'executing';
          if (c.status === 'resolution_approved' && to === 'verifying') await this.repo.update(c.id, { status: 'executing' }, tx);
          const version = await this.repo.update(c.id, to !== c.status ? { status: to } : {}, tx);
          await this.repo.addEvent({ caseId: c.id, audience: 'internal', kind: 'action_done', note: `${found.kind.replace(/_/g, ' ')} done${cmd.note ? `: ${cmd.note}` : ''}`, evidence: [], by: actor.userId, party: 'jobwork' }, tx);
          return { result: c.id, audit: [this.audit(c, version, 'support.resolution_action_done', { action: found.seq, kind: found.kind, result }), ...audit], outbox };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.get(actor, caseId);
  }

  /** Someone other than who carried it out confirms it happened (doc 06 §15 "verifying"). */
  async verify(actor: Actor, actionId: string, input: VerifyActionRequest, opts: Opts = {}): Promise<SupportCase> {
    this.requireJobWork(actor, VERIFIERS);
    const caseId = await this.executor.execute(
      {
        operation: 'support.verify-resolution-action',
        handler: async (tx, _ctx, cmd: VerifyActionRequest) => {
          const found = await this.repo.findAction(actionId, tx);
          if (!found) throw new DomainError('ACTION_NOT_FOUND', 404, 'Action not found');
          const c = await this.locked(found.caseId, null, tx);
          if (found.status !== 'done') throw new CaseRefused('ACTION_STATUS', 'Only an action carried out is verified');
          if (found.doneBy === actor.userId) throw new CaseRefused('VERIFIER_SEPARATION', 'Someone else verifies what you carried out', undefined, 403);
          await this.repo.markAction(found.id, { status: 'verified', by: actor.userId }, tx);
          const version = await this.repo.update(c.id, {}, tx);
          await this.repo.addEvent({ caseId: c.id, audience: 'internal', kind: 'action_verified', note: cmd.note, evidence: [], by: actor.userId, party: 'jobwork' }, tx);
          return { result: c.id, audit: [this.audit(c, version, 'support.resolution_action_verified', { action: found.seq, kind: found.kind }, cmd.note)] };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.get(actor, caseId);
  }

  async cancelAction(actor: Actor, actionId: string, input: VerifyActionRequest, opts: Opts = {}): Promise<SupportCase> {
    this.requireJobWork(actor, SUPPORT);
    const caseId = await this.executor.execute(
      {
        operation: 'support.cancel-resolution-action',
        handler: async (tx, _ctx, cmd: VerifyActionRequest) => {
          const found = await this.repo.findAction(actionId, tx);
          if (!found) throw new DomainError('ACTION_NOT_FOUND', 404, 'Action not found');
          const c = await this.locked(found.caseId, null, tx);
          if (found.status !== 'planned') throw new CaseRefused('ACTION_STATUS', 'Only an action not yet carried out is cancelled');
          await this.repo.markAction(found.id, { status: 'cancelled', by: actor.userId }, tx);
          const actions = await this.repo.actions(c.id, tx);
          const allDone = actions.every((a) => a.status !== 'planned');
          const version = await this.repo.update(c.id, allDone && c.status === 'executing' ? { status: 'verifying' } : {}, tx);
          return { result: c.id, audit: [this.audit(c, version, 'support.resolution_action_cancelled', { action: found.seq, kind: found.kind }, cmd.note)] };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.get(actor, caseId);
  }

  /** Every action verified or cancelled (the database checks it too); delivery holds lift; the order may close. */
  async close(actor: Actor, caseId: string, input: CaseReasonRequest, opts: Opts = {}): Promise<SupportCase> {
    this.requireJobWork(actor, SUPPORT);
    await this.executor.execute(
      {
        operation: 'support.close-case',
        handler: async (tx, _ctx, cmd: CaseReasonRequest) => {
          const c = await this.locked(caseId, cmd.expectedVersion, tx);
          this.move(c, ['verifying'], 'closed');
          const open = (await this.repo.actions(c.id, tx)).filter((a: ActionRow) => !['verified', 'cancelled'].includes(a.status));
          if (open.length > 0) throw new CaseRefused('ACTIONS_UNVERIFIED', 'Every action is verified before the case closes', open.map((a) => `${a.seq}. ${a.kind.replace(/_/g, ' ')}`).join(', '));
          const version = await this.repo.update(c.id, { status: 'closed', closeNote: cmd.reason, closed: true }, tx);
          await this.repo.addEvent({ caseId: c.id, audience: 'customer', kind: 'closed', note: cmd.reason, evidence: [], by: actor.userId, party: 'jobwork' }, tx);
          const lifted = await this.logistics.liftForCase(c.id, tx);
          const closed = await this.closure.closeIfDone(c.salesOrderId, `case ${c.number} closed`, tx);
          return { result: undefined, audit: [this.audit(c, version, 'support.case_closed', {}, cmd.reason), ...lifted, ...closed], outbox: this.updated(c, version, 'closed') };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.get(actor, caseId);
  }

  // ----------------------------------------------------------------- reads

  async list(actor: Actor, filter: { salesOrderId?: string; open?: boolean }): Promise<SupportCase[]> {
    this.requireJobWork(actor, [...SUPPORT, 'jobwork_sales', 'jobwork_quality', 'jobwork_logistics', 'jobwork_finance']);
    return Promise.all((await this.repo.list(filter)).map((c) => this.view(c)));
  }

  async get(actor: Actor, caseId: string): Promise<SupportCase> {
    if (!actor.isInternal || !actor.roles.some((r) => [...SUPPORT, 'jobwork_sales', 'jobwork_quality', 'jobwork_logistics', 'jobwork_finance'].includes(r))) throw new DomainError('NOT_AUTHORIZED', 403, 'Not permitted');
    const c = await this.repo.find(caseId);
    if (!c) throw new DomainError('CASE_NOT_FOUND', 404, 'Case not found');
    return this.view(c);
  }

  private async view(c: CaseRow): Promise<SupportCase> {
    const [events, actions, linked] = [await this.repo.events(c.id, false), await this.repo.actions(c.id), await this.repo.linkedExceptions(c.id)];
    return {
      caseId: c.id,
      number: c.number,
      kind: c.kind,
      status: c.status,
      statusLabel: CASE_STATUS_LABEL[c.status],
      salesOrderId: c.salesOrderId,
      orderNumber: c.orderNumber,
      customerDisplayName: c.customerDisplayName,
      shipmentId: c.shipmentId,
      shipmentNumber: c.shipmentNumber,
      purchaseOrderId: c.purchaseOrderId,
      title: c.title,
      description: c.description,
      openedByParty: c.openedByParty,
      approvalRequestId: c.approvalRequestId,
      events: events.map((e) => ({ kind: e.kind, note: e.note, audience: e.audience, authorParty: e.authorParty, evidenceCount: e.evidence.length, createdAt: e.createdAt.toISOString() })),
      actions: actions.map((a) => ({ actionId: a.id, seq: a.seq, kind: a.kind, description: a.description, amountMinor: a.amountMinor, quantity: a.quantity, status: a.status, result: a.result, doneAt: a.doneAt ? a.doneAt.toISOString() : null, verifiedAt: a.verifiedAt ? a.verifiedAt.toISOString() : null })),
      linkedExceptions: linked,
      createdAt: c.createdAt.toISOString(),
      closedAt: c.closedAt ? c.closedAt.toISOString() : null,
      aggregateVersion: c.aggregateVersion,
    };
  }

  /** The customer's cases, built field by field: no supplier, no purchase order, no internal note. */
  async customerList(actor: Actor, salesOrderId?: string): Promise<CustomerCase[]> {
    if (actor.isInternal || !actor.organizationId || !actor.roles.some((r) => CUSTOMER.includes(r))) throw new DomainError('NOT_AUTHORIZED', 403, 'Not permitted');
    return Promise.all((await this.repo.list({ customerOrganizationId: actor.organizationId, ...(salesOrderId ? { salesOrderId } : {}) })).map((c) => this.customerView(c)));
  }

  async customerGet(actor: Actor, caseId: string): Promise<CustomerCase> {
    return this.customerView(this.requireCustomerOf(actor, await this.repo.find(caseId)));
  }

  private async customerView(c: CaseRow): Promise<CustomerCase> {
    const [events, actions] = [await this.repo.events(c.id, true), await this.repo.actions(c.id)];
    return {
      caseId: c.id,
      number: c.number,
      kind: c.kind,
      status: c.status,
      statusLabel: CASE_STATUS_LABEL[c.status],
      orderId: c.salesOrderId,
      orderNumber: c.orderNumber,
      shipmentNumber: c.shipmentNumber,
      title: c.title,
      description: c.description,
      events: events.map((e) => ({ kind: e.kind, note: e.note, authorParty: e.authorParty, evidenceCount: e.evidence.length, createdAt: e.createdAt.toISOString() })),
      // A recovery from the supplier is JobWork's business, not the customer's.
      remedies: ['resolution_approved', 'executing', 'verifying', 'closed'].includes(c.status)
        ? actions.filter((a) => a.kind !== 'supplier_recovery' && a.status !== 'cancelled').map((a) => ({ kind: a.kind, description: a.description, amountMinor: a.kind === 'credit_note' || a.kind === 'refund' ? a.amountMinor : null, status: a.status }))
        : [],
      canWithdraw: c.openedByParty === 'customer' && (c.status === 'open' || c.status === 'triage'),
      createdAt: c.createdAt.toISOString(),
      closedAt: c.closedAt ? c.closedAt.toISOString() : null,
      aggregateVersion: c.aggregateVersion,
    };
  }
}
