import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { AuditSpec } from '../../../platform/commands/command';
import { DomainError } from '../../../platform/http/domain-error';
import { holdsDelivery } from '../domain/delivery';
import { LogisticsRefused } from '../domain/shipment';
import { LogisticsRepository } from '../infrastructure/logistics.repository';
import { snapshot } from './dispatch.command';

/**
 * What a support case asks of logistics (IN-18 F-18.2; doc 10 §15; FR-906), run inside the case
 * command's transaction: take over delivery exceptions, lift their hold when the case closes, and move
 * goods on legs of their own — a customer's return onto the lots it left on, a return or rework to the
 * supplier out of JobWork's custody. The ledger records every piece; nothing is edited.
 */
@Injectable()
export class CaseLogistics {
  constructor(private readonly repo: LogisticsRepository) {}

  /** IN-17's exceptions handed to the case: resolved `handed_to_case`, holding until the case closes. */
  async handToCase(input: { exceptionIds: readonly string[]; caseId: string; caseNumber: string; salesOrderId: string; by: string }, tx: PoolClient): Promise<AuditSpec[]> {
    const audit: AuditSpec[] = [];
    for (const id of input.exceptionIds) {
      const x = await this.repo.findDeliveryException(id, tx, true);
      const s = x ? await this.repo.find(x.shipmentId, tx, true) : null;
      if (!x || !s || s.salesOrderId !== input.salesOrderId) throw new DomainError('EXCEPTION_NOT_FOUND', 404, 'A delivery exception is not on this order');
      if (x.status !== 'open') throw new LogisticsRefused('EXCEPTION_RESOLVED', `${x.number} is already resolved`);
      await this.repo.resolveDeliveryException(x.id, { resolution: 'handed_to_case', note: `Continued under ${input.caseNumber}.`, caseReference: input.caseNumber, carrierChargeNote: '', by: input.by, caseId: input.caseId }, tx);
      audit.push({ action: 'logistics.delivery_exception_resolved', subjectType: 'shipment', subjectId: s.id, data: { exception: x.number, kind: x.kind, resolution: 'handed_to_case', caseNumber: input.caseNumber } });
    }
    return audit;
  }

  /** When the case closes: each delivery it held waits for the customer's acceptance again. */
  async liftForCase(caseId: string, tx: PoolClient): Promise<AuditSpec[]> {
    const audit: AuditSpec[] = [];
    for (const shipmentId of await this.repo.shipmentsOfCase(caseId, tx)) {
      const s = await this.repo.find(shipmentId, tx, true);
      if (!s || s.status !== 'discrepancy_hold' || !(await this.repo.proofOfDelivery(s.id, tx))) continue;
      if ((await this.repo.deliveryExceptions(s.id, tx)).some((x) => holdsDelivery(x))) continue;
      const version = await this.repo.update(s.id, { status: 'receiving_check' }, tx);
      audit.push({ action: 'logistics.delivery_hold_lifted', subjectType: 'shipment', subjectId: s.id, subjectVersion: version, data: { number: s.number, caseId } });
    }
    return audit;
  }

  /** A delivered delivery coming back to JobWork: a return leg on the same lots, awaiting pickup. */
  async customerReturn(input: { shipmentId: string; salesOrderId: string; by: string }, tx: PoolClient): Promise<{ shipmentId: string; number: string; audit: AuditSpec[] }> {
    const s = await this.repo.find(input.shipmentId, tx, true);
    if (!s || s.leg !== 'jobwork_to_customer' || s.salesOrderId !== input.salesOrderId) throw new DomainError('SHIPMENT_NOT_FOUND', 404, 'Delivery not found on this order');
    if (!(await this.repo.proofOfDelivery(s.id, tx))) throw new LogisticsRefused('NOT_DELIVERED', 'Only a delivery that was handed over comes back on a return');
    if (await this.repo.returnLeg(s.id, tx)) throw new LogisticsRefused('RETURN_EXISTS', 'This delivery already has a return leg');
    const hub = (await this.repo.hubSite(tx))!;
    const number = await this.repo.allocateNumber('SH', 'shipment', new Date(), tx);
    const id = await this.repo.insert(
      { number, leg: 'customer_to_jobwork', salesOrderId: s.salesOrderId, workPackageId: null, purchaseOrderId: null, shipperOrganizationId: s.consigneeOrganizationId, consigneeOrganizationId: hub.organizationId, originSiteId: s.destinationSiteId, destinationSiteId: hub.id, documents: {}, by: input.by, returnsShipmentId: s.id },
      tx,
    );
    const packages = await this.repo.packages(s.id, tx);
    const items = await this.repo.items(s.id, tx);
    await this.repo.replaceContents(
      id,
      packages.map((p) => ({ packageNo: p.packageNo, lengthMm: p.lengthMm, widthMm: p.widthMm, heightMm: p.heightMm, weightG: p.weightG, items: items.filter((i) => i.packageId === p.id).map((i) => ({ lotCode: i.lotCode, serials: i.serials, quantity: i.quantity, unit: i.unit, description: i.description })) })),
      tx,
      packages.map((p) => items.filter((i) => i.packageId === p.id).map((i) => i.stockLotId)),
    );
    const hubSite = (await this.repo.site(hub.id, tx))!;
    await this.repo.update(id, { status: 'planned' }, tx);
    await this.repo.update(id, { status: 'ready_for_release' }, tx);
    const version = await this.repo.update(id, { status: 'released', originSnapshot: s.destinationSnapshot!, destinationSnapshot: snapshot(hubSite), releaseSnapshot: { returnOf: s.number, authorizedBy: input.by }, releasedBy: input.by, releasedAt: new Date() }, tx);
    return { shipmentId: id, number, audit: [{ action: 'logistics.return_authorized', subjectType: 'shipment', subjectId: id, subjectVersion: version, data: { number, returnOf: s.number } }] };
  }

  /** Stock out to the supplier on JobWork's challan: a return, or rework that comes back on its own leg. */
  async toSupplier(input: { purchaseOrderId: string; stockLotId: string; quantity: string; from: 'stock' | 'quarantine'; purpose: 'return' | 'rework'; challanNumber: string; by: string }, tx: PoolClient): Promise<{ shipmentId: string; number: string; audit: AuditSpec[] }> {
    const po = await this.repo.purchaseOrder(input.purchaseOrderId, tx);
    const lot = await this.repo.lotDetail(input.stockLotId, tx);
    if (!po || !lot || lot.ownership !== 'jobwork' || !po.workPackage || lot.workPackageId !== po.workPackage.id) throw new LogisticsRefused('LOT_NOT_OF_PO', 'Return only lots made on this purchase order', undefined, 422);
    if (!input.challanNumber) throw new LogisticsRefused('CHALLAN_REQUIRED', 'Give JobWork’s delivery challan number', undefined, 422);
    const from = input.from === 'stock' ? 'JW-STOCK' : 'JW-QUARANTINE';
    const destinationId = await this.repo.firstSite(po.supplierOrganizationId, true, tx);
    const hub = (await this.repo.hubSite(tx))!;
    if (!destinationId) throw new LogisticsRefused('DESTINATION_NOT_SUPPLIERS', 'The supplier has no active works address', undefined, 422);
    const number = await this.repo.allocateNumber('SH', 'shipment', new Date(), tx);
    const id = await this.repo.insert(
      { number, leg: 'jobwork_to_supplier', salesOrderId: po.salesOrderId, workPackageId: po.workPackage.id, purchaseOrderId: po.id, shipperOrganizationId: hub.organizationId, consigneeOrganizationId: po.supplierOrganizationId, originSiteId: hub.id, destinationSiteId: destinationId, documents: { challanNumber: input.challanNumber }, by: input.by },
      tx,
    );
    await this.repo.replaceContents(id, [{ packageNo: 1, lengthMm: null, widthMm: null, heightMm: null, weightG: null, items: [{ lotCode: lot.lotCode, serials: [], quantity: input.quantity, unit: lot.unit, description: input.purpose === 'rework' ? 'Parts for rework' : 'Parts returned' }] }], tx, [[lot.id]]);
    await this.repo.update(id, { status: 'planned' }, tx);
    await this.repo.update(id, { status: 'ready_for_release' }, tx);
    const version = await this.repo.update(id, { status: 'released', originSnapshot: snapshot((await this.repo.site(hub.id, tx))!), destinationSnapshot: snapshot((await this.repo.site(destinationId, tx))!), releaseSnapshot: { purpose: input.purpose, authorizedBy: input.by }, releasedBy: input.by, releasedAt: new Date() }, tx);
    // The ledger refuses a draw beyond what the location holds (BR-LOG-02).
    await this.repo.move({ lotId: lot.id, from, to: input.purpose === 'rework' ? 'OUT-REWORK' : 'OUT-RETURNED', quantity: input.quantity, type: input.purpose === 'rework' ? 'rework_out' : 'return', source: 'support.execute-resolution-action', evidence: { shipment: number, purpose: input.purpose }, by: input.by }, tx);
    return { shipmentId: id, number, audit: [{ action: 'logistics.supplier_return_released', subjectType: 'shipment', subjectId: id, subjectVersion: version, data: { number, purpose: input.purpose, lot: lot.lotCode, quantity: input.quantity } }] };
  }
}
