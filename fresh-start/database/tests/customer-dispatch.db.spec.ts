import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureDatabase, runMigrations } from '../src/migrate';
import { registerPgTypeParsers } from '../src/pg-types';

registerPgTypeParsers();

const BASE_URL = process.env['DATABASE_URL'] ?? 'postgres://localhost:5432/jobwork_dev';
const TEST_DB = `jobwork_dispatchdb_${randomBytes(4).toString('hex')}`;

function url(): string {
  const u = new URL(BASE_URL);
  u.pathname = `/${TEST_DB}`;
  return u.toString();
}

/**
 * Leg 2 in the schema (IN-17 F-17.1): the leg machine with refusal and the customer's report, POD
 * and acceptance as different evidence at the constraint (BR-LOG-05), the packing check frozen at
 * release, overrides decided once for exactly their reasons, exceptions resolved once, and a return
 * leg that brings dispatched stock back onto the same lot.
 */
describe('customer dispatch schema (F-17.1)', () => {
  let pg: Client;
  let customer: string;
  let internal: string;
  let orderId: string;
  let siteId: string;
  let policyId: string;
  let n = 0;
  const loc: Record<string, string> = {};

  const one = async <T>(sql: string, args: unknown[] = []): Promise<T> => (await pg.query(sql, args)).rows[0] as T;
  const set = (id: string, sql: string, args: unknown[] = []) => pg.query(`UPDATE logistics.shipment SET ${sql} WHERE id = $1`, [id, ...args]);

  /** A leg-2 shipment walked as far as `status`. */
  async function legTwo(status: 'planned' | 'released' | 'picked_up' | 'delivered_to_destination'): Promise<string> {
    n += 1;
    const id = (await one<{ id: string }>(
      `INSERT INTO logistics.shipment (number, leg, sales_order_id, shipper_organization_id, consignee_organization_id, origin_site_id, destination_site_id, created_by)
       VALUES ($1, 'jobwork_to_customer', $2, $3, $4, $5, $5, gen_random_uuid()) RETURNING id`,
      [`SH-2026-${String(n).padStart(4, '0')}`, orderId, internal, customer, siteId],
    )).id;
    await set(id, `status = 'planned', packing_check = '{"neutralCartons": true}'`);
    if (status === 'planned') return id;
    await set(id, `status = 'ready_for_release'`);
    await set(id, `status = 'released', released_at = now(), released_by = gen_random_uuid(), release_snapshot = '{"guards": []}', origin_snapshot = '{"city": "Chennai"}', destination_snapshot = '{"city": "Coimbatore"}'`);
    if (status === 'released') return id;
    await set(id, `status = 'picked_up', picked_up_at = now(), carrier_mode = 'carrier', carrier_name = 'Safe Carriers', tracking_reference = $2`, [`LR-${n}`]);
    if (status === 'picked_up') return id;
    await set(id, `status = 'delivered_to_destination', carrier_delivered_at = now()`);
    return id;
  }

  const pod = (shipmentId: string) =>
    pg.query(
      `INSERT INTO logistics.proof_of_delivery (shipment_id, received_by_name, received_at, delivered_to_snapshot, packages_received, remarks, source, recorded_by)
       VALUES ($1, 'R. Kumar', now(), '{"city": "Coimbatore"}', 2, 'clean', 'driver', gen_random_uuid())`,
      [shipmentId],
    );
  const acceptance = (shipmentId: string, basis: 'explicit' | 'deemed', by: string | null) =>
    pg.query(`INSERT INTO logistics.delivery_acceptance (shipment_id, basis, accepted_by, policy_version_id, warranty_statement) VALUES ($1, $2, $3, $4, 'as shown')`, [shipmentId, basis, by, policyId]);

  beforeAll(async () => {
    await ensureDatabase(url());
    await runMigrations(url(), join(__dirname, '..', 'migrations'));
    pg = new Client({ connectionString: url() });
    await pg.connect();
    customer = (await one<{ id: string }>(`INSERT INTO iam.organization (type, legal_name, display_name) VALUES ('customer', 'Kovai', 'Kovai') RETURNING id`)).id;
    internal = (await one<{ id: string }>(`INSERT INTO iam.organization (type, legal_name, display_name) VALUES ('internal', 'JobWork', 'JobWork') RETURNING id`)).id;
    siteId = (await one<{ id: string }>(
      `INSERT INTO iam.organization_site (organization_id, label, kind, address_line1, city, state, postal_code) VALUES ($1, 'Plant', 'works', 'Plot 1', 'Coimbatore', 'Tamil Nadu', '641001') RETURNING id`,
      [customer],
    )).id;
    const enquiry = await one<{ id: string }>(`INSERT INTO sourcing.enquiry (customer_organization_id, status) VALUES ($1, 'draft') RETURNING id`, [customer]);
    const offers = await one<{ id: string }>(`INSERT INTO commercial.quote_offer_set (enquiry_id, customer_organization_id, created_by) VALUES ($1, $2, gen_random_uuid()) RETURNING id`, [enquiry.id, customer]);
    const quote = await one<{ id: string }>(`INSERT INTO commercial.customer_quote (offer_set_id, enquiry_id, customer_organization_id, status, reference, created_by) VALUES ($1, $2, $3, 'accepted', 'QUO-2026-0001', gen_random_uuid()) RETURNING id`, [offers.id, enquiry.id, customer]);
    const terms = await one<{ id: string }>(`SELECT id FROM commercial.terms_version LIMIT 1`);
    const version = await one<{ id: string }>(
      `INSERT INTO commercial.quote_version (customer_quote_id, version_no, currency, subtotal_minor, tax_rate_bp, tax_minor, total_minor, delivery_lead_days, validity_until, terms_version_id, content_hash, status, created_by)
       VALUES ($1, 1, 'INR', 100, 0, 0, 100, 7, current_date + 7, $2, 'h', 'accepted', gen_random_uuid()) RETURNING id`,
      [quote.id, terms.id],
    );
    const accepted = await one<{ id: string }>(
      `INSERT INTO commercial.acceptance (customer_quote_id, quote_version_id, content_hash, terms_version_id, terms_hash, accepted_by, organization_id, authority_snapshot)
       VALUES ($1, $2, 'h', $3, 't', gen_random_uuid(), $4, '{}'::jsonb) RETURNING id`,
      [quote.id, version.id, terms.id, customer],
    );
    const snapshot = await one<{ id: string }>(`INSERT INTO commercial.contract_snapshot (acceptance_id, snapshot, content_hash) VALUES ($1, '{}'::jsonb, 'c') RETURNING id`, [accepted.id]);
    orderId = (await one<{ id: string }>(
      `INSERT INTO orders.sales_order (number, customer_organization_id, enquiry_id, customer_quote_id, accepted_quote_version_id, acceptance_id, contract_snapshot_id, title, currency, total_minor, delivery_lead_days)
       VALUES ('SO-2026-0001', $1, $2, $3, $4, $5, $6, 'Bracket', 'INR', 100, 7) RETURNING id`,
      [customer, enquiry.id, quote.id, version.id, accepted.id, snapshot.id],
    )).id;
    policyId = (await one<{ id: string }>(`SELECT id FROM logistics.acceptance_policy_version WHERE version = 1`)).id;
    for (const r of (await pg.query<{ id: string; code: string }>(`SELECT id, code FROM logistics.custody_location`)).rows) loc[r.code] = r.id;
  }, 60_000);

  afterAll(async () => {
    await pg?.end();
    const admin = new Client({ connectionString: BASE_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB}" WITH (FORCE)`);
    await admin.end();
  });

  it('seeds the acceptance policy, the override approval kind, the queues and the templates', async () => {
    expect(await one(`SELECT window_days, deemed_acceptance FROM logistics.acceptance_policy_version WHERE version = 1`)).toEqual({ window_days: 7, deemed_acceptance: true });
    const rules = await one<{ rules: { approverRolesByGuard: Record<string, string[]> } }>(
      `SELECT v.rules FROM commercial.approval_policy p JOIN commercial.approval_policy_version v ON v.policy_id = p.id WHERE p.kind = 'dispatch_override'`,
    );
    expect(rules.rules.approverRolesByGuard).toEqual({ quality: ['jobwork_quality'], payment: ['jobwork_finance'], commitment: ['jobwork_sales'], holds: ['jobwork_engineering'] });
    expect((await pg.query(`SELECT key FROM platform.work_queue WHERE key IN ('customer_dispatches_to_release', 'deliveries_awaiting_pod', 'delivery_exceptions_open')`)).rowCount).toBe(3);
    expect((await pg.query(`SELECT 1 FROM communication.template_version WHERE template_key LIKE 'customer.delivery_%' OR template_key = 'internal.delivery_exception_opened'`)).rowCount).toBe(10);
    await expect(pg.query(`UPDATE logistics.acceptance_policy_version SET window_days = 30`)).rejects.toThrow(/immutable/);
  });

  it('awaits acceptance only with a POD, and accepts only with an acceptance record (BR-LOG-05)', async () => {
    const id = await legTwo('delivered_to_destination');
    await expect(set(id, `status = 'receiving_check'`)).rejects.toThrow(/only once its proof of delivery is recorded/);
    await pod(id);
    await expect(pod(id)).rejects.toThrow(/proof_of_delivery_shipment_id_key/);
    await set(id, `status = 'receiving_check', acceptance_due_at = now() + interval '7 days'`);
    await expect(set(id, `acceptance_due_at = now() + interval '30 days'`)).rejects.toThrow(/set once/);
    await expect(set(id, `status = 'accepted'`)).rejects.toThrow(/accepted only by the customer or by its acceptance window/);
    await expect(acceptance(id, 'explicit', null)).rejects.toThrow(/chk_acceptance_actor/);
    await expect(acceptance(id, 'deemed', '00000000-0000-4000-8000-000000000001')).rejects.toThrow(/chk_acceptance_actor/);
    await acceptance(id, 'deemed', null);
    await set(id, `status = 'accepted'`);
    await expect(pg.query(`UPDATE logistics.proof_of_delivery SET remarks = 'with_remarks' WHERE shipment_id = $1`, [id])).rejects.toThrow(/immutable/);
    await expect(pg.query(`DELETE FROM logistics.delivery_acceptance WHERE shipment_id = $1`, [id])).rejects.toThrow(/immutable/);
    await expect(
      pg.query(
        `INSERT INTO logistics.proof_of_delivery (shipment_id, received_by_name, received_at, delivered_to_snapshot, packages_received, remarks, source, recorded_by)
         VALUES ($1, 'R. Kumar', now(), '{}', 1, 'with_remarks', 'driver', gen_random_uuid())`,
        [await legTwo('picked_up')],
      ),
    ).rejects.toThrow(/chk_pod_remarks/);
  });

  it('lets only leg 2 be refused, held for "not received", and returned to awaiting acceptance', async () => {
    const refused = await legTwo('picked_up');
    await set(refused, `status = 'refused'`);
    await expect(set(refused, `status = 'receiving_check'`)).rejects.toThrow(/invalid shipment transition: refused -> receiving_check/);

    const missing = await legTwo('delivered_to_destination');
    await set(missing, `status = 'discrepancy_hold'`);

    const held = await legTwo('delivered_to_destination');
    await pod(held);
    await set(held, `status = 'receiving_check'`);
    await set(held, `status = 'discrepancy_hold'`);
    await set(held, `status = 'receiving_check'`);

    // Leg 1 keeps IN-16's machine.
    const inbound = (await one<{ id: string }>(
      `INSERT INTO logistics.shipment (number, leg, sales_order_id, shipper_organization_id, consignee_organization_id, created_by) VALUES ('SH-2026-9001', 'customer_to_jobwork', $1, $2, $3, gen_random_uuid()) RETURNING id`,
      [orderId, customer, internal],
    )).id;
    await set(inbound, `status = 'planned'`);
    await set(inbound, `status = 'ready_for_release'`);
    await set(inbound, `status = 'released', released_at = now(), release_snapshot = '{}', origin_snapshot = '{}', destination_snapshot = '{}'`);
    await set(inbound, `status = 'picked_up', picked_up_at = now(), carrier_mode = 'carrier'`);
    await expect(set(inbound, `status = 'refused'`)).rejects.toThrow(/invalid shipment transition: picked_up -> refused/);
    await expect(set(inbound, `acceptance_due_at = now()`)).rejects.toThrow(/chk_shipment_acceptance_due/);
  });

  it('freezes the packing check at release', async () => {
    const planned = await legTwo('planned');
    await set(planned, `packing_check = '{"neutralCartons": true, "supplierMarksRemoved": true}'`);
    const released = await legTwo('released');
    await expect(set(released, `packing_check = '{}'`)).rejects.toThrow(/keeps its addresses, documents, packing check/);
  });

  it('keeps address confirmations and decides an override once, for one pending request per guard', async () => {
    const id = await legTwo('planned');
    await expect(pg.query(`INSERT INTO logistics.address_confirmation (shipment_id, site_id, snapshot_hash, party, confirmed_by) VALUES ($1, $2, 'h', 'jobwork', gen_random_uuid())`, [id, siteId])).rejects.toThrow(
      /chk_confirmation_note/,
    );
    const c = await one<{ id: string }>(`INSERT INTO logistics.address_confirmation (shipment_id, site_id, snapshot_hash, party, confirmed_by) VALUES ($1, $2, 'h', 'customer', gen_random_uuid()) RETURNING id`, [id, siteId]);
    await expect(pg.query(`UPDATE logistics.address_confirmation SET snapshot_hash = 'x' WHERE id = $1`, [c.id])).rejects.toThrow(/immutable/);

    const policy = await one<{ id: string }>(`SELECT v.id FROM commercial.approval_policy p JOIN commercial.approval_policy_version v ON v.policy_id = p.id WHERE p.kind = 'dispatch_override'`);
    const request = async (): Promise<string> =>
      (await one<{ id: string }>(
        `INSERT INTO commercial.approval_request (kind, subject_type, subject_id, subject_version_no, subject_hash, policy_version_id, requested_by, context, required_roles)
         VALUES ('dispatch_override', 'shipment', $1, 1, 'h', $2, gen_random_uuid(), '{}'::jsonb, ARRAY['jobwork_finance']) RETURNING id`,
        [id, policy.id],
      )).id;
    const override = (approvalId: string, reasons = '["Balance unpaid."]') =>
      pg.query(
        `INSERT INTO logistics.dispatch_override (shipment_id, guard_key, reasons, reasons_hash, justification, approval_request_id, requested_by) VALUES ($1, 'payment', $2, 'r', 'Customer pays on delivery by agreement', $3, gen_random_uuid()) RETURNING id`,
        [id, reasons, approvalId],
      );
    await expect(override(await request(), '[]')).rejects.toThrow(/dispatch_override_reasons_check/);
    const first = (await override(await request())).rows[0] as { id: string };
    await expect(override(await request())).rejects.toThrow(/uq_dispatch_override_pending/);
    await expect(pg.query(`UPDATE logistics.dispatch_override SET status = 'approved' WHERE id = $1`, [first.id])).rejects.toThrow(/chk_override_decided/);
    await expect(pg.query(`UPDATE logistics.dispatch_override SET reasons = '["Other."]' WHERE id = $1`, [first.id])).rejects.toThrow(/decided once/);
    await pg.query(`UPDATE logistics.dispatch_override SET status = 'approved', decided_by = gen_random_uuid(), decided_at = now() WHERE id = $1`, [first.id]);
    await expect(pg.query(`UPDATE logistics.dispatch_override SET status = 'rejected' WHERE id = $1`, [first.id])).rejects.toThrow(/decided once/);
    await override(await request());
  });

  it('records a delivery exception as raised and resolves it once, with an address change carrying its own snapshot', async () => {
    const id = await legTwo('picked_up');
    const raise = (kind: string, snapshot: string | null) =>
      pg.query(
        `INSERT INTO logistics.delivery_exception (number, shipment_id, kind, raised_by_party, raised_by, description, requested_snapshot) VALUES ($1, $2, $3, 'customer', gen_random_uuid(), 'Deliver to the Hosur plant instead', $4) RETURNING id`,
        [`DX-2026-${String((n += 1)).padStart(4, '0')}`, id, kind, snapshot],
      );
    await expect(raise('address_change', null)).rejects.toThrow(/chk_exception_address/);
    await expect(raise('damage', '{"city": "Hosur"}')).rejects.toThrow(/chk_exception_address/);
    const x = (await raise('address_change', '{"city": "Hosur"}')).rows[0] as { id: string };
    await expect(pg.query(`UPDATE logistics.delivery_exception SET status = 'resolved', resolution = 'redirected', resolved_by = gen_random_uuid(), resolved_at = now() WHERE id = $1`, [x.id])).rejects.toThrow(/chk_exception_resolved/);
    await expect(pg.query(`UPDATE logistics.delivery_exception SET requested_snapshot = '{"city": "Madurai"}' WHERE id = $1`, [x.id])).rejects.toThrow(/raised and resolved once/);
    await pg.query(`UPDATE logistics.delivery_exception SET status = 'resolved', resolution = 'redirected', resolution_note = 'Carrier rerouted, ref RR-12', resolved_by = gen_random_uuid(), resolved_at = now() WHERE id = $1`, [x.id]);
    await expect(pg.query(`UPDATE logistics.delivery_exception SET case_reference = 'CASE-1' WHERE id = $1`, [x.id])).rejects.toThrow(/raised and resolved once/);
    // The shipment's own destination is a contract snapshot (doc 19 §8).
    await expect(set(id, `destination_snapshot = '{"city": "Hosur"}'`)).rejects.toThrow(/keeps its addresses/);
  });

  it('brings dispatched stock back onto the same lot on a return leg', async () => {
    const outbound = await legTwo('picked_up');
    await set(outbound, `status = 'refused'`);
    const inbound = (await one<{ id: string }>(
      `INSERT INTO logistics.shipment (number, leg, sales_order_id, shipper_organization_id, consignee_organization_id, returns_shipment_id, created_by) VALUES ('SH-2026-9100', 'customer_to_jobwork', $1, $2, $3, $4, gen_random_uuid()) RETURNING id`,
      [orderId, customer, internal, outbound],
    )).id;
    await expect(
      pg.query(
        `INSERT INTO logistics.shipment (number, leg, sales_order_id, shipper_organization_id, consignee_organization_id, returns_shipment_id, created_by) VALUES ('SH-2026-9101', 'customer_to_jobwork', $1, $2, $3, $4, gen_random_uuid())`,
        [orderId, customer, internal, outbound],
      ),
    ).rejects.toThrow(/uq_shipment_return/);
    await expect(
      pg.query(
        `INSERT INTO logistics.shipment (number, leg, sales_order_id, shipper_organization_id, consignee_organization_id, returns_shipment_id, created_by) VALUES ('SH-2026-9102', 'jobwork_to_customer', $1, $2, $3, $4, gen_random_uuid())`,
        [orderId, internal, customer, inbound],
      ),
    ).rejects.toThrow(/chk_shipment_return_leg/);
    await expect(set(inbound, `returns_shipment_id = NULL`)).rejects.toThrow(/keeps its leg and its parties/);

    const lot = (await one<{ id: string }>(`INSERT INTO logistics.stock_lot (lot_code, sales_order_id, source_shipment_id, received_quantity, created_by) VALUES ('LOT-R', $1, $2, 10, gen_random_uuid()) RETURNING id`, [orderId, inbound])).id;
    const move = (from: string | null, to: string, q: number, type: string) =>
      pg.query(`INSERT INTO logistics.stock_movement (lot_id, from_location_id, to_location_id, quantity, type, operation, created_by) VALUES ($1, $2, $3, $4, $5, 'test', gen_random_uuid())`, [lot, from ? loc[from] : null, loc[to], q, type]);
    await move(null, 'JW-STOCK', 10, 'receive');
    await move('JW-STOCK', 'OUT-DISPATCHED', 10, 'dispatch');
    await expect(move('OUT-DISPATCHED', 'JW-STOCK', 11, 'return')).rejects.toThrow(/over-draw refused/);
    await move('OUT-DISPATCHED', 'JW-STOCK', 8, 'return');
    await move('OUT-DISPATCHED', 'JW-QUARANTINE', 2, 'return');
    const b = Object.fromEntries((await pg.query<{ code: string; quantity: string }>(`SELECT l.code, b.quantity FROM logistics.stock_balance b JOIN logistics.custody_location l ON l.id = b.location_id WHERE b.lot_id = $1`, [lot])).rows.map((r) => [r.code, Number(r.quantity)]));
    expect(b).toEqual({ 'JW-STOCK': 8, 'JW-QUARANTINE': 2, 'OUT-DISPATCHED': 0 });
  });
});
