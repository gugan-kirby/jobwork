import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import fc from 'fast-check';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureDatabase, runMigrations } from '../src/migrate';
import { registerPgTypeParsers } from '../src/pg-types';

registerPgTypeParsers();

const BASE_URL = process.env['DATABASE_URL'] ?? 'postgres://localhost:5432/jobwork_dev';
const TEST_DB = `jobwork_logisticsdb_${randomBytes(4).toString('hex')}`;

function url(): string {
  const u = new URL(BASE_URL);
  u.pathname = `/${TEST_DB}`;
  return u.toString();
}

/**
 * The logistics schema (IN-16 F-16.1): the doc 06 §11 leg machine with snapshots frozen at release,
 * carrier events as immutable evidence, receiving records that split every counted piece, and a
 * custody ledger that conserves every received quantity and refuses any over-draw at the
 * constraint (doc 05 §17; BR-LOG-02).
 */
describe('logistics schema (F-16.1)', () => {
  let pg: Client;
  let customer: { id: string };
  let orderId: string;
  let poId: string;
  let supplierOrg: string;
  let workPackageId: string;
  const loc: Record<string, string> = {};
  let n = 0;

  const one = async <T>(sql: string, args: unknown[] = []): Promise<T> => (await pg.query(sql, args)).rows[0] as T;

  async function shipment(status = 'draft'): Promise<string> {
    n += 1;
    const id = (await one<{ id: string }>(
      `INSERT INTO logistics.shipment (number, leg, sales_order_id, work_package_id, purchase_order_id, shipper_organization_id, consignee_organization_id, created_by)
       VALUES ($1, 'supplier_to_jobwork', $2, $3, $4, $5, $6, gen_random_uuid()) RETURNING id`,
      [`SH-2026-${String(n).padStart(4, '0')}`, orderId, workPackageId, poId, supplierOrg, customer.id],
    )).id;
    if (status === 'released') {
      await pg.query(`UPDATE logistics.shipment SET status = 'planned' WHERE id = $1`, [id]);
      await pg.query(`UPDATE logistics.shipment SET status = 'ready_for_release' WHERE id = $1`, [id]);
      await pg.query(
        `UPDATE logistics.shipment SET status = 'released', released_at = now(), released_by = gen_random_uuid(), release_snapshot = '{"guards": []}',
                origin_snapshot = '{"city": "Coimbatore"}', destination_snapshot = '{"city": "Chennai"}' WHERE id = $1`,
        [id],
      );
    }
    return id;
  }

  async function lot(quantity: number): Promise<string> {
    const s = await shipment();
    return (await one<{ id: string }>(
      `INSERT INTO logistics.stock_lot (lot_code, sales_order_id, work_package_id, source_shipment_id, received_quantity, created_by) VALUES ($1, $2, $3, $4, $5, gen_random_uuid()) RETURNING id`,
      [`LOT-${n}`, orderId, workPackageId, s, quantity],
    )).id;
  }

  const move = (lotId: string, from: string | null, to: string, quantity: number, type: string) =>
    pg.query(`INSERT INTO logistics.stock_movement (lot_id, from_location_id, to_location_id, quantity, type, operation, created_by) VALUES ($1, $2, $3, $4, $5, 'test', gen_random_uuid())`, [lotId, from, to, quantity, type]);
  const balances = async (lotId: string): Promise<Record<string, number>> =>
    Object.fromEntries((await pg.query<{ code: string; quantity: string }>(`SELECT l.code, b.quantity FROM logistics.stock_balance b JOIN logistics.custody_location l ON l.id = b.location_id WHERE b.lot_id = $1`, [lotId])).rows.map((r) => [r.code, Number(r.quantity)]));

  beforeAll(async () => {
    await ensureDatabase(url());
    await runMigrations(url(), join(__dirname, '..', 'migrations'));
    pg = new Client({ connectionString: url() });
    await pg.connect();
    customer = await one<{ id: string }>(`INSERT INTO iam.organization (type, legal_name, display_name) VALUES ('customer', 'Kovai', 'Kovai') RETURNING id`);
    supplierOrg = (await one<{ id: string }>(`INSERT INTO iam.organization (type, legal_name, display_name) VALUES ('supplier', 'Anand', 'Anand') RETURNING id`)).id;
    const profile = await one<{ id: string }>(`INSERT INTO supplier.supplier_profile (organization_id) VALUES ($1) RETURNING id`, [supplierOrg]);
    const enquiry = await one<{ id: string }>(`INSERT INTO sourcing.enquiry (customer_organization_id, status) VALUES ($1, 'draft') RETURNING id`, [customer.id]);
    const set = await one<{ id: string }>(`INSERT INTO commercial.quote_offer_set (enquiry_id, customer_organization_id, created_by) VALUES ($1, $2, gen_random_uuid()) RETURNING id`, [enquiry.id, customer.id]);
    const quote = await one<{ id: string }>(`INSERT INTO commercial.customer_quote (offer_set_id, enquiry_id, customer_organization_id, status, reference, created_by) VALUES ($1, $2, $3, 'accepted', 'QUO-2026-0001', gen_random_uuid()) RETURNING id`, [set.id, enquiry.id, customer.id]);
    const terms = await one<{ id: string }>(`SELECT id FROM commercial.terms_version LIMIT 1`);
    const version = await one<{ id: string }>(
      `INSERT INTO commercial.quote_version (customer_quote_id, version_no, currency, subtotal_minor, tax_rate_bp, tax_minor, total_minor, delivery_lead_days, validity_until, terms_version_id, content_hash, status, created_by)
       VALUES ($1, 1, 'INR', 100, 0, 0, 100, 7, current_date + 7, $2, 'h', 'accepted', gen_random_uuid()) RETURNING id`,
      [quote.id, terms.id],
    );
    const acceptance = await one<{ id: string }>(
      `INSERT INTO commercial.acceptance (customer_quote_id, quote_version_id, content_hash, terms_version_id, terms_hash, accepted_by, organization_id, authority_snapshot)
       VALUES ($1, $2, 'h', $3, 't', gen_random_uuid(), $4, '{}'::jsonb) RETURNING id`,
      [quote.id, version.id, terms.id, customer.id],
    );
    const snapshot = await one<{ id: string }>(`INSERT INTO commercial.contract_snapshot (acceptance_id, snapshot, content_hash) VALUES ($1, '{}'::jsonb, 'c') RETURNING id`, [acceptance.id]);
    orderId = (await one<{ id: string }>(
      `INSERT INTO orders.sales_order (number, customer_organization_id, enquiry_id, customer_quote_id, accepted_quote_version_id, acceptance_id, contract_snapshot_id, title, currency, total_minor, delivery_lead_days)
       VALUES ('SO-2026-0001', $1, $2, $3, $4, $5, $6, 'Bracket', 'INR', 100, 7) RETURNING id`,
      [customer.id, enquiry.id, quote.id, version.id, acceptance.id, snapshot.id],
    )).id;
    const req = await one<{ id: string }>(`INSERT INTO sourcing.requirement (enquiry_id, revision_no, kind, snapshot, content_hash) VALUES ($1, 1, 'intake', '{}'::jsonb, 'h') RETURNING id`, [enquiry.id]);
    const rfq = await one<{ id: string }>(`INSERT INTO sourcing.rfq (enquiry_id, requirement_id, round_no, currency, status, deadline_at, released_at) VALUES ($1, $2, 1, 'INR', 'awarded', now(), now()) RETURNING id`, [enquiry.id, req.id]);
    const award = await one<{ id: string }>(`INSERT INTO commercial.award (rfq_id, proposed_by, currency, status) VALUES ($1, gen_random_uuid(), 'INR', 'approved') RETURNING id`, [rfq.id]);
    poId = (await one<{ id: string }>(
      `INSERT INTO orders.purchase_order (number, sales_order_id, award_id, supplier_organization_id, supplier_profile_id, currency, total_minor, lead_time_days, content_hash, issued_by)
       VALUES ('PO-2026-0001', $1, $2, $3, $4, 'INR', 90, 14, 'p', gen_random_uuid()) RETURNING id`,
      [orderId, award.id, supplierOrg, profile.id],
    )).id;
    workPackageId = (await one<{ id: string }>(
      `INSERT INTO orders.work_package (number, sales_order_id, purchase_order_id, supplier_organization_id, created_by) VALUES ('WP-2026-0001', $1, $2, $3, gen_random_uuid()) RETURNING id`,
      [orderId, poId, supplierOrg],
    )).id;
    for (const r of (await pg.query<{ id: string; code: string }>(`SELECT id, code FROM logistics.custody_location`)).rows) loc[r.code] = r.id;
  }, 60_000);

  afterAll(async () => {
    await pg?.end();
    const admin = new Client({ connectionString: BASE_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB}" WITH (FORCE)`);
    await admin.end();
  });

  it('walks the doc 06 §11 leg machine and freezes what was released', async () => {
    const id = await shipment();
    await expect(pg.query(`UPDATE logistics.shipment SET status = 'released' WHERE id = $1`, [id])).rejects.toThrow(/invalid shipment transition: draft -> released/);
    await pg.query(`UPDATE logistics.shipment SET status = 'planned' WHERE id = $1`, [id]);
    const pkg = await one<{ id: string }>(`INSERT INTO logistics.shipment_package (shipment_id, package_no, weight_g) VALUES ($1, 1, 12000) RETURNING id`, [id]);
    await pg.query(`INSERT INTO logistics.shipment_item (shipment_id, package_id, lot_code, quantity) VALUES ($1, $2, 'LOT-A', 10)`, [id, pkg.id]);
    await pg.query(`UPDATE logistics.shipment SET status = 'ready_for_release' WHERE id = $1`, [id]);
    await expect(pg.query(`UPDATE logistics.shipment SET status = 'released' WHERE id = $1`, [id])).rejects.toThrow(/chk_shipment_released/);
    await pg.query(
      `UPDATE logistics.shipment SET status = 'released', released_at = now(), released_by = gen_random_uuid(), release_snapshot = '{}', origin_snapshot = '{"city": "Coimbatore"}', destination_snapshot = '{"city": "Chennai"}' WHERE id = $1`,
      [id],
    );
    // Doc 10 §11: an address is a contract snapshot; nothing rewrites it after release.
    await expect(pg.query(`UPDATE logistics.shipment SET origin_snapshot = '{"city": "Madurai"}' WHERE id = $1`, [id])).rejects.toThrow(/keeps its addresses/);
    await expect(pg.query(`INSERT INTO logistics.shipment_item (shipment_id, package_id, quantity) VALUES ($1, $2, 1)`, [id, pkg.id])).rejects.toThrow(/keeps its packages and items/);
    await expect(pg.query(`UPDATE logistics.shipment SET status = 'picked_up' WHERE id = $1`, [id])).rejects.toThrow(/chk_shipment_picked_up/);
    await pg.query(`UPDATE logistics.shipment SET status = 'picked_up', picked_up_at = now(), carrier_mode = 'carrier', carrier_name = 'Safe Carriers', tracking_reference = 'LR-1001' WHERE id = $1`, [id]);
    await expect(pg.query(`UPDATE logistics.shipment SET tracking_reference = 'LR-9999' WHERE id = $1`, [id])).rejects.toThrow(/keeps its carrier/);
    await pg.query(`UPDATE logistics.shipment SET status = 'delivered_to_destination' WHERE id = $1`, [id]);
    await expect(pg.query(`UPDATE logistics.shipment SET status = 'accepted' WHERE id = $1`, [id])).rejects.toThrow(/invalid shipment transition: delivered_to_destination -> accepted/);
    await pg.query(`UPDATE logistics.shipment SET status = 'receiving_check' WHERE id = $1`, [id]);
    await pg.query(`UPDATE logistics.shipment SET status = 'discrepancy_hold' WHERE id = $1`, [id]);
    await pg.query(`UPDATE logistics.shipment SET status = 'accepted' WHERE id = $1`, [id]);
    await expect(pg.query(`UPDATE logistics.shipment SET consignee_organization_id = $2 WHERE id = $1`, [id, supplierOrg])).rejects.toThrow(/keeps its leg and its parties/);
  });

  it('keeps carrier events as evidence, once each', async () => {
    const id = await shipment('released');
    await pg.query(`INSERT INTO logistics.carrier_event (shipment_id, provider, provider_event_id, raw_status, normalized_status, occurred_at) VALUES ($1, 'dev', 'evt-1', 'DLV', 'delivered', now())`, [id]);
    await expect(pg.query(`INSERT INTO logistics.carrier_event (shipment_id, provider, provider_event_id, raw_status, normalized_status, occurred_at) VALUES ($1, 'dev', 'evt-1', 'DLV', 'delivered', now())`, [id])).rejects.toThrow(/carrier_event_provider_provider_event_id_key/);
    await expect(pg.query(`UPDATE logistics.carrier_event SET normalized_status = 'exception' WHERE provider_event_id = 'evt-1'`)).rejects.toThrow(/immutable/);
  });

  it('splits every counted piece at receiving, and resolves a discrepancy once with a note', async () => {
    const id = await shipment('released');
    const pkg = await one<{ id: string }>(`SELECT id FROM logistics.shipment_package WHERE shipment_id = $1`, [id]).catch(() => undefined);
    expect(pkg).toBeUndefined();
    const rec = await one<{ id: string }>(`INSERT INTO logistics.receiving_record (shipment_id, received_by, seal_intact, packages_received, package_conditions, decision) VALUES ($1, gen_random_uuid(), true, 2, '[]', 'partial') RETURNING id`, [id]);
    await expect(pg.query(`INSERT INTO logistics.receiving_record (shipment_id, received_by, seal_intact, packages_received, package_conditions, decision) VALUES ($1, gen_random_uuid(), true, 2, '[]', 'accept')`, [id])).rejects.toThrow(/receiving_record_shipment_id_key/);
    await expect(pg.query(`UPDATE logistics.receiving_record SET decision = 'accept' WHERE id = $1`, [rec.id])).rejects.toThrow(/immutable/);
    const d = await one<{ id: string }>(`INSERT INTO logistics.receiving_discrepancy (number, shipment_id, receiving_id, kind, lot_code, quantity, description) VALUES ('RD-2026-0001', $1, $2, 'shortage', 'LOT-A', 5, 'Package 2 short by five') RETURNING id`, [id, rec.id]);
    await expect(pg.query(`UPDATE logistics.receiving_discrepancy SET status = 'resolved', resolution = 'accept_shortage', resolved_by = gen_random_uuid(), resolved_at = now() WHERE id = $1`, [d.id])).rejects.toThrow(/chk_discrepancy_resolved/);
    await expect(pg.query(`UPDATE logistics.receiving_discrepancy SET quantity = 1 WHERE id = $1`, [d.id])).rejects.toThrow(/resolved once/);
    await pg.query(`UPDATE logistics.receiving_discrepancy SET status = 'resolved', resolution = 'replacement_expected', resolution_note = 'Supplier ships the five', resolved_by = gen_random_uuid(), resolved_at = now() WHERE id = $1`, [d.id]);
    await expect(pg.query(`UPDATE logistics.receiving_discrepancy SET resolution_note = 'changed' WHERE id = $1`, [d.id])).rejects.toThrow(/resolved once/);
  });

  it('refuses over-receipt and over-draw at the constraint, and never rewrites a movement', async () => {
    const id = await lot(10);
    // Only a receipt enters from outside custody; nothing else may appear from nowhere.
    await expect(move(id, null, loc['JW-STOCK']!, 1, 'release')).rejects.toThrow(/chk_movement_receive_only_from_outside/);
    await expect(move(id, null, loc['JW-RECEIVING']!, 11, 'receive')).rejects.toThrow(/over-received/);
    await move(id, null, loc['JW-RECEIVING']!, 10, 'receive');
    await move(id, loc['JW-RECEIVING']!, loc['JW-STOCK']!, 8, 'release');
    await move(id, loc['JW-RECEIVING']!, loc['JW-QUARANTINE']!, 2, 'quarantine');
    await expect(move(id, loc['JW-QUARANTINE']!, loc['OUT-SCRAPPED']!, 3, 'scrap')).rejects.toThrow(/over-draw refused/);
    await move(id, loc['JW-QUARANTINE']!, loc['OUT-SCRAPPED']!, 2, 'scrap');
    expect(await balances(id)).toEqual({ 'JW-RECEIVING': 0, 'JW-STOCK': 8, 'JW-QUARANTINE': 0, 'OUT-SCRAPPED': 2 });
    await expect(pg.query(`UPDATE logistics.stock_movement SET quantity = 1 WHERE lot_id = $1`, [id])).rejects.toThrow(/immutable/);
    await expect(pg.query(`UPDATE logistics.stock_lot SET received_quantity = 20 WHERE id = $1`, [id])).rejects.toThrow(/immutable/);
  });

  it('conserves every received quantity across any sequence of movements (doc 05 §17)', async () => {
    const places = ['JW-RECEIVING', 'JW-QUARANTINE', 'JW-STOCK', 'OUT-DISPATCHED', 'OUT-SCRAPPED', 'OUT-RETURNED', 'OUT-REWORK'];
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 50 }),
        fc.array(fc.record({ from: fc.integer({ min: 0, max: 2 }), to: fc.integer({ min: 0, max: 6 }), quantity: fc.integer({ min: 1, max: 30 }) }), { maxLength: 12 }),
        async (received, steps) => {
          const id = await lot(received);
          await move(id, null, loc['JW-RECEIVING']!, received, 'receive');
          const model: Record<string, number> = { 'JW-RECEIVING': received };
          for (const s of steps) {
            const from = places[s.from]!;
            const to = places[s.to]!;
            if (from === to) continue;
            const held = model[from] ?? 0;
            const result = await move(id, loc[from]!, loc[to]!, s.quantity, 'adjust').then(
              () => 'ok',
              () => 'refused',
            );
            // The database agrees with the model exactly: a draw within the balance passes, beyond it fails.
            expect(result).toBe(held >= s.quantity ? 'ok' : 'refused');
            if (result === 'ok') {
              model[from] = held - s.quantity;
              model[to] = (model[to] ?? 0) + s.quantity;
            }
          }
          const b = await balances(id);
          expect(Object.values(b).reduce((x, y) => x + y, 0)).toBe(received);
          expect(Object.values(b).every((v) => v >= 0)).toBe(true);
          for (const [code, q] of Object.entries(model)) expect(b[code] ?? 0).toBe(q);
        },
      ),
      { numRuns: 25 },
    );
    expect(customer.id).toBeTruthy();
  });
});
