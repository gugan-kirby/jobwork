import { Injectable } from '@nestjs/common';
import type {
  AcknowledgePurchaseOrderRequest,
  CreditProfile,
  IssueInstallmentInvoiceRequest,
  OrderVersionRequest,
  PlaceCreditHoldRequest,
  ReleaseCreditHoldRequest,
  SalesOrder,
  SalesOrderStatus,
  SetCreditProfileRequest,
  SupplierPurchaseOrder,
} from '@jobwork/contracts';
import { type Actor, IamRepository, requireOrganization, requireRole, requireTransactionalStrength } from '../../iam';
import { NotAuthorized } from '../../iam/domain/errors';
import {
  CommercialGateFailed,
  CreditHoldAlreadyReleased,
  CreditHoldNotFound,
  InstallmentNotFound,
  InstallmentNotIssuable,
  OrderNotFound,
  OrderNotInStatus,
  OrderVersionConflict,
  PurchaseOrderNotActionable,
  PurchaseOrderNotFound,
} from '../domain/errors';
import { FinanceRepository } from '../infrastructure/finance.repository';
import { OrdersRepository, type SalesOrderRecord } from '../infrastructure/orders.repository';
import { ProductionRepository } from '../infrastructure/production.repository';
import { MoneyFlow, sha256 } from './money-flow';
import { OrdersView } from './orders-view';
import { contextFromActor } from '../../../platform/commands/command';
import type { AuditSpec, OutboxSpec } from '../../../platform/commands/command';
import { CommandExecutor } from '../../../platform/commands/execute';
import { DomainError } from '../../../platform/http/domain-error';

export const ORDER_READ_ROLES = ['jobwork_sales', 'jobwork_sourcing', 'jobwork_finance', 'jobwork_engineering', 'jobwork_logistics'] as const;
const SUPPLIER_PO_ROLES = ['org_admin', 'supplier_estimator', 'supplier_production'];

type Opts = { idempotencyKey?: string | undefined };

/**
 * The internal order and credit commands, and the supplier's acknowledgment (IN-08).
 * Each is a named transition with a version guard; none is a generic status update.
 */
@Injectable()
export class OrderCommand {
  constructor(
    private readonly orders: OrdersRepository,
    private readonly finance: FinanceRepository,
    private readonly iam: IamRepository,
    private readonly money: MoneyFlow,
    private readonly view: OrdersView,
    private readonly executor: CommandExecutor,
    private readonly production: ProductionRepository,
  ) {}

  /** Whether JobWork has released this purchase order's work package to production. */
  private async workReleased(purchaseOrderId: string): Promise<boolean> {
    const id = await this.production.workPackageIdForPurchaseOrder(purchaseOrderId);
    const wp = id ? await this.production.findWorkPackage(id) : null;
    return Boolean(wp?.releasedAt);
  }

  private requireInternal(actor: Actor, ...roles: string[]): void {
    if (!actor.isInternal) throw new NotAuthorized('JobWork only');
    requireRole(actor, ...roles);
  }

  private async lockedOrder(orderId: string, expectedVersion: number, tx: Parameters<OrdersRepository['touchSalesOrder']>[1]): Promise<SalesOrderRecord> {
    const order = await this.orders.findSalesOrder(orderId, tx, true);
    if (!order) throw new OrderNotFound();
    if (order.aggregateVersion !== expectedVersion) throw new OrderVersionConflict(expectedVersion, order.aggregateVersion);
    return order;
  }

  // ----------------------------------------------------------------- reads

  async get(actor: Actor, orderId: string): Promise<SalesOrder> {
    this.requireInternal(actor, ...ORDER_READ_ROLES);
    const order = await this.orders.findSalesOrder(orderId);
    if (!order) throw new OrderNotFound();
    return this.view.salesOrder(order);
  }

  async list(actor: Actor, filter: { status?: SalesOrderStatus | undefined }, limit: number): Promise<SalesOrder[]> {
    this.requireInternal(actor, ...ORDER_READ_ROLES);
    const rows = await this.orders.listSalesOrders(filter, limit);
    return Promise.all(rows.map((row) => this.view.salesOrder(row)));
  }

  // ----------------------------------------------------------------- purchase orders (FR-502)

  /**
   * One purchase order per awarded supplier, a snapshot of the exact award lines and the
   * bid versions they came from. Born `pending_baseline`: no work may start against it
   * until the technical baseline is released and acknowledged (IN-09).
   */
  async issuePurchaseOrders(actor: Actor, orderId: string, input: OrderVersionRequest, opts: Opts = {}): Promise<SalesOrder> {
    this.requireInternal(actor, 'jobwork_sourcing');
    requireTransactionalStrength(actor);
    await this.executor.execute(
      {
        operation: 'orders.issue-purchase-orders',
        handler: async (tx, _ctx, cmd: OrderVersionRequest) => {
          const order = await this.lockedOrder(orderId, cmd.expectedVersion, tx);
          if (order.status === 'cancelled' || order.status === 'closed') throw new OrderNotInStatus(order.status, 'an open order');
          const award = await this.orders.awardForQuote(order.customerQuoteId, tx);
          if (!award) {
            throw new DomainError('AWARD_NOT_FOUND', 422, 'This order has no approved award behind it', 'Purchase orders follow an approved award; check the quotation’s cost sheet lineage.');
          }
          const existing = new Set((await this.orders.listPurchaseOrdersForSalesOrder(orderId, tx)).map((p) => p.supplierOrganizationId));
          const groups = (await this.orders.awardLinesBySupplier(award.awardId, tx)).filter((g) => !existing.has(g.supplierOrganizationId));
          if (groups.length === 0) throw new DomainError('PURCHASE_ORDERS_EXIST', 409, 'Every awarded supplier already has a purchase order');

          const now = new Date();
          const audit: AuditSpec[] = [];
          const outbox: OutboxSpec[] = [];
          for (const group of groups) {
            const number = await this.orders.allocateNumber('PO', now, tx);
            const lines = group.lines.map((line, i) => ({ ...line, lineNo: i + 1 }));
            const totalMinor = lines.reduce((sum, l) => sum + l.amountMinor, 0);
            const instructions = 'Work may not start until JobWork releases the technical baseline and the work package for this order. Quote the PO number on every delivery note and invoice.';
            const contentHash = sha256({ number, currency: order.currency, lines, totalMinor, leadTimeDays: group.leadTimeDays, paymentTerms: group.paymentTerms, instructions });
            const poId = await this.orders.createPurchaseOrder(
              {
                number,
                salesOrderId: orderId,
                awardId: award.awardId,
                supplierOrganizationId: group.supplierOrganizationId,
                supplierProfileId: group.supplierProfileId,
                currency: order.currency,
                totalMinor,
                leadTimeDays: group.leadTimeDays,
                paymentTerms: group.paymentTerms,
                instructions,
                contentHash,
                issuedBy: actor.userId,
                lines,
              },
              tx,
            );
            audit.push({ action: 'orders.purchase_order_issued', subjectType: 'purchase_order', subjectId: poId, subjectVersion: 1, data: { number, salesOrderId: orderId, awardId: award.awardId, supplierOrganizationId: group.supplierOrganizationId, totalMinor, contentHash } });
            outbox.push({ eventType: 'orders.purchase_order_issued.v1', aggregateType: 'purchase_order', aggregateId: poId, data: { purchaseOrderId: poId, number, supplierOrganizationId: group.supplierOrganizationId } });
          }
          await this.orders.touchSalesOrder(orderId, tx);
          return { result: undefined, audit, outbox };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.get(actor, orderId);
  }

  // ----------------------------------------------------------------- commercial release

  /** Explicit release (doc 06 §7) — e.g. once finance approves credit after acceptance. */
  async releaseCommercial(actor: Actor, orderId: string, input: OrderVersionRequest, opts: Opts = {}): Promise<SalesOrder> {
    this.requireInternal(actor, 'jobwork_finance');
    requireTransactionalStrength(actor);
    await this.executor.execute(
      {
        operation: 'orders.release-commercial',
        handler: async (tx, _ctx, cmd: OrderVersionRequest) => {
          const order = await this.lockedOrder(orderId, cmd.expectedVersion, tx);
          if (order.status !== 'pending_commercial_release') throw new OrderNotInStatus(order.status, 'pending_commercial_release');
          const release = await this.money.releaseIfGatePasses(orderId, tx, `released by ${actor.displayName}`);
          if (!release.released) throw new CommercialGateFailed(release.gate?.reasons ?? ['The gate could not be computed.']);
          return { result: undefined, audit: release.audit, outbox: release.outbox };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.get(actor, orderId);
  }

  // ----------------------------------------------------------------- balance invoice

  /**
   * Issue a pending instalment's invoice. In the full flow the balance falls due at the
   * dispatch gate (IN-17); until then finance issues it with this command.
   */
  async issueInstallmentInvoice(actor: Actor, orderId: string, input: IssueInstallmentInvoiceRequest, opts: Opts = {}): Promise<SalesOrder> {
    this.requireInternal(actor, 'jobwork_finance');
    requireTransactionalStrength(actor);
    const ctx = contextFromActor(actor);
    await this.executor.execute(
      {
        operation: 'finance.issue-installment-invoice',
        handler: async (tx, _ctx, cmd: IssueInstallmentInvoiceRequest) => {
          const order = await this.lockedOrder(orderId, cmd.expectedVersion, tx);
          if (order.status === 'cancelled') throw new OrderNotInStatus(order.status, 'an open order');
          const installment = (await this.finance.listInstallments(orderId, tx)).find((i) => i.id === cmd.installmentId);
          if (!installment) throw new InstallmentNotFound();
          if (installment.status !== 'pending') throw new InstallmentNotIssuable(installment.status);
          const issued = await this.money.issueInstallmentInvoice({ order, installment, issuedBy: actor.userId, correlationId: ctx.correlationId, now: new Date() }, tx);
          await this.orders.touchSalesOrder(orderId, tx);
          return { result: undefined, audit: issued.audit, outbox: issued.outbox };
        },
      },
      ctx,
      input,
      opts,
    );
    return this.get(actor, orderId);
  }

  // ----------------------------------------------------------------- supplier side

  private requireSupplier(actor: Actor): string {
    if (actor.organizationType !== 'supplier') throw new NotAuthorized('Supplier organizations only');
    requireRole(actor, ...SUPPLIER_PO_ROLES);
    return requireOrganization(actor);
  }

  async supplierList(actor: Actor): Promise<SupplierPurchaseOrder[]> {
    const organizationId = this.requireSupplier(actor);
    const rows = await this.orders.listPurchaseOrdersForSupplier(organizationId);
    return Promise.all(rows.map(async (row) => this.view.supplierPurchaseOrder(row, await this.workReleased(row.id))));
  }

  async supplierGet(actor: Actor, purchaseOrderId: string): Promise<SupplierPurchaseOrder> {
    const organizationId = this.requireSupplier(actor);
    const po = await this.orders.findPurchaseOrder(purchaseOrderId);
    // Not yours and does not exist are the same answer (doc 11 §5).
    if (!po || po.supplierOrganizationId !== organizationId) throw new PurchaseOrderNotFound();
    return this.view.supplierPurchaseOrder(po, await this.workReleased(po.id));
  }

  async acknowledge(actor: Actor, purchaseOrderId: string, input: AcknowledgePurchaseOrderRequest, opts: Opts = {}): Promise<SupplierPurchaseOrder> {
    const organizationId = this.requireSupplier(actor);
    await this.executor.execute(
      {
        operation: 'orders.acknowledge-purchase-order',
        handler: async (tx, _ctx, cmd: AcknowledgePurchaseOrderRequest) => {
          const po = await this.orders.findPurchaseOrder(purchaseOrderId, tx, true);
          if (!po || po.supplierOrganizationId !== organizationId) throw new PurchaseOrderNotFound();
          if (po.aggregateVersion !== cmd.expectedVersion) throw new OrderVersionConflict(cmd.expectedVersion, po.aggregateVersion);
          if (po.status !== 'issued') throw new PurchaseOrderNotActionable(po.status);
          await this.orders.acknowledgePurchaseOrder({ purchaseOrderId, by: actor.userId, note: cmd.note }, tx);
          return {
            result: undefined,
            audit: [{ action: 'orders.purchase_order_acknowledged', subjectType: 'purchase_order', subjectId: purchaseOrderId, subjectVersion: po.aggregateVersion + 1, data: { number: po.number, contentHash: po.contentHash, note: cmd.note } }],
            outbox: [{ eventType: 'orders.purchase_order_acknowledged.v1', aggregateType: 'purchase_order', aggregateId: purchaseOrderId, data: { purchaseOrderId, number: po.number, salesOrderId: po.salesOrderId } }],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.supplierGet(actor, purchaseOrderId);
  }

  // ----------------------------------------------------------------- credit (doc 10 §4)

  private async requireCustomerOrganization(organizationId: string): Promise<void> {
    const org = await this.iam.findOrganization(organizationId);
    if (!org || org.type !== 'customer') throw new DomainError('ORGANIZATION_NOT_FOUND', 404, 'Customer organization not found');
  }

  async getCredit(actor: Actor, organizationId: string): Promise<CreditProfile | null> {
    this.requireInternal(actor, 'jobwork_finance', 'jobwork_sales');
    await this.requireCustomerOrganization(organizationId);
    const [profile, holds, exposure] = await Promise.all([
      this.finance.findCreditProfile(organizationId),
      this.finance.listActiveHolds(organizationId),
      this.finance.openReceivables(organizationId, null),
    ]);
    if (!profile && holds.length === 0) return null;
    return {
      customerOrganizationId: organizationId,
      limitMinor: profile?.limitMinor ?? 0,
      currency: profile?.currency ?? 'INR',
      termsDays: profile?.termsDays ?? 0,
      approvedBy: profile?.approvedBy ?? '00000000-0000-0000-0000-000000000000',
      approvedAt: (profile?.approvedAt ?? new Date(0)).toISOString(),
      validUntil: profile?.validUntil ?? null,
      note: profile?.note ?? 'No approved credit terms.',
      exposureMinor: exposure,
      activeHolds: holds.map((h) => ({ holdId: h.id, reason: h.reason, placedAt: h.placedAt.toISOString(), placedBy: h.placedBy })),
    };
  }

  async setCredit(actor: Actor, organizationId: string, input: SetCreditProfileRequest, opts: Opts = {}): Promise<CreditProfile | null> {
    this.requireInternal(actor, 'jobwork_finance');
    requireTransactionalStrength(actor);
    await this.requireCustomerOrganization(organizationId);
    await this.executor.execute(
      {
        operation: 'finance.set-credit-profile',
        handler: async (tx, _ctx, cmd: SetCreditProfileRequest) => {
          const before = await this.finance.findCreditProfile(organizationId, tx);
          await this.finance.upsertCreditProfile(
            { customerOrganizationId: organizationId, limitMinor: cmd.limitMinor, currency: cmd.currency, termsDays: cmd.termsDays, approvedBy: actor.userId, validUntil: cmd.validUntil ?? null, note: cmd.note },
            tx,
          );
          return {
            result: undefined,
            audit: [{ action: 'finance.credit_profile_set', subjectType: 'organization', subjectId: organizationId, ...(cmd.note ? { reason: cmd.note } : {}), data: { limitMinor: cmd.limitMinor, currency: cmd.currency, termsDays: cmd.termsDays, validUntil: cmd.validUntil ?? null, previousLimitMinor: before?.limitMinor ?? null } }],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.getCredit(actor, organizationId);
  }

  async placeHold(actor: Actor, organizationId: string, input: PlaceCreditHoldRequest, opts: Opts = {}): Promise<CreditProfile | null> {
    this.requireInternal(actor, 'jobwork_finance');
    requireTransactionalStrength(actor);
    await this.requireCustomerOrganization(organizationId);
    await this.executor.execute(
      {
        operation: 'finance.place-credit-hold',
        handler: async (tx, _ctx, cmd: PlaceCreditHoldRequest) => {
          const holdId = await this.finance.createHold({ customerOrganizationId: organizationId, reason: cmd.reason, placedBy: actor.userId }, tx);
          return {
            result: undefined,
            audit: [{ action: 'finance.credit_hold_placed', subjectType: 'organization', subjectId: organizationId, reason: cmd.reason, data: { holdId } }],
            outbox: [{ eventType: 'finance.credit_hold_placed.v1', aggregateType: 'organization', aggregateId: organizationId, data: { holdId } }],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.getCredit(actor, organizationId);
  }

  async releaseHold(actor: Actor, organizationId: string, holdId: string, input: ReleaseCreditHoldRequest, opts: Opts = {}): Promise<CreditProfile | null> {
    this.requireInternal(actor, 'jobwork_finance');
    requireTransactionalStrength(actor);
    await this.executor.execute(
      {
        operation: 'finance.release-credit-hold',
        handler: async (tx, _ctx, cmd: ReleaseCreditHoldRequest) => {
          const hold = await this.finance.findHold(holdId, tx);
          if (!hold || hold.customerOrganizationId !== organizationId) throw new CreditHoldNotFound();
          if (hold.releasedAt) throw new CreditHoldAlreadyReleased();
          await this.finance.releaseHold({ holdId, releasedBy: actor.userId, reason: cmd.reason }, tx);
          return {
            result: undefined,
            audit: [{ action: 'finance.credit_hold_released', subjectType: 'organization', subjectId: organizationId, reason: cmd.reason, data: { holdId, placedBy: hold.placedBy } }],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.getCredit(actor, organizationId);
  }
}
