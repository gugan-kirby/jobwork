import { Injectable } from '@nestjs/common';
import type { CustomerDelivery, CustomerDeliveryStatus, CustomerOrderDocument, ShipmentStatus } from '@jobwork/contracts';
import type { Actor } from '../../iam';
import { FinanceRepository, OrdersRepository } from '../../orders';
import { ConformityView, type ConformitySummary, Rational } from '../../quality';
import { DomainError } from '../../../platform/http/domain-error';
import { LogisticsRepository, type ShipmentRow } from '../infrastructure/logistics.repository';
import { siteHash, snapshot } from './dispatch.command';

export const CUSTOMER_READERS = ['customer_requester', 'customer_approver', 'org_admin'];

const STATUS: Record<ShipmentStatus, CustomerDeliveryStatus> = {
  draft: 'preparing',
  planned: 'preparing',
  ready_for_release: 'preparing',
  released: 'ready_to_leave',
  picked_up: 'on_the_way',
  in_transit: 'on_the_way',
  delivered_to_destination: 'carrier_reports_delivered',
  receiving_check: 'awaiting_your_confirmation',
  discrepancy_hold: 'issue_reported',
  accepted: 'accepted',
  cancelled: 'preparing',
  refused: 'refused',
};

export const CUSTOMER_DELIVERY_LABEL: Record<CustomerDeliveryStatus, string> = {
  preparing: 'Being prepared',
  ready_to_leave: 'Packed, leaving soon',
  on_the_way: 'On the way',
  carrier_reports_delivered: 'Carrier reports delivered',
  awaiting_your_confirmation: 'Delivered: confirm receipt',
  issue_reported: 'Issue being handled',
  accepted: 'Accepted',
  refused: 'Refused at delivery',
};

const show = (s: string): string => Rational.parse(s).toDisplay(4);

/**
 * The customer's deliveries (IN-17; doc 06 §13; doc 03 §7 "customer cannot infer supplier identity
 * through labels, POD or API expansion fields"). Every field is chosen here, one by one, from the
 * shipment: the customer's own address, JobWork's carrier and documents, and JobWork's lot markings.
 * Nothing is spread from an internal shape, so nothing internal can ride along.
 */
@Injectable()
export class CustomerDeliveries {
  constructor(
    private readonly repo: LogisticsRepository,
    private readonly orders: OrdersRepository,
    private readonly finance: FinanceRepository,
    private readonly conformityView: ConformityView,
  ) {}

  /** A member of the consignee organization; "not yours" and "does not exist" are one answer (doc 11 §5). */
  requireCustomer(actor: Actor, s: ShipmentRow | null): ShipmentRow {
    if (!s || s.leg !== 'jobwork_to_customer' || actor.isInternal || actor.organizationType !== 'customer' || actor.organizationId !== s.consigneeOrganizationId || s.status === 'draft' || s.status === 'cancelled') {
      throw new DomainError('DELIVERY_NOT_FOUND', 404, 'Delivery not found');
    }
    if (!actor.roles.some((r) => CUSTOMER_READERS.includes(r))) throw new DomainError('NOT_AUTHORIZED', 403, 'Not permitted');
    return s;
  }

  async list(actor: Actor, salesOrderId: string): Promise<CustomerDelivery[]> {
    const order = await this.orders.findSalesOrder(salesOrderId);
    if (!order || actor.isInternal || actor.organizationId !== order.customerOrganizationId) throw new DomainError('ORDER_NOT_FOUND', 404, 'Order not found');
    if (!actor.roles.some((r) => CUSTOMER_READERS.includes(r))) throw new DomainError('NOT_AUTHORIZED', 403, 'Not permitted');
    const rows = await this.repo.customerDeliveries(order.customerOrganizationId, order.id);
    return Promise.all(rows.map((s) => this.project(s)));
  }

  /**
   * The order's documents for the customer's own record (IN-17 F-17.4): the quotation it accepted,
   * JobWork's invoices, and for each delivery that left, its delivery note, its POD and its
   * conformity certificate. Each is rendered on request from the customer's own projection.
   */
  async documents(actor: Actor, salesOrderId: string): Promise<CustomerOrderDocument[]> {
    const order = await this.orders.findSalesOrder(salesOrderId);
    if (!order || actor.isInternal || actor.organizationId !== order.customerOrganizationId) throw new DomainError('ORDER_NOT_FOUND', 404, 'Order not found');
    if (!actor.roles.some((r) => CUSTOMER_READERS.includes(r))) throw new DomainError('NOT_AUTHORIZED', 403, 'Not permitted');
    const out: CustomerOrderDocument[] = [
      { kind: 'quotation', title: `Quotation ${order.quoteReference ?? ''} v${order.acceptedQuoteVersionNo}`.trim(), reference: order.quoteReference ?? '', date: order.acceptance.acceptedAt.toISOString(), path: `/quotations/${order.customerQuoteId}/document` },
    ];
    for (const i of await this.finance.listInvoicesForOrder(order.id)) {
      if (i.status === 'void') continue;
      out.push({ kind: 'invoice', title: `Tax invoice ${i.number}`, reference: i.number, date: i.issuedAt.toISOString(), path: `/invoices/${i.id}/document` });
    }
    for (const s of await this.repo.customerDeliveries(order.customerOrganizationId, order.id)) {
      if (['planned', 'ready_for_release'].includes(s.status)) continue;
      out.push({ kind: 'delivery_note', title: `Delivery note ${s.number}`, reference: s.number, date: (s.pickedUpAt ?? s.releasedAt)?.toISOString() ?? null, path: `/deliveries/${s.id}/delivery-note` });
      out.push({ kind: 'conformity_certificate', title: `Certificate of conformance ${s.number}`, reference: s.number, date: s.releasedAt?.toISOString() ?? null, path: `/deliveries/${s.id}/conformity` });
      const pod = await this.repo.proofOfDelivery(s.id);
      if (pod) out.push({ kind: 'proof_of_delivery', title: `Proof of delivery ${s.number}`, reference: s.number, date: pod.receivedAt.toISOString(), path: `/deliveries/${s.id}/pod` });
    }
    return out;
  }

  /** The released quality record of what a delivery carries, by JobWork's markings (doc 03 §3). Once it has left, never before. */
  async conformity(s: ShipmentRow): Promise<ConformitySummary> {
    if (['planned', 'ready_for_release'].includes(s.status)) throw new DomainError('NOT_YET_RELEASED', 409, 'The certificate is issued when the delivery leaves JobWork');
    const lots = [];
    for (const item of await this.repo.items(s.id)) {
      const lot = item.stockLotId ? await this.repo.lotDetail(item.stockLotId) : null;
      if (lot?.workPackageId) lots.push({ workPackageId: lot.workPackageId, lotCode: lot.lotCode, marking: item.lotCode });
    }
    return this.conformityView.forLots(lots);
  }

  async get(actor: Actor, shipmentId: string): Promise<CustomerDelivery> {
    return this.project(this.requireCustomer(actor, await this.repo.find(shipmentId)));
  }

  /** The projection itself, also the only input the customer documents are rendered from. */
  async project(s: ShipmentRow): Promise<CustomerDelivery> {
    const order = (await this.orders.findSalesOrder(s.salesOrderId))!;
    const [packages, items, events] = [await this.repo.packages(s.id), await this.repo.items(s.id), await this.repo.carrierEvents(s.id)];
    const live = s.destinationSnapshot ? null : s.destinationSiteId ? await this.repo.site(s.destinationSiteId) : null;
    const destination = s.destinationSnapshot ?? (live ? snapshot(live) : null);
    const confirmation = await this.repo.latestAddressConfirmation(s.id);
    const [pod, acceptance, exceptions, policy] = [await this.repo.proofOfDelivery(s.id), await this.repo.acceptance(s.id), await this.repo.deliveryExceptions(s.id), await this.repo.acceptancePolicy()];
    const preparing = ['planned', 'ready_for_release'].includes(s.status);
    const now = Date.now();
    const inWindow = s.status === 'receiving_check' && (!s.acceptanceDueAt || now <= s.acceptanceDueAt.getTime());
    const current = Boolean(confirmation && live && confirmation.siteId === s.destinationSiteId && confirmation.snapshotHash === siteHash(live));
    const status = STATUS[s.status];
    return {
      shipmentId: s.id,
      number: s.number,
      orderId: order.id,
      orderNumber: order.number,
      status,
      statusLabel: CUSTOMER_DELIVERY_LABEL[status],
      destination,
      addressConfirmation: {
        needed: preparing && !current,
        confirmedAt: confirmation && (current || !preparing) ? confirmation.confirmedAt.toISOString() : null,
        byJobWork: confirmation?.party === 'jobwork',
      },
      carrier: { name: s.carrierName ?? '', trackingReference: s.trackingReference ?? '' },
      dispatchedAt: s.pickedUpAt ? s.pickedUpAt.toISOString() : null,
      packages: packages.map((p) => ({
        packageNo: p.packageNo,
        weightG: p.weightG,
        items: items
          .filter((i) => i.packageId === p.id)
          .map((i) => ({ lotMarking: i.lotCode, serials: [...i.serials], quantity: show(i.quantity), unit: i.unit, description: i.description })),
      })),
      totalQuantity: items.reduce((t, i) => t.add(Rational.parse(i.quantity)), Rational.of(0)).toDisplay(4),
      documents: { invoiceNumber: s.documents.invoiceNumber ?? '', eWaybillNumber: s.documents.eWaybillNumber ?? '' },
      tracking: events.map((e) => ({ status: e.normalizedStatus as CustomerDelivery['tracking'][number]['status'], occurredAt: e.occurredAt.toISOString() })),
      pod: pod
        ? { receivedByName: pod.receivedByName, receivedAt: pod.receivedAt.toISOString(), deliveredTo: snapshot(pod.deliveredTo), packagesReceived: pod.packagesReceived, remarks: pod.remarks, remarksNote: pod.remarksNote }
        : null,
      acceptance: acceptance ? { basis: acceptance.basis, acceptedAt: acceptance.acceptedAt.toISOString(), warrantyStatement: acceptance.warrantyStatement, note: acceptance.note } : null,
      acceptanceDueAt: s.acceptanceDueAt ? s.acceptanceDueAt.toISOString() : null,
      // JobWork's resolution and case reference are the customer's to see; its notes and the carrier's charges are not.
      exceptions: exceptions.map((x) => ({
        exceptionId: x.id,
        number: x.number,
        kind: x.kind,
        raisedByParty: x.raisedByParty,
        lotMarking: x.lotMarking,
        quantity: show(x.quantity),
        description: x.raisedByParty === 'customer' ? x.description : '',
        evidenceCount: x.evidence.length,
        warrantyClaim: x.warrantyClaim,
        requestedAddress: x.requestedSnapshot ? snapshot(x.requestedSnapshot) : null,
        status: x.status,
        resolution: x.resolution,
        resolutionNote: '',
        caseReference: x.caseReference,
        createdAt: x.createdAt.toISOString(),
        resolvedAt: x.resolvedAt ? x.resolvedAt.toISOString() : null,
      })),
      warrantyStatement: policy.warrantyStatement,
      actions: {
        confirmAddress: preparing && !current,
        accept: s.status === 'receiving_check',
        reportIssue: inWindow || s.status === 'discrepancy_hold',
        reportNotReceived: s.status === 'delivered_to_destination',
        reportDefect: s.status === 'accepted' || (s.status === 'receiving_check' && !inWindow),
        requestAddressChange: ['released', 'picked_up', 'in_transit'].includes(s.status) && !exceptions.some((x) => x.kind === 'address_change' && x.status === 'open'),
      },
      createdAt: s.createdAt.toISOString(),
      aggregateVersion: s.aggregateVersion,
    };
  }
}
