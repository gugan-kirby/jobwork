import { Injectable } from '@nestjs/common';
import type { AcknowledgeMaterialRequest, IssueMaterialRequest, MaterialLot, RegisterCustomerMaterialRequest, Shipment } from '@jobwork/contracts';
import type { Actor } from '../../iam';
import { OrdersRepository } from '../../orders';
import { Rational } from '../../quality';
import { contextFromActor, type AuditSpec, type OutboxSpec } from '../../../platform/commands/command';
import { CommandExecutor } from '../../../platform/commands/execute';
import { DomainError } from '../../../platform/http/domain-error';
import { LogisticsRefused } from '../domain/shipment';
import { LogisticsRepository } from '../infrastructure/logistics.repository';
import { LOGISTICS, requireJobWork, requireLogisticsReader } from './access';
import { DispatchCommand, snapshot } from './dispatch.command';

type Opts = { idempotencyKey?: string | undefined };

const show = (s: string): string => Rational.parse(s).toDisplay(4);
const SUPPLIER_RECEIVERS = ['supplier_production', 'org_admin'];


/**
 * Customer-supplied material (IN-16 F-16.5; `D-15`; `FR-307`). The customer's material comes to
 * JobWork as an inbound leg and is received like any other, onto lots the customer owns. JobWork
 * then issues it to the supplier on a leg of its own, under JobWork's challan: the supplier deals
 * with JobWork and never learns whose material it is. Every quantity stays in the custody ledger.
 */
@Injectable()
export class MaterialCommand {
  constructor(
    private readonly repo: LogisticsRepository,
    private readonly orders: OrdersRepository,
    private readonly dispatch: DispatchCommand,
    private readonly executor: CommandExecutor,
  ) {}

  private audit(s: { id: string; number: string }, version: number, action: string, data: Record<string, unknown> = {}): AuditSpec {
    return { action, subjectType: 'shipment', subjectId: s.id, subjectVersion: version, data: { number: s.number, ...data } };
  }

  private event(s: { id: string; number: string; leg: string; salesOrderId: string }, version: number, type: string, data: Record<string, unknown> = {}): OutboxSpec {
    return {
      eventType: type,
      aggregateType: 'shipment',
      aggregateId: s.id,
      aggregateVersion: version,
      data: { shipmentId: s.id, number: s.number, leg: s.leg, salesOrderId: s.salesOrderId, ...data },
    };
  }

  /** The customer's material, announced or at the door: an inbound leg ready for receiving. */
  async registerCustomerMaterial(actor: Actor, input: RegisterCustomerMaterialRequest, opts: Opts = {}): Promise<Shipment> {
    requireJobWork(actor, LOGISTICS);
    const id = await this.executor.execute(
      {
        operation: 'logistics.register-customer-material',
        handler: async (tx, _ctx, cmd: RegisterCustomerMaterialRequest) => {
          const order = await this.orders.findSalesOrder(cmd.salesOrderId, tx);
          if (!order) throw new DomainError('SALES_ORDER_NOT_FOUND', 404, 'Sales order not found');
          if (order.status === 'cancelled' || order.status === 'closed') throw new LogisticsRefused('ORDER_CLOSED', `${order.number} is ${order.status}`);
          const originSiteId = cmd.originSiteId ?? order.deliverySiteId ?? (await this.repo.firstSite(order.customerOrganizationId, false, tx));
          const origin = originSiteId ? await this.repo.site(originSiteId, tx) : null;
          if (!origin || origin.organizationId !== order.customerOrganizationId || origin.status !== 'active') throw new LogisticsRefused('ORIGIN_NOT_CUSTOMERS', 'Choose one of the customer’s active addresses', undefined, 422);
          if (!cmd.documents.challanNumber && !cmd.documents.invoiceNumber) throw new LogisticsRefused('CHALLAN_REQUIRED', 'Record the customer’s delivery challan number', 'Material sent for job work travels on the principal’s challan.', 422);
          const hub = await this.repo.hubSite(tx);
          if (!hub) throw new LogisticsRefused('HUB_MISSING', 'JobWork’s receiving hub has no active works address');
          const destination = (await this.repo.site(hub.id, tx))!;
          const number = await this.repo.allocateNumber('SH', 'shipment', new Date(), tx);
          const shipmentId = await this.repo.insert(
            { number, leg: 'customer_to_jobwork', salesOrderId: order.id, workPackageId: null, purchaseOrderId: null, shipperOrganizationId: order.customerOrganizationId, consigneeOrganizationId: hub.organizationId, originSiteId: origin.id, destinationSiteId: hub.id, documents: cmd.documents, by: actor.userId },
            tx,
          );
          await this.repo.replaceContents(shipmentId, cmd.packages, tx);
          // The customer's dispatch needs no release by JobWork: it is on its way, or already here.
          await this.repo.update(shipmentId, { status: 'planned' }, tx);
          await this.repo.update(shipmentId, { status: 'ready_for_release' }, tx);
          await this.repo.update(shipmentId, { status: 'released', originSnapshot: snapshot(origin), destinationSnapshot: snapshot(destination), releaseSnapshot: { registeredBy: actor.userId, customerChallan: cmd.documents.challanNumber }, releasedBy: actor.userId, releasedAt: new Date() }, tx);
          const version = await this.repo.update(shipmentId, { status: 'picked_up', carrierMode: cmd.carrierMode, carrierName: cmd.carrierName, trackingReference: cmd.trackingReference, pickedUpAt: new Date() }, tx);
          const s = { id: shipmentId, number, leg: 'customer_to_jobwork', salesOrderId: order.id };
          return {
            result: shipmentId,
            audit: [this.audit(s, version, 'logistics.customer_material_registered', { salesOrder: order.number, customerChallan: cmd.documents.challanNumber, packages: cmd.packages.length })],
            outbox: [this.event(s, version, 'logistics.customer_material_registered.v1')],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.dispatch.get(actor, id);
  }

  /** The customer's material on an order, and where it is (JobWork only). */
  async materialLots(actor: Actor, salesOrderId: string): Promise<MaterialLot[]> {
    requireLogisticsReader(actor);
    return (await this.repo.materialLots(salesOrderId)).map((l) => ({
      lotId: l.id,
      lotCode: l.lotCode,
      unit: l.unit,
      sourceShipmentNumber: l.shipmentNumber,
      receivedQuantity: show(l.receivedQuantity),
      inStock: show(l.inStock),
      quarantined: show(l.quarantined),
      issued: show(l.issued),
    }));
  }

  /**
   * Issue customer material to the supplier on JobWork's challan. It leaves JobWork's custody when
   * released, so the ledger moves it to `OUT-ISSUED` then; the supplier confirms it arrived.
   */
  async issueToSupplier(actor: Actor, input: IssueMaterialRequest, opts: Opts = {}): Promise<Shipment> {
    requireJobWork(actor, LOGISTICS);
    const id = await this.executor.execute(
      {
        operation: 'logistics.issue-material',
        handler: async (tx, _ctx, cmd: IssueMaterialRequest) => {
          const po = await this.repo.purchaseOrder(cmd.purchaseOrderId, tx);
          if (!po) throw new DomainError('PURCHASE_ORDER_NOT_FOUND', 404, 'Purchase order not found');
          if (po.status !== 'acknowledged') throw new LogisticsRefused('PURCHASE_ORDER_STATUS', `${po.number} is ${po.status}: issue material once the supplier has acknowledged it`);
          if (!cmd.documents.challanNumber) throw new LogisticsRefused('CHALLAN_REQUIRED', 'Give JobWork’s delivery challan number', 'Material sent for job work travels on a challan.', 422);
          const destinationSiteId = cmd.destinationSiteId ?? (await this.repo.firstSite(po.supplierOrganizationId, true, tx));
          const destination = destinationSiteId ? await this.repo.site(destinationSiteId, tx) : null;
          if (!destination || destination.organizationId !== po.supplierOrganizationId || !['works', 'pickup'].includes(destination.kind) || destination.status !== 'active') {
            throw new LogisticsRefused('DESTINATION_NOT_SUPPLIERS', 'Choose one of the supplier’s active works addresses', undefined, 422);
          }
          const hub = await this.repo.hubSite(tx);
          if (!hub) throw new LogisticsRefused('HUB_MISSING', 'JobWork’s receiving hub has no active works address');
          const origin = (await this.repo.site(hub.id, tx))!;
          const picks: Array<{ lotId: string; lotCode: string; unit: string; quantity: string }> = [];
          for (const want of cmd.lots) {
            const lot = await this.repo.lot(want.lotId, tx);
            if (!lot || lot.ownership !== 'customer_material' || lot.salesOrderId !== po.salesOrderId) throw new LogisticsRefused('LOT_NOT_ORDER_MATERIAL', 'Issue only the customer’s material for this order', undefined, 422);
            const held = Rational.parse(await this.repo.balance(lot.id, 'JW-STOCK', tx));
            if (Rational.parse(want.quantity).compare(held) > 0) throw new LogisticsRefused('NOT_IN_STOCK', `${lot.lotCode || 'The lot'}: ${show(want.quantity)} ${lot.unit} asked, ${held.toDisplay(4)} in stock`, 'Quarantined material is not issued until quality releases it.', 422);
            picks.push({ lotId: lot.id, lotCode: lot.lotCode, unit: lot.unit, quantity: want.quantity });
          }
          const number = await this.repo.allocateNumber('SH', 'shipment', new Date(), tx);
          const shipmentId = await this.repo.insert(
            { number, leg: 'jobwork_to_supplier', salesOrderId: po.salesOrderId, workPackageId: po.workPackage?.id ?? null, purchaseOrderId: po.id, shipperOrganizationId: hub.organizationId, consigneeOrganizationId: po.supplierOrganizationId, originSiteId: hub.id, destinationSiteId: destination.id, documents: cmd.documents, by: actor.userId },
            tx,
          );
          await this.repo.replaceContents(
            shipmentId,
            [{ packageNo: 1, lengthMm: null, widthMm: null, heightMm: null, weightG: null, items: picks.map((p) => ({ lotCode: p.lotCode, serials: [], quantity: p.quantity, unit: p.unit, description: 'Material for the job' })) }],
            tx,
            [picks.map((p) => p.lotId)],
          );
          await this.repo.update(shipmentId, { status: 'planned' }, tx);
          await this.repo.update(shipmentId, { status: 'ready_for_release' }, tx);
          const version = await this.repo.update(shipmentId, { status: 'released', originSnapshot: snapshot(origin), destinationSnapshot: snapshot(destination), releaseSnapshot: { issuedBy: actor.userId, lots: picks }, releasedBy: actor.userId, releasedAt: new Date() }, tx);
          for (const p of picks) {
            await this.repo.move({ lotId: p.lotId, from: 'JW-STOCK', to: 'OUT-ISSUED', quantity: p.quantity, type: 'issue', source: 'logistics.issue-material', evidence: { shipment: number, purchaseOrder: po.number }, by: actor.userId }, tx);
          }
          const s = { id: shipmentId, number, leg: 'jobwork_to_supplier', salesOrderId: po.salesOrderId };
          return {
            result: shipmentId,
            audit: [this.audit(s, version, 'logistics.material_issued', { purchaseOrder: po.number, challan: cmd.documents.challanNumber, lots: picks.map((p) => ({ lot: p.lotCode, quantity: show(p.quantity), unit: p.unit })) })],
            outbox: [this.event(s, version, 'logistics.material_issued.v1', { consigneeOrganizationId: po.supplierOrganizationId, purchaseOrderNumber: po.number })],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.dispatch.get(actor, id);
  }

  /** The supplier confirms the material JobWork issued has arrived. */
  async acknowledge(actor: Actor, shipmentId: string, input: AcknowledgeMaterialRequest, opts: Opts = {}): Promise<Shipment> {
    await this.executor.execute(
      {
        operation: 'logistics.acknowledge-material',
        handler: async (tx, _ctx, cmd: AcknowledgeMaterialRequest) => {
          const s = await this.repo.find(shipmentId, tx, true);
          if (!s || s.leg !== 'jobwork_to_supplier' || actor.isInternal || actor.organizationId !== s.consigneeOrganizationId) throw new DomainError('SHIPMENT_NOT_FOUND', 404, 'Shipment not found');
          if (!actor.roles.some((r) => SUPPLIER_RECEIVERS.includes(r))) throw new DomainError('NOT_AUTHORIZED', 403, 'Not permitted', `Requires one of: ${SUPPLIER_RECEIVERS.join(', ')}.`);
          if (s.aggregateVersion !== cmd.expectedVersion) throw new DomainError('VERSION_CONFLICT', 409, 'The shipment moved on', 'Reload it and try again.');
          if (!['picked_up', 'in_transit', 'delivered_to_destination'].includes(s.status)) throw new LogisticsRefused('SHIPMENT_STATUS', 'Only material on its way is confirmed', `It is ${s.status.replace(/_/g, ' ')}.`);
          await this.repo.update(s.id, { status: 'receiving_check' }, tx);
          const version = await this.repo.update(s.id, { status: 'accepted' }, tx);
          return {
            result: undefined,
            audit: [this.audit(s, version, 'logistics.material_receipt_acknowledged', { note: cmd.note })],
            outbox: [this.event(s, version, 'logistics.material_receipt_acknowledged.v1')],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.dispatch.get(actor, shipmentId);
  }
}
