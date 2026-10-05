import { Injectable } from '@nestjs/common';
import type { CustomerDelivery, CustomerDeliveryStatus, ShipmentStatus } from '@jobwork/contracts';
import type { Actor } from '../../iam';
import { OrdersRepository } from '../../orders';
import { Rational } from '../../quality';
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
    const preparing = ['planned', 'ready_for_release'].includes(s.status);
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
      createdAt: s.createdAt.toISOString(),
      aggregateVersion: s.aggregateVersion,
    };
  }
}
