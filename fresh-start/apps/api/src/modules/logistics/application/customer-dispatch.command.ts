import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type {
  ConfirmDeliveryAddressRequest,
  CustomerDelivery,
  DispatchContext,
  DispatchPackageInput,
  OverridableGuard,
  PackageInput,
  PackingCheck,
  PlanCustomerDispatchRequest,
  RecordAddressConfirmationRequest,
  ReplanCustomerDispatchRequest,
  RequestDispatchOverrideRequest,
  Shipment,
  ShipmentDelivery,
  ShipmentGuard,
  ShipmentVersionRequest,
} from '@jobwork/contracts';
import { ApprovalEffectRegistry, CommercialRepository, type ApprovalEffectInput } from '../../commercial';
import { IdentityScreen } from '../../communication';
import type { Actor } from '../../iam';
import { DispatchFinance, OrdersRepository, ProductionRepository, type SalesOrderRecord } from '../../orders';
import { QualityReleaseCommand, Rational } from '../../quality';
import { contextFromActor, type AuditSpec, type OutboxSpec } from '../../../platform/commands/command';
import { CommandExecutor } from '../../../platform/commands/execute';
import { DomainError } from '../../../platform/http/domain-error';
import { applyOverrides, customerLotMarking, legTwoGuards, lotKey, type LegTwoFacts, type LegTwoItem, OVERRIDABLE, reasonsHash } from '../domain/dispatch-gate';
import { LogisticsRefused } from '../domain/shipment';
import { LogisticsRepository, type ShipmentRow } from '../infrastructure/logistics.repository';
import { LOGISTICS, requireJobWork, requireLogisticsReader } from './access';
import { CustomerDeliveries } from './customer-deliveries';
import { DispatchCommand, siteHash, snapshot } from './dispatch.command';

type Opts = { idempotencyKey?: string | undefined };

const ZERO = Rational.of(0);
const q = (s: string): Rational => Rational.parse(s);
const show = (r: Rational): string => r.toDisplay(4);
const PREPARING = ['planned', 'ready_for_release'];
/** Sales may record a confirmation the customer gave by phone or mail; so may logistics. */
const CONFIRMERS = ['jobwork_sales', 'jobwork_logistics'];
const NO_CHECK: PackingCheck = { neutralCartons: false, supplierMarksRemoved: false, jobworkLabelsApplied: false, packagingNoteFollowed: false };

/**
 * Leg 2, JobWork to the customer (IN-17 F-17.2; doc 06 §§7, 11; doc 10 §12; BR-LOG-01, BR-LOG-03;
 * UC-33). JobWork logistics packs pieces from its own stock lots under JobWork's lot marking; the
 * customer confirms where it goes; eight guards are computed from authoritative facts and every one
 * must be green, or overridden by its owner for exactly the reasons shown (doc 03 §4). Release
 * re-runs them under the order's lock, freezes what the customer was promised, and moves the stock
 * to `OUT-DISPATCHED` at the ledger's constraint.
 */
@Injectable()
export class CustomerDispatchCommand {
  constructor(
    private readonly repo: LogisticsRepository,
    private readonly orders: OrdersRepository,
    private readonly production: ProductionRepository,
    private readonly finance: DispatchFinance,
    private readonly quality: QualityReleaseCommand,
    private readonly identity: IdentityScreen,
    private readonly commercial: CommercialRepository,
    private readonly deliveries: CustomerDeliveries,
    private readonly dispatch: DispatchCommand,
    private readonly executor: CommandExecutor,
    effects: ApprovalEffectRegistry,
  ) {
    effects.register('dispatch_override', (input, tx) => this.applyOverrideDecision(input, tx));
    dispatch.registerLegTwo({ guards: (s, tx) => this.guards(s, tx), delivery: (s) => this.delivery(s) });
  }

  // ----------------------------------------------------------------- helpers

  private audit(s: { id: string; number: string }, version: number, action: string, data: Record<string, unknown> = {}, reason?: string): AuditSpec {
    return { action, subjectType: 'shipment', subjectId: s.id, subjectVersion: version, ...(reason ? { reason } : {}), data: { number: s.number, ...data } };
  }

  private event(s: { id: string; number: string; salesOrderId: string; consigneeOrganizationId: string }, version: number, type: string, data: Record<string, unknown> = {}): OutboxSpec {
    return {
      eventType: type,
      aggregateType: 'shipment',
      aggregateId: s.id,
      aggregateVersion: version,
      data: { shipmentId: s.id, number: s.number, leg: 'jobwork_to_customer', salesOrderId: s.salesOrderId, customerOrganizationId: s.consigneeOrganizationId, ...data },
    };
  }

  private async locked(id: string, expectedVersion: number | null, tx: PoolClient): Promise<ShipmentRow> {
    const s = await this.repo.find(id, tx, true);
    if (!s || s.leg !== 'jobwork_to_customer') throw new DomainError('SHIPMENT_NOT_FOUND', 404, 'Shipment not found');
    if (expectedVersion !== null && s.aggregateVersion !== expectedVersion) throw new DomainError('VERSION_CONFLICT', 409, 'The shipment moved on', 'Reload it and try again.');
    return s;
  }

  private async order(id: string, tx?: PoolClient, forUpdate = false): Promise<SalesOrderRecord> {
    const order = await this.orders.findSalesOrder(id, tx, forUpdate);
    if (!order) throw new DomainError('SALES_ORDER_NOT_FOUND', 404, 'Sales order not found');
    return order;
  }

  /** The customer's active address chosen, or the order's delivery address, or the customer's first. */
  private async destination(order: SalesOrderRecord, siteId: string | null | undefined, tx: PoolClient): Promise<string> {
    const id = siteId ?? order.deliverySiteId ?? (await this.repo.firstSite(order.customerOrganizationId, false, tx));
    const site = id ? await this.repo.site(id, tx) : null;
    if (!site || site.organizationId !== order.customerOrganizationId || site.status !== 'active') throw new LogisticsRefused('DESTINATION_NOT_CUSTOMERS', 'Choose one of the customer’s active addresses', undefined, 422);
    return site.id;
  }

  /** Packages of stock lots, as the shipment stores them: each item under JobWork's marking, mapped to its lot. */
  private async contents(order: SalesOrderRecord, packages: readonly DispatchPackageInput[], tx: PoolClient): Promise<{ packages: PackageInput[]; lotIds: string[][] }> {
    const fallback = order.lines.length === 1 ? order.lines[0]!.description : order.title;
    const out: PackageInput[] = [];
    const lotIds: string[][] = [];
    for (const p of packages) {
      const items: PackageInput['items'] = [];
      const ids: string[] = [];
      for (const i of p.items) {
        const lot = await this.repo.lotDetail(i.stockLotId, tx);
        if (!lot || lot.ownership !== 'jobwork' || lot.salesOrderId !== order.id) throw new LogisticsRefused('LOT_NOT_ORDER_STOCK', 'Pick only this order’s made parts from JobWork stock', undefined, 422);
        if (lot.serials.length > 0 && i.serials.some((x) => !lot.serials.includes(x))) throw new LogisticsRefused('SERIAL_NOT_IN_LOT', `A serial is not in ${customerLotMarking(lot.id)}`, undefined, 422);
        items.push({ lotCode: customerLotMarking(lot.id), serials: i.serials, quantity: i.quantity, unit: lot.unit, description: i.description || fallback });
        ids.push(lot.id);
      }
      out.push({ packageNo: p.packageNo, lengthMm: p.lengthMm, widthMm: p.widthMm, heightMm: p.heightMm, weightG: p.weightG, items });
      lotIds.push(ids);
    }
    return { packages: out, lotIds };
  }

  // ----------------------------------------------------------------- the gate

  /** Every fact the doc 10 §12 guards read, in `tx` when given. */
  private async facts(s: ShipmentRow, tx?: PoolClient): Promise<LegTwoFacts> {
    const order = await this.order(s.salesOrderId, tx);
    const items = await this.repo.items(s.id, tx);
    const packages = await this.repo.packages(s.id, tx);
    const terms = await this.repo.deliveryTerms(order.id, tx);
    const ordered = order.lines.reduce((t, l) => t.add(Rational.parse(String(l.quantity))), ZERO);

    const lots: LegTwoFacts['lots'] = new Map();
    const workPackageOf = new Map<string, string | null>();
    for (const id of new Set(items.map((i) => i.stockLotId).filter((x): x is string => x !== null))) {
      const lot = await this.repo.lotDetail(id, tx);
      workPackageOf.set(id, lot?.workPackageId ?? null);
      lots.set(id, {
        ofOrder: Boolean(lot && lot.ownership === 'jobwork' && lot.salesOrderId === order.id),
        inStock: lot ? await this.repo.balance(lot.id, 'JW-STOCK', tx) : '0',
        openReceipt: lot && (await this.repo.openDiscrepancyCount(lot.sourceShipmentId, tx)) > 0 ? lot.sourceShipmentNumber : null,
      });
    }
    const legItems: LegTwoItem[] = items.map((i) => ({ packageNo: i.packageNo, stockLotId: i.stockLotId ?? '', marking: i.lotCode, lotCode: i.sourceLotCode, quantity: i.quantity, workPackageId: i.stockLotId ? (workPackageOf.get(i.stockLotId) ?? null) : null }));

    const quality: LegTwoFacts['quality'] = new Map();
    const dispatchedOfLot: LegTwoFacts['dispatchedOfLot'] = new Map();
    for (const i of legItems) {
      if (i.workPackageId && !quality.has(i.workPackageId)) {
        const f = await this.quality.factsFor(i.workPackageId, tx);
        quality.set(i.workPackageId, { releases: f.releases.map((r) => ({ lots: r.lots, quantity: r.quantity })), openNcrs: f.openNcrs.map((n) => ({ number: n.number, lots: n.lots })) });
      }
      const key = lotKey(i.workPackageId, i.lotCode);
      if (i.workPackageId && !dispatchedOfLot.has(key)) dispatchedOfLot.set(key, await this.repo.dispatchedOfLot(i.workPackageId, i.lotCode, tx));
    }

    const payment = (await this.finance.paymentFacts(order.id, tx)) ?? { currency: order.currency, holds: [], unpaid: [], credit: null };
    const stops: LegTwoFacts['holds']['stops'] = [];
    for (const po of await this.orders.listPurchaseOrdersForSalesOrder(order.id, tx)) {
      if (po.status === 'cancelled') continue;
      const stop = await this.production.activeStop(po.id, tx);
      if (stop) stops.push({ purchaseOrderNumber: po.number, changeNumber: stop.changeNumber });
    }

    // Before release the address is the live site; after, the frozen snapshot.
    const site = s.destinationSiteId ? await this.repo.site(s.destinationSiteId, tx) : null;
    const destination = s.destinationSnapshot ?? (site ? snapshot(site) : null);
    const confirmation = await this.repo.latestAddressConfirmation(s.id, tx);
    const problem = !site
      ? 'Choose the delivery address.'
      : site.organizationId !== order.customerOrganizationId || site.status !== 'active'
        ? 'The delivery address must be one of the customer’s active addresses.'
        : null;

    // R-08: every string the customer will read on the label, the delivery note and the tracking page.
    const texts: Array<{ field: string; text: string }> = [{ field: 'the order title', text: order.title }];
    for (const i of items) {
      texts.push({ field: 'a lot marking', text: i.lotCode }, { field: 'an item description', text: i.description });
      for (const serial of i.serials) texts.push({ field: 'a serial', text: serial });
    }
    if (destination) for (const [k, v] of Object.entries(destination)) texts.push({ field: `the delivery address (${k})`, text: v });
    for (const [k, v] of Object.entries(s.documents)) texts.push({ field: `the documents (${k})`, text: v ?? '' });
    if (s.carrierName) texts.push({ field: 'the carrier', text: s.carrierName });
    const findings = await this.identity.screenForCustomer(order.customerOrganizationId, texts, tx);

    const invoiceNumber = (s.documents.invoiceNumber ?? '').trim();
    const shipping = items.reduce((t, i) => t.add(q(i.quantity)), ZERO);
    const value = ordered.compare(ZERO) > 0 ? (Number(shipping.toDisplay(4)) * order.totalMinor) / Number(ordered.toDisplay(4)) : 0;

    return {
      order: { number: order.number, ordered: ordered.toDisplay(4), partialDelivery: terms.partialDelivery, packagingNote: terms.packagingNote },
      items: legItems,
      packageNos: packages.map((p) => p.packageNo),
      lots,
      dispatchedBefore: await this.repo.dispatchedFromOrder(order.id, tx),
      quality,
      dispatchedOfLot,
      payment,
      holds: { stops, openChanges: await this.repo.openChanges(order.id, tx) },
      identity: { packingCheck: { ...NO_CHECK, ...s.packingCheck }, findings },
      address: {
        problem,
        contactMissing: !destination || !destination.contactName.trim() || !destination.contactPhone.trim(),
        confirmation: !confirmation ? 'none' : site && confirmation.siteId === site.id && confirmation.snapshotHash === siteHash(site) ? 'current' : 'stale',
      },
      documents: {
        invoiceNumber,
        invoice: invoiceNumber ? await this.finance.invoiceOfOrder(order.id, invoiceNumber, tx) : null,
        eWaybillNumber: s.documents.eWaybillNumber ?? '',
        consignmentValueMinor: Math.round(value),
      },
    };
  }

  /** The guards as they stand, with any override applied. */
  async guards(s: ShipmentRow, tx?: PoolClient): Promise<ShipmentGuard[]> {
    const overrides = await this.repo.overrides(s.id, tx);
    return applyOverrides(
      legTwoGuards(await this.facts(s, tx)),
      overrides.map((o) => ({ overrideId: o.id, guardKey: o.guardKey, status: o.status, approvalRequestId: o.approvalRequestId, reasonsHash: o.reasonsHash, requestedAt: o.requestedAt })),
    );
  }

  /** Leg 2's dispatch facts on JobWork's view of the shipment. */
  async delivery(s: ShipmentRow): Promise<ShipmentDelivery> {
    const order = await this.order(s.salesOrderId);
    const terms = await this.repo.deliveryTerms(order.id);
    const confirmation = await this.repo.latestAddressConfirmation(s.id);
    const site = s.destinationSiteId ? await this.repo.site(s.destinationSiteId) : null;
    const [pod, acceptance] = [await this.repo.proofOfDelivery(s.id), await this.repo.acceptance(s.id)];
    return {
      orderNumber: order.number,
      customerDisplayName: order.customerDisplayName,
      packagingNote: terms.packagingNote,
      partialDelivery: terms.partialDelivery,
      packingCheck: { ...NO_CHECK, ...s.packingCheck },
      addressConfirmation: confirmation
        ? {
            party: confirmation.party,
            confirmedAt: confirmation.confirmedAt.toISOString(),
            note: confirmation.note,
            current: s.destinationSnapshot !== null || Boolean(site && confirmation.siteId === site.id && confirmation.snapshotHash === siteHash(site)),
          }
        : null,
      overrides: (await this.repo.overrides(s.id)).map((o) => ({
        overrideId: o.id,
        guardKey: o.guardKey as OverridableGuard,
        reasons: o.reasons,
        justification: o.justification,
        status: o.status,
        approvalRequestId: o.approvalRequestId,
        requiredRoles: o.requiredRoles,
        requestedAt: o.requestedAt.toISOString(),
        decidedAt: o.decidedAt ? o.decidedAt.toISOString() : null,
      })),
      pod: pod
        ? { receivedByName: pod.receivedByName, receivedAt: pod.receivedAt.toISOString(), deliveredTo: snapshot(pod.deliveredTo), packagesReceived: pod.packagesReceived, remarks: pod.remarks, remarksNote: pod.remarksNote, source: pod.source, documentCount: pod.documentVersionIds.length }
        : null,
      acceptance: acceptance ? { basis: acceptance.basis, acceptedAt: acceptance.acceptedAt.toISOString(), warrantyStatement: acceptance.warrantyStatement, note: acceptance.note } : null,
      acceptanceDueAt: s.acceptanceDueAt ? s.acceptanceDueAt.toISOString() : null,
      exceptions: (await this.repo.deliveryExceptions(s.id)).map((x) => ({
        exceptionId: x.id,
        number: x.number,
        kind: x.kind,
        raisedByParty: x.raisedByParty,
        lotMarking: x.lotMarking,
        quantity: show(q(x.quantity)),
        description: x.description,
        evidenceCount: x.evidence.length,
        warrantyClaim: x.warrantyClaim,
        requestedAddress: x.requestedSnapshot ? snapshot(x.requestedSnapshot) : null,
        status: x.status,
        resolution: x.resolution,
        resolutionNote: x.resolutionNote ?? '',
        caseReference: x.caseReference,
        carrierChargeNote: x.carrierChargeNote,
        createdAt: x.createdAt.toISOString(),
        resolvedAt: x.resolvedAt ? x.resolvedAt.toISOString() : null,
      })),
      returnShipmentId: await this.repo.returnLeg(s.id),
    };
  }

  // ----------------------------------------------------------------- planning

  async plan(actor: Actor, input: PlanCustomerDispatchRequest, opts: Opts = {}): Promise<Shipment> {
    requireJobWork(actor, LOGISTICS);
    const id = await this.executor.execute(
      {
        operation: 'logistics.plan-customer-dispatch',
        handler: async (tx, ctx, cmd: PlanCustomerDispatchRequest) => {
          const order = await this.order(cmd.salesOrderId, tx);
          if (order.status === 'cancelled' || order.status === 'closed' || order.status === 'pending_commercial_release') throw new LogisticsRefused('ORDER_NOT_DISPATCHABLE', `${order.number} is ${order.status.replace(/_/g, ' ')}`);
          const hub = await this.repo.hubSite(tx);
          if (!hub) throw new LogisticsRefused('HUB_MISSING', 'JobWork’s receiving hub has no active works address');
          const destinationSiteId = await this.destination(order, cmd.destinationSiteId, tx);
          const contents = await this.contents(order, cmd.packages, tx);
          const number = await this.repo.allocateNumber('SH', 'shipment', new Date(), tx);
          const shipmentId = await this.repo.insert(
            { number, leg: 'jobwork_to_customer', salesOrderId: order.id, workPackageId: null, purchaseOrderId: null, shipperOrganizationId: hub.organizationId, consigneeOrganizationId: order.customerOrganizationId, originSiteId: hub.id, destinationSiteId, documents: cmd.documents, by: actor.userId },
            tx,
          );
          await this.repo.replaceContents(shipmentId, contents.packages, tx, contents.lotIds);
          const version = await this.repo.update(shipmentId, { status: 'planned', packingCheck: cmd.packingCheck }, tx);
          // Doc 10 §4: a balance due before dispatch is invoiced now, so the customer sees it before goods move.
          const due = await this.finance.issueDue(order.id, 'dispatch_planned', actor.userId, ctx.correlationId, tx);
          const s = { id: shipmentId, number, salesOrderId: order.id, consigneeOrganizationId: order.customerOrganizationId };
          return {
            result: shipmentId,
            audit: [this.audit(s, version, 'logistics.customer_dispatch_planned', { salesOrder: order.number, packages: cmd.packages.length, invoicesIssued: due.invoiceNumbers }), ...due.audit],
            outbox: [this.event(s, version, 'logistics.customer_dispatch_planned.v1', { orderNumber: order.number }), ...due.outbox],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.dispatch.get(actor, id);
  }

  async replan(actor: Actor, shipmentId: string, input: ReplanCustomerDispatchRequest, opts: Opts = {}): Promise<Shipment> {
    requireJobWork(actor, LOGISTICS);
    await this.executor.execute(
      {
        operation: 'logistics.replan-customer-dispatch',
        handler: async (tx, _ctx, cmd: ReplanCustomerDispatchRequest) => {
          const s = await this.locked(shipmentId, cmd.expectedVersion, tx);
          if (!PREPARING.includes(s.status)) throw new LogisticsRefused('SHIPMENT_NOT_EDITABLE', 'A released delivery keeps its packages, address and documents', `It is ${s.status.replace(/_/g, ' ')}.`);
          const order = await this.order(s.salesOrderId, tx);
          const destinationSiteId = await this.destination(order, cmd.destinationSiteId ?? s.destinationSiteId, tx);
          const contents = await this.contents(order, cmd.packages, tx);
          if (s.status === 'ready_for_release') await this.repo.update(s.id, { status: 'planned' }, tx);
          await this.repo.replaceContents(s.id, contents.packages, tx, contents.lotIds);
          const version = await this.repo.update(s.id, { destinationSiteId, documents: cmd.documents, packingCheck: cmd.packingCheck }, tx);
          return {
            result: undefined,
            audit: [this.audit(s, version, 'logistics.customer_dispatch_replanned', { packages: cmd.packages.length, destinationChanged: destinationSiteId !== s.destinationSiteId })],
            outbox: [this.event(s, version, 'logistics.shipment_planned.v1')],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.dispatch.get(actor, shipmentId);
  }

  // ----------------------------------------------------------------- the address (doc 10 §12)

  private async confirm(s: ShipmentRow, party: 'customer' | 'jobwork', by: string, note: string, tx: PoolClient): Promise<number> {
    if (!PREPARING.includes(s.status)) throw new LogisticsRefused('SHIPMENT_STATUS', 'The address is confirmed before the delivery is released', `It is ${s.status.replace(/_/g, ' ')}.`);
    const site = s.destinationSiteId ? await this.repo.site(s.destinationSiteId, tx) : null;
    if (!site || site.organizationId !== s.consigneeOrganizationId || site.status !== 'active') throw new LogisticsRefused('DESTINATION_NOT_CUSTOMERS', 'The delivery address is not one of the customer’s active addresses', 'JobWork chooses another before it is confirmed.', 422);
    await this.repo.insertAddressConfirmation({ shipmentId: s.id, siteId: site.id, snapshotHash: siteHash(site), party, by, note }, tx);
    return this.repo.update(s.id, {}, tx);
  }

  /** The customer confirms the address and receiving contact as they stand. */
  async confirmAddress(actor: Actor, shipmentId: string, input: ConfirmDeliveryAddressRequest, opts: Opts = {}): Promise<CustomerDelivery> {
    await this.executor.execute(
      {
        operation: 'logistics.confirm-delivery-address',
        handler: async (tx, _ctx, cmd: ConfirmDeliveryAddressRequest) => {
          const s = this.deliveries.requireCustomer(actor, await this.repo.find(shipmentId, tx, true));
          if (s.aggregateVersion !== cmd.expectedVersion) throw new DomainError('VERSION_CONFLICT', 409, 'The delivery moved on', 'Reload it and try again.');
          const version = await this.confirm(s, 'customer', actor.userId, '', tx);
          return { result: undefined, audit: [this.audit(s, version, 'logistics.delivery_address_confirmed', { party: 'customer' })], outbox: [this.event(s, version, 'logistics.delivery_address_confirmed.v1')] };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.deliveries.get(actor, shipmentId);
  }

  /** JobWork records a confirmation the customer gave by phone or mail, with a note of how. */
  async recordAddressConfirmation(actor: Actor, shipmentId: string, input: RecordAddressConfirmationRequest, opts: Opts = {}): Promise<Shipment> {
    requireJobWork(actor, CONFIRMERS);
    await this.executor.execute(
      {
        operation: 'logistics.record-address-confirmation',
        handler: async (tx, _ctx, cmd: RecordAddressConfirmationRequest) => {
          const s = await this.locked(shipmentId, cmd.expectedVersion, tx);
          const version = await this.confirm(s, 'jobwork', actor.userId, cmd.note, tx);
          return { result: undefined, audit: [this.audit(s, version, 'logistics.delivery_address_confirmed', { party: 'jobwork' }, cmd.note)], outbox: [this.event(s, version, 'logistics.delivery_address_confirmed.v1')] };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.dispatch.get(actor, shipmentId);
  }

  // ----------------------------------------------------------------- submit, override, release

  async submit(actor: Actor, shipmentId: string, input: ShipmentVersionRequest, opts: Opts = {}): Promise<Shipment> {
    requireJobWork(actor, LOGISTICS);
    await this.executor.execute(
      {
        operation: 'logistics.submit-customer-dispatch',
        handler: async (tx, _ctx, cmd: ShipmentVersionRequest) => {
          const s = await this.locked(shipmentId, cmd.expectedVersion, tx);
          if (s.status !== 'planned') throw new LogisticsRefused('SHIPMENT_STATUS', 'Only a planned delivery is submitted', `It is ${s.status.replace(/_/g, ' ')}.`);
          const red = (await this.guards(s, tx)).filter((g) => !g.pass);
          if (red.length > 0) throw new LogisticsRefused('SHIPMENT_NOT_READY', 'Not ready to release', red.flatMap((g) => g.reasons).join(' '));
          const version = await this.repo.update(s.id, { status: 'ready_for_release' }, tx);
          return { result: undefined, audit: [this.audit(s, version, 'logistics.customer_dispatch_submitted')], outbox: [this.event(s, version, 'logistics.shipment_submitted.v1')] };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.dispatch.get(actor, shipmentId);
  }

  /** Doc 03 §4: logistics asks; the owner of the hold decides, through the approval rail. */
  async requestOverride(actor: Actor, shipmentId: string, input: RequestDispatchOverrideRequest, opts: Opts = {}): Promise<Shipment> {
    requireJobWork(actor, LOGISTICS);
    const policy = await this.commercial.activePolicy('dispatch_override');
    const roles = (policy?.rules as { approverRolesByGuard?: Record<string, string[]> } | undefined)?.approverRolesByGuard?.[input.guardKey];
    if (!policy || !roles || roles.length === 0) throw new DomainError('POLICY_RULES_INVALID', 500, 'No active dispatch override policy for this guard');
    await this.executor.execute(
      {
        operation: 'logistics.request-dispatch-override',
        handler: async (tx, _ctx, cmd: RequestDispatchOverrideRequest) => {
          const s = await this.locked(shipmentId, null, tx);
          if (!PREPARING.includes(s.status)) throw new LogisticsRefused('SHIPMENT_STATUS', 'An override is asked for before release', `It is ${s.status.replace(/_/g, ' ')}.`);
          const g = (await this.guards(s, tx)).find((x) => x.key === cmd.guardKey)!;
          if (!(OVERRIDABLE as readonly string[]).includes(g.key)) throw new LogisticsRefused('OVERRIDE_NOT_ALLOWED', 'This guard is not overridden', undefined, 422);
          if (g.pass) throw new LogisticsRefused('GUARD_GREEN', `“${g.label}” is already green`);
          if (g.override?.status === 'requested') throw new LogisticsRefused('OVERRIDE_PENDING', 'An override of this guard is already waiting for its owner');
          const hash = reasonsHash(g.reasons);
          const requestId = await this.commercial.createApprovalRequest(
            {
              kind: 'dispatch_override',
              subjectType: 'shipment',
              subjectId: s.id,
              subjectVersionNo: s.aggregateVersion,
              subjectHash: hash,
              policyVersionId: policy.id,
              requestedBy: actor.userId,
              amountMinor: null,
              currency: null,
              marginBp: null,
              context: { label: `Dispatch override on ${s.number}: ${g.label}`, shipmentId: s.id, shipmentNumber: s.number, guardKey: g.key, reasons: g.reasons, justification: cmd.justification },
              requiredRoles: roles,
            },
            tx,
          );
          await this.repo.insertOverride({ shipmentId: s.id, guardKey: g.key, reasons: g.reasons, reasonsHash: hash, justification: cmd.justification, approvalRequestId: requestId, by: actor.userId }, tx);
          const version = await this.repo.update(s.id, {}, tx);
          return {
            result: undefined,
            audit: [this.audit(s, version, 'logistics.dispatch_override_requested', { guard: g.key, reasons: g.reasons, approvalRequestId: requestId }, cmd.justification)],
            outbox: [this.event(s, version, 'logistics.dispatch_override_requested.v1', { approvalRequestId: requestId, guardKey: g.key, requiredRoles: roles })],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.dispatch.get(actor, shipmentId);
  }

  /** The approval rail's decision on an override, inside the decision's transaction. */
  private async applyOverrideDecision(input: ApprovalEffectInput, tx: PoolClient): Promise<Record<string, unknown>> {
    const o = await this.repo.findOverrideByApproval(input.requestId, tx);
    if (!o) throw new DomainError('OVERRIDE_NOT_FOUND', 404, 'Dispatch override not found');
    if (o.status !== 'requested') return { shipmentId: o.shipmentId, guardKey: o.guardKey, unchanged: true };
    await this.repo.find(o.shipmentId, tx, true);
    await this.repo.decideOverride(o.id, input.decision, input.decidedBy, tx);
    await this.repo.update(o.shipmentId, {}, tx);
    return { shipmentId: o.shipmentId, guardKey: o.guardKey, decision: input.decision };
  }

  async release(actor: Actor, shipmentId: string, input: ShipmentVersionRequest, opts: Opts = {}): Promise<Shipment> {
    requireJobWork(actor, LOGISTICS);
    await this.executor.execute(
      {
        operation: 'logistics.release-customer-dispatch',
        handler: async (tx, _ctx, cmd: ShipmentVersionRequest) => {
          const s = await this.locked(shipmentId, cmd.expectedVersion, tx);
          if (s.status !== 'ready_for_release') throw new LogisticsRefused('SHIPMENT_STATUS', 'Only a submitted delivery is released', `It is ${s.status.replace(/_/g, ' ')}.`);
          // Serialise releases on the order so two cannot both take the last pieces (doc 05 "narrow lock around the dispatch gate").
          const order = await this.order(s.salesOrderId, tx, true);
          const guards = await this.guards(s, tx);
          const red = guards.filter((g) => !g.pass);
          if (red.length > 0) throw new LogisticsRefused('SHIPMENT_NOT_READY', 'The guards are no longer green', red.flatMap((g) => g.reasons).join(' '));
          const origin = (await this.repo.site(s.originSiteId!, tx))!;
          const destination = (await this.repo.site(s.destinationSiteId!, tx))!;
          const overrides = guards.filter((g) => g.override?.covers).map((g) => ({ guard: g.key, overrideId: g.override!.overrideId, approvalRequestId: g.override!.approvalRequestId }));
          const version = await this.repo.update(
            s.id,
            { status: 'released', originSnapshot: snapshot(origin), destinationSnapshot: snapshot(destination), releaseSnapshot: { guards, overrides, releasedBy: actor.userId }, releasedBy: actor.userId, releasedAt: new Date() },
            tx,
          );
          // The ledger at the constraint: the stock leaves JobWork's custody with the delivery.
          for (const item of await this.repo.items(s.id, tx)) {
            await this.repo.move({ lotId: item.stockLotId!, from: 'JW-STOCK', to: 'OUT-DISPATCHED', quantity: item.quantity, type: 'dispatch', source: 'logistics.release-customer-dispatch', evidence: { shipment: s.number, order: order.number }, by: actor.userId }, tx);
          }
          const audit: AuditSpec[] = [this.audit(s, version, 'logistics.customer_dispatch_released', { guards: guards.map((g) => g.key), overrides })];
          if (order.status === 'received_jobwork') {
            await this.orders.setSalesOrderStatus({ orderId: order.id, status: 'ready_customer_dispatch' }, tx);
            audit.push({ action: 'orders.sales_order_ready_customer_dispatch', subjectType: 'sales_order', subjectId: order.id, data: { number: order.number, shipment: s.number } });
          }
          return { result: undefined, audit, outbox: [this.event(s, version, 'logistics.shipment_released.v1', { orderNumber: order.number })] };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.dispatch.get(actor, shipmentId);
  }

  // ----------------------------------------------------------------- reads

  /** What the planner needs for one order: the customer's addresses, invoices, terms and the stock it may pick. */
  async context(actor: Actor, salesOrderId: string): Promise<DispatchContext> {
    requireLogisticsReader(actor);
    const order = await this.order(salesOrderId);
    const terms = await this.repo.deliveryTerms(order.id);
    const ordered = order.lines.reduce((t, l) => t.add(Rational.parse(String(l.quantity))), ZERO);
    const lots = await this.repo.dispatchableLots(order.id);
    const facts = new Map<string, Awaited<ReturnType<QualityReleaseCommand['factsFor']>>>();
    for (const wp of new Set(lots.map((l) => l.workPackageId).filter((x): x is string => x !== null))) facts.set(wp, await this.quality.factsFor(wp));
    return {
      salesOrderId: order.id,
      orderNumber: order.number,
      customerDisplayName: order.customerDisplayName,
      deliverySiteId: order.deliverySiteId,
      sites: (await this.repo.customerSites(order.customerOrganizationId)).map((x) => ({ siteId: x.id, ...snapshot(x) })),
      invoices: await this.finance.issuedInvoices(order.id),
      partialDelivery: terms.partialDelivery,
      packagingNote: terms.packagingNote,
      ordered: ordered.toDisplay(4),
      dispatched: show(q(await this.repo.dispatchedFromOrder(order.id))),
      lots: await Promise.all(
        lots.map(async (l) => {
          const f = l.workPackageId ? facts.get(l.workPackageId) : undefined;
          const free = q(l.inStock).sub(q(l.onPrepared));
          return {
            stockLotId: l.id,
            marking: customerLotMarking(l.id),
            lotCode: l.lotCode,
            workPackageNumber: l.workPackageNumber,
            sourceShipmentNumber: l.sourceShipmentNumber,
            unit: l.unit,
            serials: l.serials,
            inStock: show(q(l.inStock)),
            onPreparedDispatches: show(q(l.onPrepared)),
            available: free.compare(ZERO) > 0 ? show(free) : '0',
            receiptOpen: (await this.repo.openDiscrepancyCount(l.sourceShipmentId)) > 0,
            released: Boolean(f?.releases.some((r) => r.lots.length === 0 || r.lots.includes(l.lotCode))),
            heldBy: f ? f.openNcrs.filter((n) => n.lots.length === 0 || n.lots.includes(l.lotCode)).map((n) => n.number) : [],
          };
        }),
      ),
    };
  }

  /** The customer's view of one delivery, for its documents (the only input they are rendered from). */
  async customerView(actor: Actor, shipmentId: string): Promise<CustomerDelivery> {
    requireLogisticsReader(actor);
    const s = await this.repo.find(shipmentId);
    if (!s || s.leg !== 'jobwork_to_customer') throw new DomainError('SHIPMENT_NOT_FOUND', 404, 'Shipment not found');
    return this.deliveries.project(s);
  }
}

