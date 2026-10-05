import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type {
  CancelShipmentRequest,
  PlanShipmentRequest,
  RecordCarrierEventRequest,
  RecordPickupRequest,
  ReplanShipmentRequest,
  Shipment,
  ShipmentGuard,
  ShipmentStatus,
  ShipmentVersionRequest,
  SiteSnapshot,
} from '@jobwork/contracts';
import type { Actor } from '../../iam';
import { OrdersRepository, ProductionRepository } from '../../orders';
import { QualityReleaseCommand, Rational } from '../../quality';
import { type CommandContext, contextFromActor, contextFromService, type AuditSpec, type OutboxSpec } from '../../../platform/commands/command';
import { CommandExecutor } from '../../../platform/commands/execute';
import { DomainError } from '../../../platform/http/domain-error';
import { LOGISTICS, requireJobWork, requireLogisticsReader } from './access';
import { carrierTarget, legOneGuards, LogisticsRefused } from '../domain/shipment';
import { CarrierPort, type CarrierEvent } from '../infrastructure/carrier.port';
import { LogisticsRepository, type ShipmentRow } from '../infrastructure/logistics.repository';

type Opts = { idempotencyKey?: string | undefined };

/** The carrier feed acts as a named service principal (doc 20 §9), as the payment gateway does. */
export const CARRIER_PRINCIPAL = { name: 'carrier-feed', id: '00000000-0000-4000-8000-000000000003' };

/** Doc 03 has no supplier logistics role: production already owns the work package (owner default). */
export const SUPPLIER_DISPATCHERS = ['supplier_production', 'org_admin'];
const SUPPLIER_READERS = ['supplier_production', 'org_admin', 'supplier_quality', 'supplier_estimator'];
const PREPARING: readonly ShipmentStatus[] = ['draft', 'planned', 'ready_for_release'];
const show = (q: string): string => Rational.parse(q).toDisplay(4);

const snapshot = (s: SiteSnapshot): SiteSnapshot => ({
  label: s.label,
  addressLine1: s.addressLine1,
  addressLine2: s.addressLine2,
  city: s.city,
  state: s.state,
  postalCode: s.postalCode,
  countryCode: s.countryCode,
  contactName: s.contactName,
  contactPhone: s.contactPhone,
});

/**
 * Leg 1, supplier to JobWork (IN-16 F-16.2; doc 06 §11; doc 10 §§11–12; BR-LOG-01, BR-LOG-02).
 * The supplier packs released lots into packages and submits; JobWork logistics releases the
 * shipment once the doc 10 §12 guards are green, freezing its addresses; the supplier hands it to
 * its carrier. Carrier events move the leg along and never receive or accept anything.
 */
@Injectable()
export class DispatchCommand {
  constructor(
    private readonly repo: LogisticsRepository,
    private readonly orders: OrdersRepository,
    private readonly production: ProductionRepository,
    private readonly quality: QualityReleaseCommand,
    private readonly carrier: CarrierPort,
    private readonly executor: CommandExecutor,
  ) {}

  // ----------------------------------------------------------------- helpers

  private audit(s: { id: string; number: string }, version: number, action: string, data: Record<string, unknown> = {}, reason?: string): AuditSpec {
    return { action, subjectType: 'shipment', subjectId: s.id, subjectVersion: version, ...(reason ? { reason } : {}), data: { number: s.number, ...data } };
  }

  private event(s: { id: string; number: string; leg: string; salesOrderId: string; shipperOrganizationId: string }, version: number, type: string, data: Record<string, unknown> = {}): OutboxSpec {
    return {
      eventType: type,
      aggregateType: 'shipment',
      aggregateId: s.id,
      aggregateVersion: version,
      data: { shipmentId: s.id, number: s.number, leg: s.leg, salesOrderId: s.salesOrderId, shipperOrganizationId: s.shipperOrganizationId, ...data },
    };
  }

  private async locked(id: string, expectedVersion: number | null, tx: PoolClient): Promise<ShipmentRow> {
    const s = await this.repo.find(id, tx, true);
    if (!s) throw new DomainError('SHIPMENT_NOT_FOUND', 404, 'Shipment not found');
    if (expectedVersion !== null && s.aggregateVersion !== expectedVersion) throw new DomainError('VERSION_CONFLICT', 409, 'The shipment moved on', 'Reload it and try again.');
    return s;
  }

  /** The shipper's own people, with one of `roles`. */
  private requireShipper(actor: Actor, s: { shipperOrganizationId: string }, roles: readonly string[]): void {
    if (actor.isInternal || actor.organizationId !== s.shipperOrganizationId) throw new DomainError('SHIPMENT_NOT_FOUND', 404, 'Shipment not found');
    if (!actor.roles.some((r) => roles.includes(r))) throw new DomainError('NOT_AUTHORIZED', 403, 'Not permitted', `Requires one of: ${roles.join(', ')}.`);
  }

  private requireLogistics(actor: Actor): void {
    requireJobWork(actor, LOGISTICS);
  }

  /** The doc 10 §12 guards for one leg-1 shipment as it stands, read in `tx`. */
  private async guards(s: ShipmentRow, tx?: PoolClient): Promise<ShipmentGuard[]> {
    const po = (await this.repo.purchaseOrder(s.purchaseOrderId!, tx))!;
    const items = await this.repo.items(s.id, tx);
    const packages = await this.repo.packages(s.id, tx);
    const facts = po.workPackage ? await this.quality.factsFor(po.workPackage.id, tx) : null;
    const origin = s.originSiteId ? await this.repo.site(s.originSiteId, tx) : null;
    const shipped = items.reduce((t, i) => t.add(Rational.parse(i.quantity)), Rational.of(0));
    const ordered = Rational.parse(po.totalQuantity);
    // Consignment value at the purchase order's average unit price (owner default).
    const value = ordered.compare(Rational.of(0)) > 0 ? (Number(shipped.toDisplay(4)) * po.totalMinor) / Number(ordered.toDisplay(4)) : 0;
    const stop = await this.production.activeStop(po.id, tx);
    return legOneGuards({
      purchaseOrder: { number: po.number, status: po.status },
      workPackage: po.workPackage,
      releases: facts ? facts.releases.map((r) => ({ lots: r.lots, quantity: r.quantity })) : [],
      shippedBefore: po.workPackage ? await this.repo.shippedBefore(po.workPackage.id, s.id, tx) : [],
      items: items.map((i) => ({ packageNo: i.packageNo, lotCode: i.lotCode, quantity: i.quantity })),
      packageNos: packages.map((p) => p.packageNo),
      openNcrs: facts ? facts.openNcrs.map((n) => ({ number: n.number, lots: n.lots })) : [],
      interimStop: stop ? { changeNumber: stop.changeNumber } : null,
      supplierActive: await this.repo.supplierActive(po.supplierOrganizationId, tx),
      documents: { challanNumber: s.documents.challanNumber ?? '', invoiceNumber: s.documents.invoiceNumber ?? '', eWaybillNumber: s.documents.eWaybillNumber ?? '' },
      consignmentValueMinor: Math.round(value),
      originProblem: !origin
        ? 'Choose the pickup address.'
        : origin.organizationId !== po.supplierOrganizationId || !['works', 'pickup'].includes(origin.kind)
          ? 'The pickup address must be one of the supplier’s works or pickup sites.'
          : origin.status !== 'active'
            ? 'The pickup address is archived.'
            : null,
      hubPresent: s.destinationSiteId !== null,
    });
  }

  // ----------------------------------------------------------------- the supplier prepares

  async plan(actor: Actor, input: PlanShipmentRequest, opts: Opts = {}): Promise<Shipment> {
    const id = await this.executor.execute(
      {
        operation: 'logistics.plan-shipment',
        handler: async (tx, _ctx, cmd: PlanShipmentRequest) => {
          const po = await this.repo.purchaseOrder(cmd.purchaseOrderId, tx);
          if (!po) throw new DomainError('PURCHASE_ORDER_NOT_FOUND', 404, 'Purchase order not found');
          this.requireShipper(actor, { shipperOrganizationId: po.supplierOrganizationId }, SUPPLIER_DISPATCHERS);
          const origin = await this.repo.site(cmd.originSiteId, tx);
          if (!origin || origin.organizationId !== po.supplierOrganizationId) throw new LogisticsRefused('ORIGIN_NOT_YOURS', 'Ship from one of your own sites', undefined, 422);
          const hub = await this.repo.hubSite(tx);
          const number = await this.repo.allocateNumber('SH', 'shipment', new Date(), tx);
          const shipmentId = await this.repo.insert(
            {
              number,
              leg: 'supplier_to_jobwork',
              salesOrderId: po.salesOrderId,
              workPackageId: po.workPackage?.id ?? null,
              purchaseOrderId: po.id,
              shipperOrganizationId: po.supplierOrganizationId,
              consigneeOrganizationId: hub?.organizationId ?? po.supplierOrganizationId,
              originSiteId: origin.id,
              destinationSiteId: hub?.id ?? null,
              documents: cmd.documents,
              by: actor.userId,
            },
            tx,
          );
          if (!hub) throw new LogisticsRefused('HUB_MISSING', 'JobWork’s receiving hub has no active works address', 'JobWork sets it up before shipments can be planned.');
          await this.repo.replaceContents(shipmentId, cmd.packages, tx);
          const version = await this.repo.update(shipmentId, { status: 'planned' }, tx);
          const s = { id: shipmentId, number, leg: 'supplier_to_jobwork', salesOrderId: po.salesOrderId, shipperOrganizationId: po.supplierOrganizationId };
          return {
            result: shipmentId,
            audit: [this.audit(s, version, 'logistics.shipment_planned', { purchaseOrderId: po.id, packages: cmd.packages.length })],
            outbox: [this.event(s, version, 'logistics.shipment_planned.v1')],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.get(actor, id);
  }

  async replan(actor: Actor, shipmentId: string, input: ReplanShipmentRequest, opts: Opts = {}): Promise<Shipment> {
    await this.executor.execute(
      {
        operation: 'logistics.replan-shipment',
        handler: async (tx, _ctx, cmd: ReplanShipmentRequest) => {
          const s = await this.locked(shipmentId, cmd.expectedVersion, tx);
          this.requireShipper(actor, s, SUPPLIER_DISPATCHERS);
          if (!['planned', 'ready_for_release'].includes(s.status)) throw new LogisticsRefused('SHIPMENT_NOT_EDITABLE', 'A released shipment keeps its packages', `It is ${s.status.replace(/_/g, ' ')}.`);
          const origin = await this.repo.site(cmd.originSiteId, tx);
          if (!origin || origin.organizationId !== s.shipperOrganizationId) throw new LogisticsRefused('ORIGIN_NOT_YOURS', 'Ship from one of your own sites', undefined, 422);
          if (s.status === 'ready_for_release') await this.repo.update(s.id, { status: 'planned' }, tx);
          await this.repo.replaceContents(s.id, cmd.packages, tx);
          const version = await this.repo.update(s.id, { originSiteId: origin.id, documents: cmd.documents }, tx);
          return { result: undefined, audit: [this.audit(s, version, 'logistics.shipment_replanned', { packages: cmd.packages.length })], outbox: [this.event(s, version, 'logistics.shipment_planned.v1')] };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.get(actor, shipmentId);
  }

  async submit(actor: Actor, shipmentId: string, input: ShipmentVersionRequest, opts: Opts = {}): Promise<Shipment> {
    await this.executor.execute(
      {
        operation: 'logistics.submit-shipment',
        handler: async (tx, _ctx, cmd: ShipmentVersionRequest) => {
          const s = await this.locked(shipmentId, cmd.expectedVersion, tx);
          this.requireShipper(actor, s, SUPPLIER_DISPATCHERS);
          if (s.status !== 'planned') throw new LogisticsRefused('SHIPMENT_STATUS', 'Only a planned shipment is submitted', `It is ${s.status.replace(/_/g, ' ')}.`);
          const red = (await this.guards(s, tx)).filter((g) => !g.pass);
          if (red.length > 0) throw new LogisticsRefused('SHIPMENT_NOT_READY', 'Not ready to release', red.flatMap((g) => g.reasons).join(' '));
          const version = await this.repo.update(s.id, { status: 'ready_for_release' }, tx);
          return { result: undefined, audit: [this.audit(s, version, 'logistics.shipment_submitted')], outbox: [this.event(s, version, 'logistics.shipment_submitted.v1')] };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.get(actor, shipmentId);
  }

  async cancel(actor: Actor, shipmentId: string, input: CancelShipmentRequest, opts: Opts = {}): Promise<Shipment> {
    await this.executor.execute(
      {
        operation: 'logistics.cancel-shipment',
        handler: async (tx, _ctx, cmd: CancelShipmentRequest) => {
          const s = await this.locked(shipmentId, cmd.expectedVersion, tx);
          if (actor.isInternal) this.requireLogistics(actor);
          else this.requireShipper(actor, s, SUPPLIER_DISPATCHERS);
          if (!PREPARING.includes(s.status)) throw new LogisticsRefused('SHIPMENT_STATUS', 'A released shipment is not cancelled; receive it, with any discrepancy');
          const version = await this.repo.update(s.id, { status: 'cancelled' }, tx);
          return { result: undefined, audit: [this.audit(s, version, 'logistics.shipment_cancelled', {}, cmd.reason)], outbox: [this.event(s, version, 'logistics.shipment_cancelled.v1')] };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.get(actor, shipmentId);
  }

  // ----------------------------------------------------------------- JobWork releases

  async release(actor: Actor, shipmentId: string, input: ShipmentVersionRequest, opts: Opts = {}): Promise<Shipment> {
    this.requireLogistics(actor);
    await this.executor.execute(
      {
        operation: 'logistics.release-shipment',
        handler: async (tx, _ctx, cmd: ShipmentVersionRequest) => {
          const s = await this.locked(shipmentId, cmd.expectedVersion, tx);
          if (s.status !== 'ready_for_release') throw new LogisticsRefused('SHIPMENT_STATUS', 'Only a submitted shipment is released', `It is ${s.status.replace(/_/g, ' ')}.`);
          // Serialise releases on the work package so two cannot both take the last released pieces (BR-LOG-02).
          if (s.workPackageId) await this.repo.lockWorkPackage(s.workPackageId, tx);
          const guards = await this.guards(s, tx);
          const red = guards.filter((g) => !g.pass);
          if (red.length > 0) throw new LogisticsRefused('SHIPMENT_NOT_READY', 'The guards are no longer green', red.flatMap((g) => g.reasons).join(' '));
          const origin = (await this.repo.site(s.originSiteId!, tx))!;
          const destination = (await this.repo.site(s.destinationSiteId!, tx))!;
          const version = await this.repo.update(
            s.id,
            { status: 'released', originSnapshot: snapshot(origin), destinationSnapshot: snapshot(destination), releaseSnapshot: { guards, releasedBy: actor.userId }, releasedBy: actor.userId, releasedAt: new Date() },
            tx,
          );
          return {
            result: undefined,
            audit: [this.audit(s, version, 'logistics.shipment_released', { guards: guards.map((g) => g.key) })],
            outbox: [this.event(s, version, 'logistics.shipment_released.v1', { purchaseOrderNumber: s.purchaseOrderNumber })],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.get(actor, shipmentId);
  }

  // ----------------------------------------------------------------- pickup and the carrier

  async recordPickup(actor: Actor, shipmentId: string, input: RecordPickupRequest, opts: Opts = {}): Promise<Shipment> {
    await this.executor.execute(
      {
        operation: 'logistics.record-pickup',
        handler: async (tx, _ctx, cmd: RecordPickupRequest) => {
          const s = await this.locked(shipmentId, cmd.expectedVersion, tx);
          if (actor.isInternal) this.requireLogistics(actor);
          else this.requireShipper(actor, s, SUPPLIER_DISPATCHERS);
          if (s.status !== 'released') throw new LogisticsRefused('SHIPMENT_STATUS', 'Only a released shipment is picked up', `It is ${s.status.replace(/_/g, ' ')}.`);
          if ((cmd.carrierMode === 'carrier' || cmd.carrierMode === 'courier') && (!cmd.carrierName || !cmd.trackingReference)) {
            throw new LogisticsRefused('CARRIER_INCOMPLETE', 'Name the carrier and its tracking or LR number', undefined, 422);
          }
          const version = await this.repo.update(s.id, { status: 'picked_up', carrierMode: cmd.carrierMode, carrierName: cmd.carrierName, trackingReference: cmd.trackingReference, pickedUpAt: new Date() }, tx);
          const transit = await this.orderInTransit(s, tx);
          return {
            result: undefined,
            audit: [this.audit(s, version, 'logistics.shipment_picked_up', { carrierMode: cmd.carrierMode, carrierName: cmd.carrierName, trackingReference: cmd.trackingReference }), ...transit],
            outbox: [this.event(s, version, 'logistics.shipment_picked_up.v1')],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.get(actor, shipmentId);
  }

  /** Doc 06 §7: the order is in supplier-to-JobWork transit once everything was ready and goods move. */
  private async orderInTransit(s: ShipmentRow, tx: PoolClient): Promise<AuditSpec[]> {
    const order = await this.orders.findSalesOrder(s.salesOrderId, tx);
    if (!order || order.status !== 'ready_supplier_dispatch') return [];
    await this.orders.setSalesOrderStatus({ orderId: order.id, status: 'in_supplier_to_jobwork_transit' }, tx);
    return [{ action: 'orders.sales_order_in_transit', subjectType: 'sales_order', subjectId: order.id, data: { number: order.number, shipment: s.number } }];
  }

  /** Apply one carrier event, idempotently; it moves the leg and never receives anything. */
  private async applyCarrierEvent(s: ShipmentRow, e: CarrierEvent, provider: string, by: string | null, tx: PoolClient): Promise<{ audit: AuditSpec[]; outbox: OutboxSpec[]; duplicate: boolean }> {
    const eventId = await this.repo.insertCarrierEvent({ shipmentId: s.id, provider, providerEventId: e.providerEventId, rawStatus: e.rawStatus, normalizedStatus: e.normalizedStatus, occurredAt: e.occurredAt, raw: e.raw, by }, tx);
    if (!eventId) return { audit: [], outbox: [], duplicate: true };
    let version = s.aggregateVersion;
    const audit: AuditSpec[] = [];
    if (e.normalizedStatus === 'picked_up' && s.status === 'released') {
      version = await this.repo.update(s.id, { status: 'picked_up', carrierMode: 'carrier', trackingReference: s.trackingReference ?? e.raw['reference']?.toString() ?? '', pickedUpAt: e.occurredAt }, tx);
      audit.push(...(await this.orderInTransit(s, tx)));
    } else {
      const to = carrierTarget(s.status, e.normalizedStatus);
      if (to) version = await this.repo.update(s.id, { status: to as ShipmentStatus, ...(to === 'delivered_to_destination' ? { carrierDeliveredAt: e.occurredAt } : {}) }, tx);
      else version = await this.repo.update(s.id, {}, tx);
    }
    audit.unshift(this.audit(s, version, 'logistics.carrier_event_recorded', { provider, providerEventId: e.providerEventId, rawStatus: e.rawStatus, normalizedStatus: e.normalizedStatus }));
    return { audit, outbox: [this.event(s, version, 'logistics.carrier_event_recorded.v1', { normalizedStatus: e.normalizedStatus })], duplicate: false };
  }

  /** Logistics records what the carrier reported, when no carrier feed is connected (`T-05` open). */
  async recordCarrierEvent(actor: Actor, shipmentId: string, input: RecordCarrierEventRequest, opts: Opts = {}): Promise<Shipment> {
    this.requireLogistics(actor);
    await this.executor.execute(
      {
        operation: 'logistics.record-carrier-event',
        handler: async (tx, _ctx, cmd: RecordCarrierEventRequest) => {
          const s = await this.locked(shipmentId, null, tx);
          const applied = await this.applyCarrierEvent(s, { providerEventId: cmd.providerEventId, reference: s.trackingReference ?? s.number, rawStatus: cmd.rawStatus, normalizedStatus: cmd.normalizedStatus, occurredAt: new Date(cmd.occurredAt), raw: { manual: true } }, 'manual', actor.userId, tx);
          return { result: undefined, audit: applied.audit, outbox: applied.outbox };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.get(actor, shipmentId);
  }

  /** The signed carrier webhook (doc 08 §11): verified, idempotent by event id, never trusted as receipt. */
  async ingestWebhook(provider: string, rawBody: Buffer, headers: Record<string, string | string[] | undefined>): Promise<{ outcome: 'processed' | 'duplicate' | 'ignored'; reason: string }> {
    if (provider !== this.carrier.provider) throw new DomainError('WEBHOOK_REJECTED', 401, 'Unknown carrier');
    const verdict = this.carrier.verifyWebhook(rawBody, headers);
    if (!verdict.ok) throw new DomainError('WEBHOOK_REJECTED', 401, 'Carrier webhook rejected', verdict.reason);
    if (!verdict.event) return { outcome: 'ignored', reason: verdict.reason };
    const event = verdict.event;
    const ctx: CommandContext = contextFromService(CARRIER_PRINCIPAL, null);
    return this.executor.execute<{ provider: string; id: string }, { outcome: 'processed' | 'duplicate' | 'ignored'; reason: string }>(
      {
        operation: 'logistics.ingest-carrier-webhook',
        handler: async (tx) => {
          const found = await this.repo.findByTracking(event.reference, tx);
          if (!found) return { result: { outcome: 'ignored' as const, reason: 'no shipment has that reference' }, audit: [], outbox: [] };
          const s = (await this.repo.find(found.id, tx, true))!;
          const applied = await this.applyCarrierEvent(s, { ...event, raw: { ...event.raw, reference: event.reference } }, provider, null, tx);
          return { result: { outcome: applied.duplicate ? ('duplicate' as const) : ('processed' as const), reason: '' }, audit: applied.audit, outbox: applied.outbox };
        },
      },
      ctx,
      { provider, id: event.providerEventId },
      {},
    );
  }

  // ----------------------------------------------------------------- reads

  private scope(actor: Actor): string | null {
    if (actor.isInternal) {
      requireLogisticsReader(actor);
      return null;
    }
    if (actor.organizationType !== 'supplier' || !actor.organizationId || !actor.roles.some((r) => SUPPLIER_READERS.includes(r))) throw new DomainError('NOT_AUTHORIZED', 403, 'Not permitted');
    return actor.organizationId;
  }

  async list(actor: Actor, filter: { workPackageId?: string; salesOrderId?: string; statuses?: readonly ShipmentStatus[] }): Promise<Shipment[]> {
    const scope = this.scope(actor);
    const rows = await this.repo.list({ ...filter, ...(scope ? { shipperOrganizationId: scope } : {}) });
    return Promise.all(rows.map((s) => this.view(actor, s)));
  }

  async get(actor: Actor, shipmentId: string): Promise<Shipment> {
    const scope = this.scope(actor);
    const s = await this.repo.find(shipmentId);
    if (!s || (scope !== null && s.shipperOrganizationId !== scope)) throw new DomainError('SHIPMENT_NOT_FOUND', 404, 'Shipment not found');
    return this.view(actor, s);
  }

  private async view(actor: Actor, s: ShipmentRow): Promise<Shipment> {
    const [packages, items, events, receiving, discrepancies] = [await this.repo.packages(s.id), await this.repo.items(s.id), await this.repo.carrierEvents(s.id), await this.repo.receiving(s.id), await this.repo.discrepancies(s.id)];
    const live = !PREPARING.includes(s.status);
    const guards = live
      ? (((s.releaseSnapshot as { guards?: ShipmentGuard[] } | null)?.guards ?? []) as ShipmentGuard[])
      : s.status === 'cancelled' || s.leg !== 'supplier_to_jobwork'
        ? []
        : await this.guards(s);
    const origin = s.originSnapshot ?? (s.originSiteId ? await this.repo.site(s.originSiteId) : null);
    const destination = s.destinationSnapshot ?? (s.destinationSiteId ? await this.repo.site(s.destinationSiteId) : null);
    return {
      shipmentId: s.id,
      number: s.number,
      leg: s.leg,
      status: s.status,
      purchaseOrderId: s.purchaseOrderId,
      purchaseOrderNumber: s.purchaseOrderNumber ?? '',
      workPackageId: s.workPackageId,
      salesOrderId: s.salesOrderId,
      supplierDisplayName: actor.isInternal || actor.organizationId === s.shipperOrganizationId ? s.shipperDisplayName : '',
      origin: origin ? snapshot(origin) : null,
      destination: destination ? snapshot(destination) : null,
      documents: { challanNumber: s.documents.challanNumber ?? '', invoiceNumber: s.documents.invoiceNumber ?? '', eWaybillNumber: s.documents.eWaybillNumber ?? '' },
      carrier: { mode: s.carrierMode, name: s.carrierName ?? '', trackingReference: s.trackingReference ?? '' },
      packages: packages.map((p) => ({
        packageNo: p.packageNo,
        lengthMm: p.lengthMm,
        widthMm: p.widthMm,
        heightMm: p.heightMm,
        weightG: p.weightG,
        items: items.filter((i) => i.packageId === p.id).map((i) => ({ itemId: i.id, lotCode: i.lotCode, serials: i.serials, quantity: show(i.quantity), unit: i.unit, description: i.description })),
      })),
      totalQuantity: items.reduce((t, i) => t.add(Rational.parse(i.quantity)), Rational.of(0)).toDisplay(4),
      guards,
      carrierEvents: events.map((e) => ({ normalizedStatus: e.normalizedStatus as Shipment['carrierEvents'][number]['normalizedStatus'], rawStatus: e.rawStatus, occurredAt: e.occurredAt.toISOString(), provider: e.provider })),
      releasedAt: s.releasedAt ? s.releasedAt.toISOString() : null,
      pickedUpAt: s.pickedUpAt ? s.pickedUpAt.toISOString() : null,
      carrierDeliveredAt: s.carrierDeliveredAt ? s.carrierDeliveredAt.toISOString() : null,
      receiving: receiving
        ? {
            receivedAt: receiving.record.receivedAt.toISOString(),
            sealIntact: receiving.record.sealIntact,
            decision: receiving.record.decision,
            packagesReceived: receiving.record.packagesReceived,
            packages: receiving.record.packageConditions,
            lines: receiving.lines.map((l) => ({
              itemId: l.itemId,
              lotCode: l.lotCode,
              shippedQuantity: show(l.shippedQuantity),
              countedQuantity: show(l.countedQuantity),
              // Where JobWork put each piece is its own business (doc 05 §17).
              split: actor.isInternal ? { accepted: show(l.acceptedQuantity), quarantined: show(l.quarantinedQuantity), refused: show(l.refusedQuantity) } : null,
              identity: l.identityOk ? 'ok' : discrepancies.some((d) => d.kind === 'wrong_item' && d.lotCode === l.lotCode) ? 'wrong_item' : 'mismatch',
              damaged: l.damaged,
              note: l.note,
            })),
            note: actor.isInternal ? receiving.record.note : '',
          }
        : null,
      discrepancies: discrepancies.map((d) => ({
        discrepancyId: d.id,
        number: d.number,
        kind: d.kind,
        lotCode: d.lotCode,
        quantity: show(d.quantity),
        description: d.description,
        status: d.status,
        resolution: d.resolution,
        resolutionNote: d.resolutionNote ?? '',
        caseReference: d.caseReference,
        resolvedAt: d.resolvedAt ? d.resolvedAt.toISOString() : null,
        createdAt: d.createdAt.toISOString(),
      })),
      createdAt: s.createdAt.toISOString(),
      aggregateVersion: s.aggregateVersion,
    };
  }
}
