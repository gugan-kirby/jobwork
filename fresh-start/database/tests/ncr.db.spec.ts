import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureDatabase, runMigrations } from '../src/migrate';
import { registerPgTypeParsers } from '../src/pg-types';

registerPgTypeParsers();

const BASE_URL = process.env['DATABASE_URL'] ?? 'postgres://localhost:5432/jobwork_dev';
const TEST_DB = `jobwork_ncrdb_${randomBytes(4).toString('hex')}`;

function url(): string {
  const u = new URL(BASE_URL);
  u.pathname = `/${TEST_DB}`;
  return u.toString();
}

/**
 * NCR, deviation and release schema (IN-15 F-15.1): the doc 06 §10 NCR machine with its scope
 * fixed, dispositions decided once, independent closure, deviations decided exactly as asked
 * and bounded in time, and releases that are never rewritten.
 */
describe('NCR, deviation and release schema (F-15.1)', () => {
  let pg: Client;
  let customer: { id: string };
  let orderId: string;
  let poId: string;
  let supplierOrg: string;
  let workPackageId: string;
  let baselineId: string;
  let templateVersionId: string;
  let certificateVersionId: string;

  const one = async <T>(sql: string, args: unknown[] = []): Promise<T> => (await pg.query(sql, args)).rows[0] as T;
  const sha = (): string => randomBytes(32).toString('hex');

  async function characteristic(planId: string, seq: number): Promise<string> {
    return (await one<{ id: string }>(
      `INSERT INTO quality.characteristic (plan_id, seq, drawing_reference, name, kind, criticality, unit, nominal, lower_limit, lower_inclusive, upper_limit, upper_inclusive, stages)
       VALUES ($1, $2, '7', 'Bore diameter', 'variable', 'critical', 'mm', 12, 11.98, true, 12.02, true, ARRAY['fai']) RETURNING id`,
      [planId, seq],
    )).id;
  }

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
    baselineId = (await one<{ id: string }>(`INSERT INTO dms.baseline (number, sales_order_id, created_by) VALUES ('BL-2026-0001', $1, gen_random_uuid()) RETURNING id`, [orderId])).id;
    templateVersionId = (await one<{ id: string }>(`SELECT v.id FROM quality.plan_template_version v JOIN quality.plan_template t ON t.id = v.template_id WHERE t.code = 'cnc_machined_part' AND v.version_no = 1`)).id;
    const file = await one<{ id: string }>(
      `INSERT INTO dms.file_object (storage_key, byte_size, declared_media_type, sha256, scan_state, owning_organization_id) VALUES ('cal/1', 10, 'application/pdf', $1, 'clean', $2) RETURNING id`,
      [sha(), supplierOrg],
    );
    const doc = await one<{ id: string }>(`INSERT INTO dms.document (owning_organization_id, logical_type, title, current_version_no) VALUES ($1, 'certificate', 'Micrometer calibration', 1) RETURNING id`, [supplierOrg]);
    certificateVersionId = (await one<{ id: string }>(
      `INSERT INTO dms.document_version (document_id, version_no, file_object_id, original_filename, status, created_by) VALUES ($1, 1, $2, 'cal.pdf', 'available', gen_random_uuid()) RETURNING id`,
      [doc.id, file.id],
    )).id;
  }, 60_000);

  afterAll(async () => {
    await pg?.end();
    const admin = new Client({ connectionString: BASE_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB}" WITH (FORCE)`);
    await admin.end();
  });

  let inspectionId: string;
  let resultId: string;
  let characteristicId: string;
  let m = 0;

  async function ncr(overrides: Partial<{ severity: string; parent: string | null }> = {}): Promise<string> {
    m += 1;
    return (await one<{ id: string }>(
      `INSERT INTO quality.ncr (number, work_package_id, inspection_id, baseline_id, parent_ncr_id, title, description, severity, detection_stage, affected_quantity, lots, owner_id, due_at, corrective_action_required, opened_by)
       VALUES ($1, $2, $3, $4, $5, 'Bore oversize', 'Bore 12.03 on FA-001', $6, 'fai', 5, ARRAY['L1'], gen_random_uuid(), now() + interval '5 days', true, gen_random_uuid()) RETURNING id`,
      [`NCR-2026-${String(m).padStart(4, '0')}`, workPackageId, inspectionId, baselineId, overrides.parent ?? null, overrides.severity ?? 'critical'],
    )).id;
  }
  const move = (id: string, status: string, extra = '') => pg.query(`UPDATE quality.ncr SET status = '${status}' ${extra} WHERE id = $1`, [id]);

  beforeAll(async () => {
    const planId = (await one<{ id: string }>(
      `INSERT INTO quality.quality_plan (work_package_id, version_no, template_version_id, baseline_id, stages, created_by) VALUES ($1, 1, $2, $3, '[{"stage": "fai", "sampleSize": 1}]', gen_random_uuid()) RETURNING id`,
      [workPackageId, templateVersionId, baselineId],
    )).id;
    characteristicId = await characteristic(planId, 1);
    await pg.query(`UPDATE quality.quality_plan SET status = 'approved', approved_by = gen_random_uuid(), approved_at = now() WHERE id = $1`, [planId]);
    inspectionId = (await one<{ id: string }>(
      `INSERT INTO quality.inspection (number, work_package_id, plan_id, baseline_id, stage, sample_size, inspecting_organization_id, planned_by) VALUES ('QI-2026-0001', $1, $2, $3, 'fai', 1, $4, gen_random_uuid()) RETURNING id`,
      [workPackageId, planId, baselineId, supplierOrg],
    )).id;
    const sample = await one<{ id: string }>(`INSERT INTO quality.inspection_sample (inspection_id, sample_no) VALUES ($1, 1) RETURNING id`, [inspectionId]);
    resultId = (await one<{ id: string }>(
      `INSERT INTO quality.inspection_result (inspection_id, sample_id, characteristic_id, original_value, original_unit, declared_precision, outcome, rule_version, calibration_status, recorded_by)
       VALUES ($1, $2, $3, '12.03', 'mm', 2, 'fail', 'MEAS-1', 'not_required', gen_random_uuid()) RETURNING id`,
      [inspectionId, sample.id, characteristicId],
    )).id;
  }, 60_000);

  it('walks the doc 06 §10 NCR machine and keeps the scope it was opened with', async () => {
    const id = await ncr();
    await expect(move(id, 'rework')).rejects.toThrow(/invalid NCR transition: open -> rework/);
    await move(id, 'containment');
    await move(id, 'disposition_pending', ', attempt_no = 1');
    await expect(pg.query(`UPDATE quality.ncr SET affected_quantity = 2 WHERE id = $1`, [id])).rejects.toThrow(/keeps the scope/);
    await expect(pg.query(`UPDATE quality.ncr SET lots = ARRAY['L2'] WHERE id = $1`, [id])).rejects.toThrow(/keeps the scope/);
    await move(id, 'rework');
    await move(id, 'reinspection');
    await move(id, 'disposition_pending', ', attempt_no = 2');
    await expect(pg.query(`UPDATE quality.ncr SET attempt_no = 1 WHERE id = $1`, [id])).rejects.toThrow(/never forgets an attempt/);
    await move(id, 'deviation_pending');
    await expect(move(id, 'closed')).rejects.toThrow(/invalid NCR transition: deviation_pending -> closed/);
    await move(id, 'accepted_under_deviation', ', disposition_decided_by = gen_random_uuid()');
    await expect(move(id, 'closed', ', closed_by = gen_random_uuid(), closed_at = now()')).rejects.toThrow(/chk_ncr_closed/);
    // BR-QLT-06: the person who decided the disposition cannot close it.
    await expect(move(id, 'closed', ', closed_by = disposition_decided_by, closed_at = now(), closure_note = $$Closing my own$$')).rejects.toThrow(/chk_ncr_independent_closure/);
    await move(id, 'closed', ', closed_by = gen_random_uuid(), closed_at = now(), closure_note = $$Reinspection passed, CA verified$$');
    await expect(move(id, 'open')).rejects.toThrow(/invalid NCR transition: closed -> open/);
    // A new defect found while working it branches with lineage.
    const child = await ncr({ parent: id, severity: 'major' });
    expect((await one<{ parent_ncr_id: string }>(`SELECT parent_ncr_id FROM quality.ncr WHERE id = $1`, [child])).parent_ncr_id).toBe(id);
  });

  it('records each failed result once and never rewrites containment', async () => {
    const id = await ncr();
    await pg.query(`INSERT INTO quality.ncr_defect (ncr_id, result_id, characteristic_id) VALUES ($1, $2, $3)`, [id, resultId, characteristicId]);
    await expect(pg.query(`INSERT INTO quality.ncr_defect (ncr_id, result_id, characteristic_id) VALUES ($1, $2, $3)`, [id, resultId, characteristicId])).rejects.toThrow(/ncr_defect_ncr_id_result_id_key/);
    await expect(pg.query(`DELETE FROM quality.ncr_defect WHERE ncr_id = $1`, [id])).rejects.toThrow(/immutable/);
    const c = await one<{ id: string }>(`INSERT INTO quality.ncr_containment (ncr_id, action, location, quantity, recorded_by, recorded_by_organization_id) VALUES ($1, 'Lot L1 tagged red and quarantined', 'Bay 3', 5, gen_random_uuid(), $2) RETURNING id`, [id, supplierOrg]);
    await expect(pg.query(`UPDATE quality.ncr_containment SET action = 'nothing' WHERE id = $1`, [c.id])).rejects.toThrow(/immutable/);
    // The failed result itself is untouched by anything an NCR does.
    expect((await one<{ outcome: string }>(`SELECT outcome FROM quality.inspection_result WHERE id = $1`, [resultId])).outcome).toBe('fail');
  });

  it('decides a disposition once and records rework, reinspection and outcome once each', async () => {
    const id = await ncr();
    await expect(pg.query(`INSERT INTO quality.ncr_disposition (ncr_id, attempt_no, disposition, decided_by) VALUES ($1, 1, 'rework', gen_random_uuid())`, [id])).rejects.toThrow(/chk_disposition_plan/);
    const d = await one<{ id: string }>(`INSERT INTO quality.ncr_disposition (ncr_id, attempt_no, disposition, plan, decided_by) VALUES ($1, 1, 'rework', 'Re-bore to 12.00 on the VMC; deburr', gen_random_uuid()) RETURNING id`, [id]);
    await expect(pg.query(`INSERT INTO quality.ncr_disposition (ncr_id, attempt_no, disposition, plan, decided_by) VALUES ($1, 1, 'scrap', '', gen_random_uuid())`, [id])).rejects.toThrow(/ncr_disposition_ncr_id_attempt_no_key/);
    await pg.query(`UPDATE quality.ncr_disposition SET rework_note = 'Re-bored', rework_recorded_by = gen_random_uuid(), rework_recorded_at = now() WHERE id = $1`, [d.id]);
    await expect(pg.query(`UPDATE quality.ncr_disposition SET rework_note = 'Edited' WHERE id = $1`, [d.id])).rejects.toThrow(/decided once/);
    await expect(pg.query(`UPDATE quality.ncr_disposition SET plan = 'Another plan' WHERE id = $1`, [d.id])).rejects.toThrow(/decided once/);
    await pg.query(`UPDATE quality.ncr_disposition SET reinspection_id = $2, outcome = 'verified' WHERE id = $1`, [d.id, inspectionId]);
    await expect(pg.query(`UPDATE quality.ncr_disposition SET outcome = 'still_nonconforming' WHERE id = $1`, [d.id])).rejects.toThrow(/decided once/);
    await expect(pg.query(`DELETE FROM quality.ncr_disposition WHERE id = $1`, [d.id])).rejects.toThrow(/decided once/);
  });

  it('accepts a corrective action only with occurrence and escape causes, and verifies it last', async () => {
    const id = await ncr();
    const ca = await one<{ id: string }>(`INSERT INTO quality.corrective_action (ncr_id, due_at, requested_by) VALUES ($1, now() + interval '10 days', gen_random_uuid()) RETURNING id`, [id]);
    await expect(pg.query(`UPDATE quality.corrective_action SET status = 'responded', problem_definition = 'Oversize bore' WHERE id = $1`, [ca.id])).rejects.toThrow(/chk_ca_responded/);
    await pg.query(
      `UPDATE quality.corrective_action SET status = 'responded', problem_definition = 'Oversize bore', occurrence_cause = 'Worn boring bar', escape_cause = 'Bore gauge not used at first-off', actions = '[{"action": "Tool life limit", "owner": "Setter", "dueDate": "2026-10-20"}]' WHERE id = $1`,
      [ca.id],
    );
    await expect(pg.query(`UPDATE quality.corrective_action SET status = 'verified' WHERE id = $1`, [ca.id])).rejects.toThrow(/invalid corrective action transition: responded -> verified/);
    await pg.query(`UPDATE quality.corrective_action SET status = 'accepted', accepted_by = gen_random_uuid(), accepted_at = now() WHERE id = $1`, [ca.id]);
    await expect(pg.query(`UPDATE quality.corrective_action SET status = 'verified', verified_by = gen_random_uuid() WHERE id = $1`, [ca.id])).rejects.toThrow(/chk_ca_verified/);
    await pg.query(`UPDATE quality.corrective_action SET status = 'verified', verified_by = gen_random_uuid(), verified_at = now(), effectiveness_evidence = 'Next two FAIs passed at mid-tolerance' WHERE id = $1`, [ca.id]);
  });

  it('decides a deviation exactly as requested, within 180 days', async () => {
    const id = await ncr();
    const dev = (expiry: string) =>
      one<{ id: string }>(
        `INSERT INTO quality.deviation (number, ncr_id, characteristic_ids, quantity, lots, expires_at, rationale, risk_assessment, fit_function_safety, customer_approval_required, requested_by)
         VALUES ($1, $2, ARRAY[$3::uuid], 5, ARRAY['L1'], now() + interval '${expiry}', 'Bore at 12.03 still assembles', 'Low: clearance fit', 'No effect on fit or safety', true, gen_random_uuid()) RETURNING id`,
        [`DV-2026-${randomBytes(2).toString('hex')}`, id, characteristicId],
      );
    await expect(dev('200 days')).rejects.toThrow(/chk_deviation_expiry/);
    const d = await dev('90 days');
    await expect(pg.query(`UPDATE quality.deviation SET quantity = 50 WHERE id = $1`, [d.id])).rejects.toThrow(/exactly as it was requested/);
    await expect(pg.query(`UPDATE quality.deviation SET status = 'approved' WHERE id = $1`, [d.id])).rejects.toThrow(/chk_deviation_decided/);
    await pg.query(`UPDATE quality.deviation SET status = 'pending_customer' WHERE id = $1`, [d.id]);
    await pg.query(`INSERT INTO quality.deviation_customer_decision (deviation_id, decision, decided_by, membership_id, authority_snapshot) VALUES ($1, 'approved', gen_random_uuid(), gen_random_uuid(), '{}')`, [d.id]);
    await expect(pg.query(`UPDATE quality.deviation_customer_decision SET decision = 'rejected' WHERE deviation_id = $1`, [d.id])).rejects.toThrow(/immutable/);
    await pg.query(`UPDATE quality.deviation SET status = 'approved', decided_at = now() WHERE id = $1`, [d.id]);
    await expect(pg.query(`UPDATE quality.deviation SET status = 'pending_internal' WHERE id = $1`, [d.id])).rejects.toThrow(/invalid deviation transition: approved -> pending_internal/);
    const policy = await one<{ rules: { approverRoles: string[] } }>(`SELECT v.rules FROM commercial.approval_policy p JOIN commercial.approval_policy_version v ON v.policy_id = p.id WHERE p.kind = 'deviation'`);
    expect(policy.rules.approverRoles).toEqual(['jobwork_quality', 'jobwork_engineering']);
  });

  it('never rewrites a quality release', async () => {
    const r = await one<{ id: string }>(
      `INSERT INTO quality.quality_release (number, work_package_id, quantity, lots, checklist, snapshot_sha256, released_by) VALUES ('QR-2026-0001', $1, 5, ARRAY['L1'], '{"items": []}', $2, gen_random_uuid()) RETURNING id`,
      [workPackageId, randomBytes(32).toString('hex')],
    );
    await expect(pg.query(`UPDATE quality.quality_release SET quantity = 10 WHERE id = $1`, [r.id])).rejects.toThrow(/immutable/);
    await expect(pg.query(`DELETE FROM quality.quality_release WHERE id = $1`, [r.id])).rejects.toThrow(/immutable/);
    await expect(pg.query(`INSERT INTO quality.quality_release (number, work_package_id, quantity, checklist, snapshot_sha256, released_by) VALUES ('QR-2026-0002', $1, 5, '{}', 'not-a-hash', gen_random_uuid())`, [workPackageId])).rejects.toThrow(/snapshot_sha256_check/);
    expect(customer.id).toBeTruthy();
    expect(certificateVersionId).toBeTruthy();
  });
});
