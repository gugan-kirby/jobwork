import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type {
  AcceptDeliveryRequest,
  CustomerDelivery,
  DeliveryExceptionKind,
  RecordPodRequest,
  RecordRefusalRequest,
  ReportDeliveryIssueRequest,
  RequestAddressChangeRequest,
  ResolveDeliveryExceptionRequest,
  Shipment,
  ShipmentStatus,
  SiteSnapshot,
  WithdrawDeliveryIssueRequest,
} from '@jobwork/contracts';
import type { Actor } from '../../iam';
import { DispatchFinance, OrdersRepository } from '../../orders';
import { Rational } from '../../quality';
import { type CommandContext, contextFromActor, contextFromService, type AuditSpec, type OutboxSpec } from '../../../platform/commands/command';
import { CommandExecutor } from '../../../platform/commands/execute';
import { DomainError } from '../../../platform/http/domain-error';
import { acceptanceDueAt, holdsDelivery, issueAllowed, RESOLUTIONS, resolverRoles } from '../domain/delivery';
import { LogisticsRefused } from '../domain/shipment';
import { LogisticsRepository, type DeliveryExceptionRow, type ShipmentRow } from '../infrastructure/logistics.repository';
import { LOGISTICS, requireJobWork } from './access';
import { CustomerDeliveries } from './customer-deliveries';
import { DispatchCommand, snapshot } from './dispatch.command';

type Opts = { idempotencyKey?: string | undefined };

const q = (s: string): Rational => Rational.parse(s);
/** Doc 03: the customer approver decides deliveries; an organization's admin may too. */
const ACCEPTORS = ['customer_approver', 'org_admin'];
/** Anyone at the customer who receives goods may say what arrived. */
const REPORTERS = ['customer_requester', 'customer_approver', 'org_admin'];
const ADDRESS_CHANGERS = ['jobwork_sales', 'jobwork_logistics'];
const ON_THE_WAY: readonly ShipmentStatus[] = ['picked_up', 'in_transit', 'delivered_to_destination'];

export const EXCEPTION_LABEL: Record<DeliveryExceptionKind, string> = {
  address_change: 'an address change',
  refused: 'a refused delivery',
  not_received: 'a delivery not received',
  shortage: 'a shortage',
  damage: 'damage',
  wrong_item: 'a wrong item',
  quality_defect: 'a defect',
  documents: 'a documents problem',
};

/**
 * Leg 2's delivery (IN-17 F-17.3; doc 06 §11; doc 10 §§11, 15; BR-LOG-05; FR-905; UC-09). The POD
 * records the handover and opens the customer's window; only the customer's acceptance, or the
 * window running out, accepts the delivery. A report inside the window holds it; a defect found
 * after acceptance is a warranty claim. A refusal ends the leg and a return leg brings the goods
 * back; an address change is an exception beside a shipment whose own address never changes.
 */
@Injectable()
export class DeliveryCommand {
  constructor(
    private readonly repo: LogisticsRepository,
    private readonly orders: OrdersRepository,
    private readonly finance: DispatchFinance,
    private readonly deliveries: CustomerDeliveries,
    private readonly dispatch: DispatchCommand,
    private readonly executor: CommandExecutor,
  ) {}

  // ----------------------------------------------------------------- helpers

  private audit(s: { id: string; number: string }, version: number, action: string, data: Record<string, unknown> = {}, reason?: string): AuditSpec {
    return { action, subjectType: 'shipment', subjectId: s.id, subjectVersion: version, ...(reason ? { reason } : {}), data: { number: s.number, ...data } };
  }

  private event(s: ShipmentRow, version: number, type: string, data: Record<string, unknown> = {}): OutboxSpec {
    return {
      eventType: type,
      aggregateType: 'shipment',
      aggregateId: s.id,
      aggregateVersion: version,
      data: { shipmentId: s.id, number: s.number, leg: s.leg, salesOrderId: s.salesOrderId, customerOrganizationId: s.consigneeOrganizationId, ...data },
    };
  }

  private async legTwo(id: string, tx: PoolClient, expectedVersion: number | null = null): Promise<ShipmentRow> {
    const s = await this.repo.find(id, tx, true);
    if (!s || s.leg !== 'jobwork_to_customer') throw new DomainError('SHIPMENT_NOT_FOUND', 404, 'Shipment not found');
    if (expectedVersion !== null && s.aggregateVersion !== expectedVersion) throw new DomainError('VERSION_CONFLICT', 409, 'The delivery moved on', 'Reload it and try again.');
    return s;
  }

  private customerOf(actor: Actor, s: ShipmentRow, roles: readonly string[]): void {
    this.deliveries.requireCustomer(actor, s);
    if (!actor.roles.some((r) => roles.includes(r))) throw new DomainError('NOT_AUTHORIZED', 403, 'Not permitted', `Requires one of: ${roles.join(', ')}.`);
  }

  private async exceptionNumber(tx: PoolClient): Promise<string> {
    return this.repo.allocateNumber('DX', 'delivery_exception', new Date(), tx);
  }

  private exceptionEvent(s: ShipmentRow, version: number, number: string, kind: DeliveryExceptionKind): OutboxSpec {
    return this.event(s, version, 'logistics.delivery_exception_opened.v1', { exceptionNumber: number, kind, exceptionLabel: EXCEPTION_LABEL[kind] });
  }

  /** Whether anything still holds the delivery (doc 19 §8). */
  private async held(shipmentId: string, tx: PoolClient): Promise<boolean> {
    return (await this.repo.deliveryExceptions(shipmentId, tx)).some((x) => holdsDelivery(x));
  }

  /** Doc 06 §7: `delivered` once everything ordered has a POD; `customer_accepted` once everything ordered is accepted. */
  private async orderProgress(s: ShipmentRow, tx: PoolClient): Promise<AuditSpec[]> {
    const order = await this.orders.findSalesOrder(s.salesOrderId, tx, true);
    if (!order) return [];
    const ordered = order.lines.reduce((t, l) => t.add(Rational.parse(String(l.quantity))), Rational.of(0));
    const { delivered, accepted } = await this.repo.deliveredAndAccepted(order.id, tx);
    const audit: AuditSpec[] = [];
    let status = order.status;
    if (['received_jobwork', 'ready_customer_dispatch', 'in_customer_transit'].includes(status) && q(delivered).compare(ordered) >= 0) {
      status = 'delivered';
      await this.orders.setSalesOrderStatus({ orderId: order.id, status }, tx);
      audit.push({ action: 'orders.sales_order_delivered', subjectType: 'sales_order', subjectId: order.id, data: { number: order.number, shipment: s.number } });
    }
    if (status === 'delivered' && q(accepted).compare(ordered) >= 0) {
      await this.orders.setSalesOrderStatus({ orderId: order.id, status: 'customer_accepted' }, tx);
      audit.push({ action: 'orders.sales_order_customer_accepted', subjectType: 'sales_order', subjectId: order.id, data: { number: order.number, shipment: s.number } });
    }
    return audit;
  }

  // ----------------------------------------------------------------- the handover

  /** Proof of delivery (FR-902): who took the goods, when and in what state. It opens the window; it accepts nothing. */
  async recordPod(actor: Actor, shipmentId: string, input: RecordPodRequest, opts: Opts = {}): Promise<Shipment> {
    requireJobWork(actor, LOGISTICS);
    await this.executor.execute(
      {
        operation: 'logistics.record-proof-of-delivery',
        handler: async (tx, ctx, cmd: RecordPodRequest) => {
          const s = await this.legTwo(shipmentId, tx, cmd.expectedVersion);
          const pending = await this.repo.proofOfDelivery(s.id, tx);
          if (pending) throw new LogisticsRefused('POD_RECORDED', 'This delivery already has its proof of delivery');
          if (!ON_THE_WAY.includes(s.status) && s.status !== 'discrepancy_hold') throw new LogisticsRefused('SHIPMENT_STATUS', 'A proof of delivery follows the pickup', `It is ${s.status.replace(/_/g, ' ')}.`);
          const receivedAt = new Date(cmd.receivedAt);
          if (receivedAt.getTime() > Date.now() + 5 * 60_000 || (s.pickedUpAt && receivedAt.getTime() < s.pickedUpAt.getTime())) throw new LogisticsRefused('POD_TIME', 'The handover is after the pickup and not in the future', undefined, 422);
          for (const id of cmd.documentVersionIds) {
            if (!(await this.repo.ownCleanVersion(id, actor.organizationId!, tx))) throw new LogisticsRefused('PHOTO_UNAVAILABLE', 'Upload the signed copy and photos first', 'Each must be JobWork’s own file and scanned clean.', 422);
          }
          // Doc 19 §8: a redirect the carrier made names where it was handed over; the shipment's own address stays.
          const redirect = (await this.repo.deliveryExceptions(s.id, tx)).filter((x) => x.kind === 'address_change' && x.resolution === 'redirected').at(-1);
          const deliveredTo = (redirect?.requestedSnapshot ?? s.destinationSnapshot) as SiteSnapshot;
          const policy = await this.repo.acceptancePolicy(tx);
          const dueAt = acceptanceDueAt(receivedAt, policy.windowDays);
          await this.repo.insertProofOfDelivery({ shipmentId: s.id, receivedByName: cmd.receivedByName, receivedAt, deliveredTo, packagesReceived: cmd.packagesReceived, remarks: cmd.remarks, remarksNote: cmd.remarksNote, documentVersionIds: cmd.documentVersionIds, source: cmd.source, by: actor.userId }, tx);
          const holds = await this.held(s.id, tx);
          const version = await this.repo.update(s.id, { ...(holds ? {} : { status: 'receiving_check' as const }), acceptanceDueAt: dueAt }, tx);
          const due = await this.finance.issueDue(s.salesOrderId, 'delivered', actor.userId, ctx.correlationId, tx);
          const order = await this.orderProgress(s, tx);
          const orderNumber = (await this.orders.findSalesOrder(s.salesOrderId, tx))!.number;
          return {
            result: undefined,
            audit: [this.audit(s, version, 'logistics.proof_of_delivery_recorded', { receivedBy: cmd.receivedByName, remarks: cmd.remarks, source: cmd.source, acceptanceDueAt: dueAt.toISOString(), policyVersion: policy.version, invoicesIssued: due.invoiceNumbers }), ...due.audit, ...order],
            outbox: [this.event(s, version, 'logistics.delivery_recorded.v1', { orderNumber, acceptanceDueAt: dueAt.toISOString() }), ...due.outbox],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.dispatch.get(actor, shipmentId);
  }

  // ----------------------------------------------------------------- the customer's decision

  async accept(actor: Actor, shipmentId: string, input: AcceptDeliveryRequest, opts: Opts = {}): Promise<CustomerDelivery> {
    await this.executor.execute(
      {
        operation: 'logistics.accept-delivery',
        handler: async (tx, _ctx, cmd: AcceptDeliveryRequest) => {
          const s = await this.legTwo(shipmentId, tx);
          this.customerOf(actor, s, ACCEPTORS);
          if (s.aggregateVersion !== cmd.expectedVersion) throw new DomainError('VERSION_CONFLICT', 409, 'The delivery moved on', 'Reload it and try again.');
          if (s.status !== 'receiving_check') throw new LogisticsRefused('SHIPMENT_STATUS', s.status === 'discrepancy_hold' ? 'An issue you reported is still open' : 'Only a delivery that was handed over is accepted', `It is ${s.status.replace(/_/g, ' ')}.`);
          const policy = await this.repo.acceptancePolicy(tx);
          await this.repo.insertAcceptance({ shipmentId: s.id, basis: 'explicit', by: actor.userId, policyVersionId: policy.id, warrantyStatement: policy.warrantyStatement, note: cmd.note }, tx);
          const version = await this.repo.update(s.id, { status: 'accepted' }, tx);
          return {
            result: undefined,
            audit: [this.audit(s, version, 'logistics.delivery_accepted', { basis: 'explicit', policyVersion: policy.version }), ...(await this.orderProgress(s, tx))],
            outbox: [this.event(s, version, 'logistics.delivery_accepted.v1', { basis: 'explicit' })],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.deliveries.get(actor, shipmentId);
  }

  /** The customer reports what arrived, or did not, with its own photos (FR-905; UC-09). */
  async reportIssue(actor: Actor, shipmentId: string, input: ReportDeliveryIssueRequest, opts: Opts = {}): Promise<CustomerDelivery> {
    await this.executor.execute(
      {
        operation: 'logistics.report-delivery-issue',
        handler: async (tx, _ctx, cmd: ReportDeliveryIssueRequest) => {
          const s = await this.legTwo(shipmentId, tx);
          this.customerOf(actor, s, REPORTERS);
          const verdict = issueAllowed(s.status, cmd.kind, new Date(), s.acceptanceDueAt);
          if (!verdict.ok) throw new LogisticsRefused(verdict.code, verdict.title, verdict.detail, 422);
          const items = await this.repo.items(s.id, tx);
          if (cmd.lotMarking && !items.some((i) => i.lotCode === cmd.lotMarking)) throw new LogisticsRefused('LOT_NOT_IN_DELIVERY', `${cmd.lotMarking} is not in this delivery`, undefined, 422);
          const shipped = items.filter((i) => !cmd.lotMarking || i.lotCode === cmd.lotMarking).reduce((t, i) => t.add(q(i.quantity)), Rational.of(0));
          if (q(cmd.quantity).compare(shipped) > 0) throw new LogisticsRefused('QUANTITY_BEYOND_DELIVERY', `At most the ${shipped.toDisplay(4)} delivered`, undefined, 422);
          for (const id of cmd.evidenceDocumentVersionIds) {
            if (!(await this.repo.ownCleanVersion(id, actor.organizationId!, tx))) throw new LogisticsRefused('EVIDENCE_UNAVAILABLE', 'Upload the photos first', 'Each must be your own file and scanned clean.', 422);
          }
          const number = await this.exceptionNumber(tx);
          await this.repo.insertDeliveryException(
            { number, shipmentId: s.id, kind: cmd.kind, party: 'customer', by: actor.userId, lotMarking: cmd.lotMarking, quantity: cmd.quantity, description: cmd.description, evidence: cmd.evidenceDocumentVersionIds, warrantyClaim: verdict.warrantyClaim, requestedSiteId: null, requestedSnapshot: null },
            tx,
          );
          const version = await this.repo.update(s.id, verdict.holds && s.status !== 'discrepancy_hold' ? { status: 'discrepancy_hold' } : {}, tx);
          return {
            result: undefined,
            audit: [this.audit(s, version, verdict.warrantyClaim ? 'logistics.warranty_claim_recorded' : 'logistics.delivery_issue_reported', { exception: number, kind: cmd.kind, lotMarking: cmd.lotMarking, quantity: cmd.quantity, evidence: cmd.evidenceDocumentVersionIds.length })],
            outbox: [this.exceptionEvent(s, version, number, cmd.kind)],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.deliveries.get(actor, shipmentId);
  }

  /** The customer takes back its own report; the delivery waits for acceptance again once nothing holds it. */
  async withdrawIssue(actor: Actor, exceptionId: string, input: WithdrawDeliveryIssueRequest, opts: Opts = {}): Promise<CustomerDelivery> {
    const shipmentId = await this.executor.execute(
      {
        operation: 'logistics.withdraw-delivery-issue',
        handler: async (tx, _ctx, cmd: WithdrawDeliveryIssueRequest) => {
          const found = await this.repo.findDeliveryException(exceptionId, tx);
          if (!found) throw new DomainError('EXCEPTION_NOT_FOUND', 404, 'Not found');
          const s = await this.legTwo(found.shipmentId, tx);
          this.customerOf(actor, s, REPORTERS);
          const x = (await this.repo.findDeliveryException(exceptionId, tx, true))!;
          if (x.raisedByParty !== 'customer' || x.status !== 'open') throw new LogisticsRefused('EXCEPTION_NOT_OPEN', `${x.number} is not an open report of yours`);
          await this.repo.resolveDeliveryException(x.id, { resolution: 'customer_withdrew', note: cmd.note || 'Withdrawn by the customer.', caseReference: '', carrierChargeNote: '', by: actor.userId }, tx);
          const after = await this.afterResolution(s, x, 'customer_withdrew', tx);
          return { result: s.id, audit: [...after.audit], outbox: after.outbox };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.deliveries.get(actor, shipmentId);
  }

  /** JobWork closes an exception: found, declined, redirected, back in stock, or handed to a case that continues it (IN-18). */
  async resolveException(actor: Actor, exceptionId: string, input: ResolveDeliveryExceptionRequest, opts: Opts = {}): Promise<Shipment> {
    const shipmentId = await this.executor.execute(
      {
        operation: 'logistics.resolve-delivery-exception',
        handler: async (tx, _ctx, cmd: ResolveDeliveryExceptionRequest) => {
          const found = await this.repo.findDeliveryException(exceptionId, tx);
          if (!found) throw new DomainError('EXCEPTION_NOT_FOUND', 404, 'Not found');
          requireJobWork(actor, resolverRoles(found.kind));
          const s = await this.legTwo(found.shipmentId, tx);
          const x = (await this.repo.findDeliveryException(exceptionId, tx, true))!;
          if (x.status !== 'open') throw new LogisticsRefused('EXCEPTION_RESOLVED', `${x.number} is already resolved`);
          const allowed = x.warrantyClaim ? (['handed_to_case'] as const) : RESOLUTIONS[x.kind];
          if (!(allowed as readonly string[]).includes(cmd.resolution)) throw new LogisticsRefused('RESOLUTION_NOT_ALLOWED', `${EXCEPTION_LABEL[x.kind]} is not resolved that way`, `Choose one of: ${allowed.join(', ').replace(/_/g, ' ')}.`, 422);
          if (cmd.resolution === 'handed_to_case' && !cmd.caseReference) throw new LogisticsRefused('CASE_REFERENCE_REQUIRED', 'Name the case this continues under', undefined, 422);
          if (cmd.resolution === 'found_delivered' && !(await this.repo.proofOfDelivery(s.id, tx))) throw new LogisticsRefused('POD_REQUIRED', 'Record the proof of delivery first', 'Found delivered means the carrier’s or driver’s proof is on record.');
          if (cmd.resolution === 'redirected' && (await this.repo.proofOfDelivery(s.id, tx))) throw new LogisticsRefused('ALREADY_DELIVERED', 'The delivery was already handed over');
          if (cmd.resolution === 'returned_to_stock') throw new LogisticsRefused('RETURN_RECEIPT', 'A refused delivery is closed by receiving its return leg', undefined, 422);
          await this.repo.resolveDeliveryException(x.id, { resolution: cmd.resolution, note: cmd.note, caseReference: cmd.caseReference, carrierChargeNote: cmd.carrierChargeNote, by: actor.userId }, tx);
          const after = await this.afterResolution(s, x, cmd.resolution, tx, cmd);
          return { result: s.id, audit: [...after.audit], outbox: after.outbox };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.dispatch.get(actor, shipmentId);
  }

  private async afterResolution(
    s: ShipmentRow,
    x: DeliveryExceptionRow,
    resolution: string,
    tx: PoolClient,
    cmd?: ResolveDeliveryExceptionRequest,
  ): Promise<{ audit: AuditSpec[]; outbox: OutboxSpec[] }> {
    // The hold lifts only when nothing holds it any more, and only back to "awaiting acceptance" after a POD.
    const release = s.status === 'discrepancy_hold' && !(await this.held(s.id, tx)) && (await this.repo.proofOfDelivery(s.id, tx)) !== null;
    const version = await this.repo.update(s.id, release ? { status: 'receiving_check' } : {}, tx);
    return {
      audit: [this.audit(s, version, 'logistics.delivery_exception_resolved', { exception: x.number, kind: x.kind, resolution, caseReference: cmd?.caseReference ?? '', carrierChargeNote: cmd?.carrierChargeNote ?? '', holdLifted: release }, cmd?.note)],
      outbox: [this.event(s, version, 'logistics.delivery_exception_resolved.v1', { exceptionNumber: x.number, kind: x.kind, resolution })],
    };
  }

  // ----------------------------------------------------------------- in transit: address change and refusal

  /** Doc 19 §8: a new address after dispatch is a carrier exception with its own snapshot; the shipment's stays. */
  async requestAddressChange(actor: Actor, shipmentId: string, input: RequestAddressChangeRequest, opts: Opts = {}): Promise<void> {
    await this.executor.execute(
      {
        operation: 'logistics.request-address-change',
        handler: async (tx, _ctx, cmd: RequestAddressChangeRequest) => {
          const s = await this.legTwo(shipmentId, tx);
          if (actor.isInternal) requireJobWork(actor, ADDRESS_CHANGERS);
          else this.customerOf(actor, s, REPORTERS);
          if (!['released', 'picked_up', 'in_transit'].includes(s.status)) {
            throw new LogisticsRefused('SHIPMENT_STATUS', ['planned', 'ready_for_release'].includes(s.status) ? 'Before release JobWork changes the address on the plan' : 'The delivery has already arrived', `It is ${s.status.replace(/_/g, ' ')}.`);
          }
          const site = await this.repo.site(cmd.siteId, tx);
          if (!site || site.organizationId !== s.consigneeOrganizationId || site.status !== 'active') throw new LogisticsRefused('DESTINATION_NOT_CUSTOMERS', 'Choose one of the customer’s active addresses', undefined, 422);
          if (site.id === s.destinationSiteId) throw new LogisticsRefused('SAME_ADDRESS', 'That is where it is going already', undefined, 422);
          if ((await this.repo.deliveryExceptions(s.id, tx)).some((x) => x.kind === 'address_change' && x.status === 'open')) throw new LogisticsRefused('ADDRESS_CHANGE_PENDING', 'An address change is already being arranged');
          const number = await this.exceptionNumber(tx);
          await this.repo.insertDeliveryException(
            { number, shipmentId: s.id, kind: 'address_change', party: actor.isInternal ? 'jobwork' : 'customer', by: actor.userId, lotMarking: '', quantity: '0', description: cmd.reason, evidence: [], warrantyClaim: false, requestedSiteId: site.id, requestedSnapshot: snapshot(site) },
            tx,
          );
          const version = await this.repo.update(s.id, {}, tx);
          return { result: undefined, audit: [this.audit(s, version, 'logistics.address_change_requested', { exception: number, party: actor.isInternal ? 'jobwork' : 'customer' }, cmd.reason)], outbox: [this.exceptionEvent(s, version, number, 'address_change')] };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
  }

  /**
   * Doc 19 §8: the customer refuses at the door. The leg ends `refused`; the goods are still the
   * carrier's, coming back on a return leg of their own (BR-LOG-01) that carries the same stock lots,
   * so receiving it brings them back without a second lot.
   */
  async recordRefusal(actor: Actor, shipmentId: string, input: RecordRefusalRequest, opts: Opts = {}): Promise<Shipment> {
    requireJobWork(actor, LOGISTICS);
    await this.executor.execute(
      {
        operation: 'logistics.record-delivery-refusal',
        handler: async (tx, _ctx, cmd: RecordRefusalRequest) => {
          const s = await this.legTwo(shipmentId, tx, cmd.expectedVersion);
          if (!ON_THE_WAY.includes(s.status)) throw new LogisticsRefused('SHIPMENT_STATUS', 'Only a delivery on its way is refused at the door', `It is ${s.status.replace(/_/g, ' ')}.`);
          if (await this.repo.proofOfDelivery(s.id, tx)) throw new LogisticsRefused('POD_RECORDED', 'A delivery with a proof of delivery was taken, not refused');
          for (const id of cmd.evidenceDocumentVersionIds) {
            if (!(await this.repo.ownCleanVersion(id, actor.organizationId!, tx))) throw new LogisticsRefused('PHOTO_UNAVAILABLE', 'Upload the photos first', 'Each must be JobWork’s own file and scanned clean.', 422);
          }
          const number = await this.exceptionNumber(tx);
          await this.repo.insertDeliveryException(
            { number, shipmentId: s.id, kind: 'refused', party: 'jobwork', by: actor.userId, lotMarking: '', quantity: '0', description: `Refused by ${cmd.refusedBy}: ${cmd.reason}`, evidence: cmd.evidenceDocumentVersionIds, warrantyClaim: false, requestedSiteId: null, requestedSnapshot: null },
            tx,
          );
          const version = await this.repo.update(s.id, { status: 'refused' }, tx);

          // The way back: the same packages and lots, in the carrier's custody, to JobWork's hub.
          const hub = (await this.repo.hubSite(tx))!;
          const hubSite = (await this.repo.site(hub.id, tx))!;
          const back = await this.repo.allocateNumber('SH', 'shipment', new Date(), tx);
          const returnId = await this.repo.insert(
            { number: back, leg: 'customer_to_jobwork', salesOrderId: s.salesOrderId, workPackageId: null, purchaseOrderId: null, shipperOrganizationId: s.consigneeOrganizationId, consigneeOrganizationId: hub.organizationId, originSiteId: s.destinationSiteId, destinationSiteId: hub.id, documents: {}, by: actor.userId, returnsShipmentId: s.id },
            tx,
          );
          const packages = await this.repo.packages(s.id, tx);
          const items = await this.repo.items(s.id, tx);
          await this.repo.replaceContents(
            returnId,
            packages.map((p) => ({ packageNo: p.packageNo, lengthMm: p.lengthMm, widthMm: p.widthMm, heightMm: p.heightMm, weightG: p.weightG, items: items.filter((i) => i.packageId === p.id).map((i) => ({ lotCode: i.lotCode, serials: i.serials, quantity: i.quantity, unit: i.unit, description: i.description })) })),
            tx,
            packages.map((p) => items.filter((i) => i.packageId === p.id).map((i) => i.stockLotId)),
          );
          await this.repo.update(returnId, { status: 'planned' }, tx);
          await this.repo.update(returnId, { status: 'ready_for_release' }, tx);
          await this.repo.update(returnId, { status: 'released', originSnapshot: s.destinationSnapshot!, destinationSnapshot: snapshot(hubSite), releaseSnapshot: { returnOf: s.number, exception: number, refusedBy: cmd.refusedBy }, releasedBy: actor.userId, releasedAt: new Date() }, tx);
          const returnVersion = await this.repo.update(returnId, { status: 'picked_up', carrierMode: s.carrierMode ?? 'carrier', carrierName: s.carrierName ?? '', trackingReference: s.trackingReference ?? '', pickedUpAt: new Date() }, tx);
          return {
            result: undefined,
            audit: [this.audit(s, version, 'logistics.delivery_refused', { exception: number, refusedBy: cmd.refusedBy, returnShipment: back }, cmd.reason), this.audit({ id: returnId, number: back }, returnVersion, 'logistics.return_leg_opened', { returnOf: s.number })],
            outbox: [this.event(s, version, 'logistics.delivery_refused.v1', { exceptionNumber: number, returnShipmentId: returnId }), this.exceptionEvent(s, version, number, 'refused')],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.dispatch.get(actor, shipmentId);
  }

  // ----------------------------------------------------------------- the window (FR-905)

  /** Deemed acceptance: every delivery past its window with nothing holding it (service only). */
  async acceptanceSweep(principal: { id: string }, now = new Date()): Promise<{ deemed: number }> {
    let deemed = 0;
    for (const shipmentId of await this.repo.pastWindow(now)) {
      const ctx: CommandContext = contextFromService(principal, null);
      await this.executor.execute(
        {
          operation: 'logistics.deem-delivery-accepted',
          handler: async (tx) => {
            const s = await this.legTwo(shipmentId, tx);
            if (s.status !== 'receiving_check' || !s.acceptanceDueAt || s.acceptanceDueAt.getTime() >= now.getTime() || (await this.held(s.id, tx))) return { result: undefined, audit: [] };
            const policy = await this.repo.acceptancePolicy(tx);
            if (!policy.deemedAcceptance) return { result: undefined, audit: [] };
            await this.repo.insertAcceptance({ shipmentId: s.id, basis: 'deemed', by: null, policyVersionId: policy.id, warrantyStatement: policy.warrantyStatement, note: '' }, tx);
            const version = await this.repo.update(s.id, { status: 'accepted' }, tx);
            deemed += 1;
            const orderNumber = (await this.orders.findSalesOrder(s.salesOrderId, tx))!.number;
            return {
              result: undefined,
              audit: [this.audit(s, version, 'logistics.delivery_deemed_accepted', { acceptanceDueAt: s.acceptanceDueAt.toISOString(), policyVersion: policy.version }), ...(await this.orderProgress(s, tx))],
              outbox: [this.event(s, version, 'logistics.delivery_deemed_accepted.v1', { orderNumber })],
            };
          },
        },
        ctx,
        { shipmentId },
      );
    }
    return { deemed };
  }
}
