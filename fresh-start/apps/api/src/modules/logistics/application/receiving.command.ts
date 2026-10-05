import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { DiscrepancyKind, DiscrepancyResolution, ReceiveShipmentRequest, ReceivingDecision, ResolveDiscrepancyRequest, Shipment } from '@jobwork/contracts';
import type { Actor } from '../../iam';
import { OrdersRepository } from '../../orders';
import { Rational } from '../../quality';
import { contextFromActor, type AuditSpec, type OutboxSpec } from '../../../platform/commands/command';
import { CommandExecutor } from '../../../platform/commands/execute';
import { DomainError } from '../../../platform/http/domain-error';
import { LogisticsRefused } from '../domain/shipment';
import { type DiscrepancyRow, type LocationCode, LogisticsRepository, type MovementType, type ShipmentRow } from '../infrastructure/logistics.repository';
import { LOGISTICS, QUALITY, requireJobWork } from './access';
import { DispatchCommand } from './dispatch.command';

type Opts = { idempotencyKey?: string | undefined };

const ZERO = Rational.of(0);
const q = (s: string): Rational => Rational.parse(s);
const show = (r: Rational): string => r.toDisplay(4);
const RECEIVABLE = ['picked_up', 'in_transit', 'delivered_to_destination'];

/** Which resolutions close which discrepancy, who decides, and where quarantined pieces go. */
const RESOLUTIONS: Record<DiscrepancyKind, readonly DiscrepancyResolution[]> = {
  shortage: ['accept_shortage', 'replacement_expected'],
  overage: ['overage_accepted', 'return_to_supplier'],
  damage: ['scrapped', 'released_to_stock', 'return_to_supplier'],
  wrong_item: ['return_to_supplier', 'scrapped'],
  identity: ['released_to_stock', 'return_to_supplier', 'scrapped'],
  document_mismatch: ['document_corrected'],
};
/** Quality owns what is fit to use: anything that leaves quarantine for stock or scrap (owner default). */
const QUALITY_RESOLUTIONS: readonly DiscrepancyResolution[] = ['scrapped', 'released_to_stock', 'overage_accepted'];
const QUARANTINE_EXIT: Partial<Record<DiscrepancyResolution, { to: LocationCode; type: MovementType; required: boolean }>> = {
  scrapped: { to: 'OUT-SCRAPPED', type: 'scrap', required: true },
  released_to_stock: { to: 'JW-STOCK', type: 'release', required: true },
  overage_accepted: { to: 'JW-STOCK', type: 'release', required: true },
  // Pieces refused at the dock never entered custody; only quarantined ones move.
  return_to_supplier: { to: 'OUT-RETURNED', type: 'return', required: false },
};

const LABEL: Record<DiscrepancyKind, string> = {
  shortage: 'a shortage',
  overage: 'an overage',
  damage: 'damage',
  wrong_item: 'a wrong item',
  document_mismatch: 'a document mismatch',
  identity: 'an identity question',
};

/**
 * JobWork receiving (IN-16 F-16.3; doc 10 §13; doc 05 §17; BR-LOG-04). What arrived is counted
 * against what was shipped, every counted piece is accepted, quarantined or refused, and anything
 * that differs opens a discrepancy that holds the shipment. Ordered and shipped quantities are
 * never changed: a shortage stays visible as the supplier's remaining commitment.
 */
@Injectable()
export class ReceivingCommand {
  constructor(
    private readonly repo: LogisticsRepository,
    private readonly orders: OrdersRepository,
    private readonly dispatch: DispatchCommand,
    private readonly executor: CommandExecutor,
  ) {}

  private audit(s: { id: string; number: string }, version: number, action: string, data: Record<string, unknown> = {}): AuditSpec {
    return { action, subjectType: 'shipment', subjectId: s.id, subjectVersion: version, data: { number: s.number, ...data } };
  }

  private event(s: ShipmentRow, version: number, type: string, data: Record<string, unknown> = {}): OutboxSpec {
    return {
      eventType: type,
      aggregateType: 'shipment',
      aggregateId: s.id,
      aggregateVersion: version,
      data: { shipmentId: s.id, number: s.number, leg: s.leg, salesOrderId: s.salesOrderId, shipperOrganizationId: s.shipperOrganizationId, ...data },
    };
  }

  async receive(actor: Actor, shipmentId: string, input: ReceiveShipmentRequest, opts: Opts = {}): Promise<Shipment> {
    requireJobWork(actor, LOGISTICS);
    await this.executor.execute(
      {
        operation: 'logistics.receive-shipment',
        handler: async (tx, _ctx, cmd: ReceiveShipmentRequest) => {
          const s = await this.repo.find(shipmentId, tx, true);
          if (!s) throw new DomainError('SHIPMENT_NOT_FOUND', 404, 'Shipment not found');
          if (s.aggregateVersion !== cmd.expectedVersion) throw new DomainError('VERSION_CONFLICT', 409, 'The shipment moved on', 'Reload it and try again.');
          if (s.leg !== 'supplier_to_jobwork' && s.leg !== 'customer_to_jobwork') throw new LogisticsRefused('SHIPMENT_LEG', 'Only an inbound shipment is received at JobWork');
          if (!RECEIVABLE.includes(s.status)) throw new LogisticsRefused('SHIPMENT_STATUS', 'Only a shipment on its way is received', `It is ${s.status.replace(/_/g, ' ')}.`);

          const items = await this.repo.items(s.id, tx);
          const packages = await this.repo.packages(s.id, tx);
          const byItem = new Map(cmd.lines.map((l) => [l.itemId, l]));
          if (byItem.size !== cmd.lines.length || items.some((i) => !byItem.has(i.id)) || cmd.lines.some((l) => !items.some((i) => i.id === l.itemId))) {
            throw new LogisticsRefused('RECEIVING_INCOMPLETE', 'Count every shipped item once', 'An item that did not arrive is counted 0.', 422);
          }
          const conditions = new Map(cmd.packages.map((p) => [p.packageNo, p]));
          if (conditions.size !== cmd.packages.length || packages.some((p) => !conditions.has(p.packageNo)) || cmd.packages.length !== packages.length) {
            throw new LogisticsRefused('RECEIVING_INCOMPLETE', 'Record the condition of every package once', undefined, 422);
          }
          for (const photo of cmd.photoDocumentVersionIds) {
            if (!(await this.repo.ownCleanVersion(photo, actor.organizationId!, tx))) throw new LogisticsRefused('PHOTO_UNAVAILABLE', 'Upload the receiving photos first', 'Each must be JobWork’s own file and scanned clean.', 422);
          }

          // Every counted piece goes somewhere, and nothing beyond what was shipped goes straight to stock.
          const findings: Array<{ kind: DiscrepancyKind; lotCode: string; quantity: Rational; description: string }> = [];
          const lots = new Map<string, { accepted: Rational; quarantined: Rational; serials: string[]; unit: string }>();
          let accepted = ZERO;
          let quarantined = ZERO;
          let refused = ZERO;
          for (const item of items) {
            const l = byItem.get(item.id)!;
            const shipped = q(item.quantity);
            const [counted, a, qu, r] = [q(l.countedQuantity), q(l.acceptedQuantity), q(l.quarantinedQuantity), q(l.refusedQuantity)];
            const name = item.lotCode || `package ${item.packageNo}`;
            if (a.add(qu).add(r).compare(counted) !== 0) throw new LogisticsRefused('RECEIVING_SPLIT', `${name}: accepted, quarantined and refused must add up to the ${show(counted)} counted`, undefined, 422);
            if (a.compare(shipped) > 0) throw new LogisticsRefused('ACCEPT_BEYOND_SHIPPED', `${name}: no more than the ${show(shipped)} shipped goes to stock`, 'Quarantine or refuse the extra pieces; the overage is resolved separately.', 422);
            if (l.identity !== 'ok' && a.compare(ZERO) > 0) throw new LogisticsRefused('ACCEPT_UNSOUND', `${name}: pieces whose identity is in doubt are quarantined or refused, not accepted`, undefined, 422);
            if (l.damaged && qu.add(r).compare(ZERO) === 0) throw new LogisticsRefused('DAMAGE_UNSPLIT', `${name}: quarantine or refuse the damaged pieces`, 'Only the sound pieces are accepted.', 422);
            // Set-aside pieces leave quarantine only by resolving a discrepancy, so each needs one.
            if (qu.add(r).compare(ZERO) > 0 && !l.damaged && l.identity === 'ok' && counted.compare(shipped) <= 0) {
              throw new LogisticsRefused('QUARANTINE_REASON', `${name}: say why pieces are set aside`, 'Mark them damaged or doubtful; extra pieces beyond those shipped count as an overage.', 422);
            }
            if (counted.compare(shipped) < 0) findings.push({ kind: 'shortage', lotCode: item.lotCode, quantity: shipped.sub(counted), description: `${name}: ${show(counted)} counted of ${show(shipped)} shipped.` });
            if (counted.compare(shipped) > 0) findings.push({ kind: 'overage', lotCode: item.lotCode, quantity: counted.sub(shipped), description: `${name}: ${show(counted)} counted of ${show(shipped)} shipped.` });
            if (l.damaged) findings.push({ kind: 'damage', lotCode: item.lotCode, quantity: qu.add(r), description: `${name}: damaged${l.note ? ` (${l.note})` : ''}.` });
            if (l.identity !== 'ok') findings.push({ kind: l.identity === 'wrong_item' ? 'wrong_item' : 'identity', lotCode: item.lotCode, quantity: counted, description: `${name}: ${l.identity === 'wrong_item' ? 'not the ordered part' : 'marking or lot does not match'}${l.note ? ` (${l.note})` : ''}.` });
            const lot = lots.get(item.lotCode) ?? { accepted: ZERO, quarantined: ZERO, serials: [], unit: item.unit };
            if (lot.unit !== item.unit) throw new LogisticsRefused('LOT_UNITS', `${name} is counted in both ${lot.unit} and ${item.unit}`, 'A lot is held in one unit.', 422);
            lots.set(item.lotCode, { accepted: lot.accepted.add(a), quarantined: lot.quarantined.add(qu), serials: [...lot.serials, ...item.serials], unit: item.unit });
            accepted = accepted.add(a);
            quarantined = quarantined.add(qu);
            refused = refused.add(r);
          }
          if (!cmd.documentsMatch) findings.push({ kind: 'document_mismatch', lotCode: '', quantity: ZERO, description: 'The documents in the consignment do not match the shipment’s.' });

          const decision: ReceivingDecision =
            findings.length === 0 && quarantined.compare(ZERO) === 0 && refused.compare(ZERO) === 0
              ? 'accept'
              : accepted.compare(ZERO) > 0
                ? 'partial'
                : quarantined.compare(ZERO) > 0
                  ? 'quarantine'
                  : 'reject';

          await this.repo.update(s.id, { status: 'receiving_check' }, tx);
          const hub = await this.repo.hubSite(tx);
          const receivingId = await this.repo.insertReceiving(
            {
              shipmentId: s.id,
              by: actor.userId,
              siteId: hub?.id ?? null,
              sealIntact: cmd.sealIntact,
              packagesReceived: cmd.packages.filter((p) => p.condition !== 'missing').length,
              packageConditions: packages.map((p) => ({ packageNo: p.packageNo, condition: conditions.get(p.packageNo)!.condition, note: conditions.get(p.packageNo)!.note })),
              photos: cmd.photoDocumentVersionIds,
              decision,
              note: cmd.note,
            },
            tx,
          );
          for (const item of items) {
            const l = byItem.get(item.id)!;
            await this.repo.insertReceivingLine(
              { receivingId, itemId: item.id, shipped: item.quantity, counted: l.countedQuantity, accepted: l.acceptedQuantity, quarantined: l.quarantinedQuantity, refused: l.refusedQuantity, identityOk: l.identity === 'ok', damaged: l.damaged, note: l.note },
              tx,
            );
          }

          // The custody ledger: a lot for each lot code that entered JobWork's hands (doc 05 §17).
          const ownership = s.leg === 'customer_to_jobwork' ? 'customer_material' : 'jobwork';
          for (const [lotCode, lot] of lots) {
            const custody = lot.accepted.add(lot.quarantined);
            if (custody.compare(ZERO) === 0) continue;
            const lotId = await this.repo.insertStockLot({ lotCode, serials: [...new Set(lot.serials)], salesOrderId: s.salesOrderId, workPackageId: s.workPackageId, sourceShipmentId: s.id, receivedQuantity: show(custody), unit: lot.unit, ownership, by: actor.userId }, tx);
            const evidence = { shipment: s.number, receivingId };
            if (lot.accepted.compare(ZERO) > 0) await this.repo.move({ lotId, from: null, to: 'JW-STOCK', quantity: show(lot.accepted), type: 'receive', source: 'logistics.receive-shipment', evidence, by: actor.userId }, tx);
            if (lot.quarantined.compare(ZERO) > 0) await this.repo.move({ lotId, from: null, to: 'JW-QUARANTINE', quantity: show(lot.quarantined), type: 'receive', source: 'logistics.receive-shipment', evidence, by: actor.userId }, tx);
          }

          const audit: AuditSpec[] = [];
          const outbox: OutboxSpec[] = [];
          for (const f of findings) {
            const number = await this.repo.allocateNumber('RD', 'receiving_discrepancy', new Date(), tx);
            await this.repo.insertDiscrepancy({ number, shipmentId: s.id, receivingId, kind: f.kind, lotCode: f.lotCode, quantity: show(f.quantity), description: f.description }, tx);
            audit.push(this.audit(s, s.aggregateVersion, 'logistics.receiving_discrepancy_opened', { discrepancy: number, kind: f.kind, lotCode: f.lotCode, quantity: show(f.quantity) }));
            outbox.push(this.event(s, s.aggregateVersion, 'logistics.receiving_discrepancy_opened.v1', { discrepancyNumber: number, kind: f.kind, discrepancyLabel: `${LABEL[f.kind]}${f.lotCode ? ` on ${f.lotCode}` : ''}` }));
          }
          const version = await this.repo.update(s.id, { status: findings.length === 0 ? 'accepted' : 'discrepancy_hold' }, tx);
          const received = findings.length === 0 ? await this.orderReceived(s, tx) : [];
          return {
            result: undefined,
            audit: [this.audit(s, version, 'logistics.shipment_received', { decision, accepted: show(accepted), quarantined: show(quarantined), refused: show(refused), discrepancies: findings.length }), ...audit.map((a) => ({ ...a, subjectVersion: version })), ...received],
            outbox: [
              this.event(s, version, 'logistics.shipment_received.v1', { decision }),
              ...outbox.map((o) => ({ ...o, aggregateVersion: version })),
              ...(findings.length === 0 ? [this.event(s, version, 'logistics.shipment_accepted.v1')] : []),
            ],
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.dispatch.get(actor, shipmentId);
  }

  async resolveDiscrepancy(actor: Actor, discrepancyId: string, input: ResolveDiscrepancyRequest, opts: Opts = {}): Promise<Shipment> {
    requireJobWork(actor, QUALITY_RESOLUTIONS.includes(input.resolution) ? QUALITY : LOGISTICS);
    const shipmentId = await this.executor.execute(
      {
        operation: 'logistics.resolve-discrepancy',
        handler: async (tx, _ctx, cmd: ResolveDiscrepancyRequest) => {
          const found = await this.repo.findDiscrepancy(discrepancyId, tx);
          if (!found) throw new DomainError('DISCREPANCY_NOT_FOUND', 404, 'Discrepancy not found');
          const s = (await this.repo.find(found.shipmentId, tx, true))!;
          const d = (await this.repo.findDiscrepancy(discrepancyId, tx, true)) as DiscrepancyRow;
          if (d.status !== 'open') throw new LogisticsRefused('DISCREPANCY_RESOLVED', `${d.number} is already resolved`);
          if (!RESOLUTIONS[d.kind].includes(cmd.resolution)) {
            throw new LogisticsRefused('RESOLUTION_NOT_ALLOWED', `${LABEL[d.kind][0]!.toUpperCase()}${LABEL[d.kind].slice(1)} is not resolved that way`, `Choose one of: ${RESOLUTIONS[d.kind].join(', ').replace(/_/g, ' ')}.`, 422);
          }
          const exit = QUARANTINE_EXIT[cmd.resolution];
          let moved = ZERO;
          if (exit) {
            const lot = await this.repo.lotFor(s.id, d.lotCode, tx);
            const held = lot ? q(await this.repo.balance(lot.id, 'JW-QUARANTINE', tx)) : ZERO;
            moved = held.compare(q(d.quantity)) < 0 ? held : q(d.quantity);
            if (exit.required && moved.compare(ZERO) === 0) throw new LogisticsRefused('NOTHING_IN_QUARANTINE', `Nothing of ${d.lotCode || 'this item'} is in quarantine`, 'Refused pieces never entered JobWork’s custody: return them to the supplier.');
            if (lot && moved.compare(ZERO) > 0) {
              await this.repo.move({ lotId: lot.id, from: 'JW-QUARANTINE', to: exit.to, quantity: show(moved), type: exit.type, source: 'logistics.resolve-discrepancy', evidence: { discrepancy: d.number, resolution: cmd.resolution }, by: actor.userId }, tx);
            }
          }
          await this.repo.resolveDiscrepancy(d.id, { resolution: cmd.resolution, note: cmd.note, caseReference: cmd.caseReference, by: actor.userId }, tx);
          const open = (await this.repo.discrepancies(s.id, tx)).filter((x) => x.status === 'open').length;
          const version = await this.repo.update(s.id, open === 0 && s.status === 'discrepancy_hold' ? { status: 'accepted' } : {}, tx);
          const received = open === 0 ? await this.orderReceived(s, tx) : [];
          const outbox = [this.event(s, version, 'logistics.receiving_discrepancy_resolved.v1', { discrepancyNumber: d.number, resolution: cmd.resolution })];
          if (open === 0) outbox.push(this.event(s, version, 'logistics.shipment_accepted.v1'));
          return {
            result: s.id,
            audit: [this.audit(s, version, 'logistics.receiving_discrepancy_resolved', { discrepancy: d.number, kind: d.kind, resolution: cmd.resolution, moved: show(moved), caseReference: cmd.caseReference }), ...received],
            outbox,
          };
        },
      },
      contextFromActor(actor),
      input,
      opts,
    );
    return this.dispatch.get(actor, shipmentId);
  }

  /**
   * Doc 06 §7: the order is received at JobWork once every work package has the ordered quantity
   * accepted into stock and no inbound shipment of the order is still being checked or held.
   */
  private async orderReceived(s: ShipmentRow, tx: PoolClient): Promise<AuditSpec[]> {
    if (s.leg !== 'supplier_to_jobwork') return [];
    const order = await this.orders.findSalesOrder(s.salesOrderId, tx);
    if (!order || order.status !== 'in_supplier_to_jobwork_transit') return [];
    if ((await this.repo.list({ salesOrderId: s.salesOrderId, statuses: ['receiving_check', 'discrepancy_hold'] }, tx)).some((x) => x.id !== s.id)) return [];
    const packages = await this.repo.orderAcceptance(s.salesOrderId, tx);
    if (packages.length === 0 || packages.some((p) => q(p.accepted).compare(q(p.ordered)) < 0)) return [];
    await this.orders.setSalesOrderStatus({ orderId: order.id, status: 'received_jobwork' }, tx);
    return [{ action: 'orders.sales_order_received_jobwork', subjectType: 'sales_order', subjectId: order.id, data: { number: order.number, shipment: s.number } }];
  }
}
