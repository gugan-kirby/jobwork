import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureDatabase, runMigrations } from '../src/migrate';
import { registerPgTypeParsers } from '../src/pg-types';

registerPgTypeParsers();

const BASE_URL = process.env['DATABASE_URL'] ?? 'postgres://localhost:5432/jobwork_dev';
const TEST_DB = `jobwork_qualitydb_${randomBytes(4).toString('hex')}`;

function url(): string {
  const u = new URL(BASE_URL);
  u.pathname = `/${TEST_DB}`;
  return u.toString();
}

/**
 * The quality schema (IN-14 F-14.1): versioned unit conversions with exact factors, templates
 * and approved plans that never change, the doc 06 §10 inspection machine with an independent
 * reviewer, and results that are only ever superseded, never rewritten.
 */
describe('quality schema (F-14.1)', () => {
  let pg: Client;
  let customer: { id: string };
  let orderId: string;
  let poId: string;
  let supplierOrg: string;
  let workPackageId: string;
  let baselineId: string;
  let templateVersionId: string;
  let certificateVersionId: string;
  let n = 0;

  const one = async <T>(sql: string, args: unknown[] = []): Promise<T> => (await pg.query(sql, args)).rows[0] as T;
  const sha = (): string => randomBytes(32).toString('hex');

  async function plan(): Promise<string> {
    n += 1;
    return (await one<{ id: string }>(
      `INSERT INTO quality.quality_plan (work_package_id, version_no, template_version_id, baseline_id, stages, created_by)
       VALUES ($1, $2, $3, $4, '[{"stage": "fai", "sampleSize": 1}]', gen_random_uuid()) RETURNING id`,
      [workPackageId, n, templateVersionId, baselineId],
    )).id;
  }

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

  it('seeds exact, cited conversions onto one normalized unit per dimension, and never rewrites them', async () => {
    const rows = await pg.query<{ from_unit: string; to_unit: string; factor_num: string; factor_den: string; offset_num: string; offset_den: string }>(
      `SELECT c.from_unit, c.to_unit, c.factor_num, c.factor_den, c.offset_num, c.offset_den
         FROM quality.unit_conversion c JOIN quality.unit_conversion_version v ON v.id = c.version_id
        WHERE v.status = 'active' ORDER BY c.from_unit COLLATE "C"`,
    );
    expect(rows.rows.map((r) => [r.from_unit, r.to_unit, `${r.factor_num}/${r.factor_den}`, `${r.offset_num}/${r.offset_den}`])).toEqual([
      ['K', 'degC', '1/1', '-27315/100'],
      ['degF', 'degC', '5/9', '-160/9'],
      ['g', 'kg', '1/1000', '0/1'],
      ['inch', 'mm', '254/10', '0/1'],
      ['m', 'mm', '1000/1', '0/1'],
      ['um', 'mm', '1/1000', '0/1'],
    ]);
    // Hardness scales have no exact conversion, so none is seeded and none can be added onto a non-normalized unit.
    const version = await one<{ id: string }>(`SELECT id FROM quality.unit_conversion_version WHERE status = 'active'`);
    await expect(pg.query(`INSERT INTO quality.unit_conversion (version_id, from_unit, to_unit, factor_num, factor_den, citation) VALUES ($1, 'HRB', 'HRC', 1, 1, 'guess')`, [version.id])).rejects.toThrow(/normalized unit of its own dimension/);
    await expect(pg.query(`INSERT INTO quality.unit_conversion (version_id, from_unit, to_unit, factor_num, factor_den, citation) VALUES ($1, 'g', 'mm', 1, 1, 'wrong')`, [version.id])).rejects.toThrow(/normalized unit of its own dimension/);
    await expect(pg.query(`UPDATE quality.unit_conversion SET factor_num = 25 WHERE from_unit = 'inch'`)).rejects.toThrow(/immutable/);
    await expect(pg.query(`UPDATE quality.unit_conversion_version SET source = 'edited' WHERE id = $1`, [version.id])).rejects.toThrow(/only retired/);
    await expect(pg.query(`INSERT INTO quality.unit (code, dimension, label, is_normalized) VALUES ('cm', 'length', 'centimetre', true)`)).rejects.toThrow(/uq_unit_normalized/);
  });

  it('keeps template versions as they were activated', async () => {
    const t = await one<{ stages: unknown; characteristics: Array<{ name: string }> }>(`SELECT stages, characteristics FROM quality.plan_template_version WHERE id = $1`, [templateVersionId]);
    expect(t.stages).toEqual([{ stage: 'fai', sampleSize: 1 }, { stage: 'final', sampleSize: 5 }]);
    expect(t.characteristics.map((c) => c.name)).toEqual(['Visual: free of burrs and sharp edges', 'Surface roughness Ra']);
    await expect(pg.query(`UPDATE quality.plan_template_version SET characteristics = '[]' WHERE id = $1`, [templateVersionId])).rejects.toThrow(/only retired/);
    await expect(pg.query(`DELETE FROM quality.plan_template_version WHERE id = $1`, [templateVersionId])).rejects.toThrow(/only retired/);
  });

  it('shapes characteristics: limits with an inclusivity each, or accepted values, never both', async () => {
    const p = await plan();
    await characteristic(p, 1);
    await expect(pg.query(`INSERT INTO quality.characteristic (plan_id, seq, name, kind, criticality, unit, stages) VALUES ($1, 3, 'No limits', 'variable', 'major', 'mm', ARRAY['fai'])`, [p])).rejects.toThrow(/chk_characteristic_shape/);
    await expect(pg.query(`INSERT INTO quality.characteristic (plan_id, seq, name, kind, criticality, unit, upper_limit, stages) VALUES ($1, 4, 'No inclusivity', 'variable', 'major', 'mm', 1, ARRAY['fai'])`, [p])).rejects.toThrow(/chk_characteristic_shape/);
    await expect(pg.query(`INSERT INTO quality.characteristic (plan_id, seq, name, kind, criticality, unit, lower_limit, lower_inclusive, upper_limit, upper_inclusive, stages) VALUES ($1, 5, 'Inverted', 'variable', 'major', 'mm', 2, true, 1, true, ARRAY['fai'])`, [p])).rejects.toThrow(/chk_characteristic_shape/);
    await expect(pg.query(`INSERT INTO quality.characteristic (plan_id, seq, name, kind, criticality, unit, accepted_values, stages) VALUES ($1, 6, 'Unit on attribute', 'attribute', 'minor', 'mm', ARRAY['ok'], ARRAY['fai'])`, [p])).rejects.toThrow(/chk_characteristic_shape/);
    await expect(pg.query(`INSERT INTO quality.characteristic (plan_id, seq, name, kind, criticality, accepted_values, stages) VALUES ($1, 7, 'Bad stage', 'attribute', 'minor', ARRAY['ok'], ARRAY['shipping'])`, [p])).rejects.toThrow(/chk_characteristic_stages/);
    // An exact target is allowed only when both bounds include it.
    await pg.query(`INSERT INTO quality.characteristic (plan_id, seq, name, kind, criticality, unit, lower_limit, lower_inclusive, upper_limit, upper_inclusive, stages) VALUES ($1, 8, 'Gauge pin', 'variable', 'minor', 'mm', 5, true, 5, true, ARRAY['fai'])`, [p]);
    await pg.query(`INSERT INTO quality.characteristic (plan_id, seq, name, kind, criticality, accepted_values, stages) VALUES ($1, 9, 'Visual', 'attribute', 'minor', ARRAY['conforming'], ARRAY['fai', 'final'])`, [p]);
  });

  it('freezes a plan and its characteristics on approval; one approved plan per work package', async () => {
    // Retire the previous test's draft so this work package starts clean.
    await pg.query(`UPDATE quality.quality_plan SET status = 'approved', approved_by = gen_random_uuid(), approved_at = now() WHERE status = 'draft'`);
    await pg.query(`UPDATE quality.quality_plan SET status = 'superseded' WHERE status = 'approved'`);

    const p = await plan();
    const c = await characteristic(p, 1);
    await expect(pg.query(`UPDATE quality.quality_plan SET status = 'approved' WHERE id = $1`, [p])).rejects.toThrow(/chk_plan_approved/);
    await pg.query(`UPDATE quality.quality_plan SET status = 'approved', approved_by = gen_random_uuid(), approved_at = now() WHERE id = $1`, [p]);
    await expect(pg.query(`UPDATE quality.quality_plan SET stages = '[]' WHERE id = $1`, [p])).rejects.toThrow(/frozen/);
    await expect(pg.query(`UPDATE quality.characteristic SET upper_limit = 13 WHERE id = $1`, [c])).rejects.toThrow(/frozen/);
    await expect(characteristic(p, 2)).rejects.toThrow(/frozen/);
    await expect(pg.query(`DELETE FROM quality.characteristic WHERE id = $1`, [c])).rejects.toThrow(/frozen/);
    await expect(pg.query(`UPDATE quality.quality_plan SET status = 'draft' WHERE id = $1`, [p])).rejects.toThrow(/invalid quality plan transition: approved -> draft/);

    const second = await plan();
    await expect(pg.query(`UPDATE quality.quality_plan SET status = 'approved', approved_by = gen_random_uuid(), approved_at = now() WHERE id = $1`, [second])).rejects.toThrow(/uq_quality_plan_approved/);
    await expect(plan()).rejects.toThrow(/uq_quality_plan_draft/);
    n -= 1;
    await pg.query(`UPDATE quality.quality_plan SET status = 'superseded' WHERE id = $1`, [p]);
    await pg.query(`UPDATE quality.quality_plan SET status = 'approved', approved_by = gen_random_uuid(), approved_at = now() WHERE id = $1`, [second]);
  });

  it('walks the doc 06 §10 inspection machine with an independent reviewer; results are only superseded', async () => {
    // A fresh approved plan version with one characteristic replaces the previous test's.
    const previous = (await one<{ id: string }>(`SELECT id FROM quality.quality_plan WHERE work_package_id = $1 AND status = 'approved'`, [workPackageId])).id;
    const draft = await plan();
    const characteristicId = { id: await characteristic(draft, 1), planId: draft };
    await pg.query(`UPDATE quality.quality_plan SET status = 'superseded' WHERE id = $1`, [previous]);
    await pg.query(`UPDATE quality.quality_plan SET status = 'approved', approved_by = gen_random_uuid(), approved_at = now() WHERE id = $1`, [draft]);
    const insp = await one<{ id: string }>(
      `INSERT INTO quality.inspection (number, work_package_id, plan_id, baseline_id, stage, sample_size, inspecting_organization_id, planned_by)
       VALUES ('QI-2026-0001', $1, $2, $3, 'fai', 1, $4, gen_random_uuid()) RETURNING id`,
      [workPackageId, characteristicId.planId, baselineId, supplierOrg],
    );
    await expect(pg.query(`UPDATE quality.inspection SET status = 'passed' WHERE id = $1`, [insp.id])).rejects.toThrow(/invalid inspection transition: planned -> passed/);
    await expect(pg.query(`UPDATE quality.inspection SET stage = 'final' WHERE id = $1`, [insp.id])).rejects.toThrow(/keeps what it was planned against/);
    await pg.query(`UPDATE quality.inspection SET status = 'in_progress', started_by = gen_random_uuid(), started_at = now() WHERE id = $1`, [insp.id]);
    await expect(pg.query(`UPDATE quality.inspection SET status = 'results_submitted' WHERE id = $1`, [insp.id])).rejects.toThrow(/chk_inspection_submitted/);
    const submitter = (await one<{ id: string }>(`SELECT gen_random_uuid() AS id`)).id;
    await pg.query(`UPDATE quality.inspection SET status = 'results_submitted', submitted_by = $2, submitted_at = now(), inspected_at = now() WHERE id = $1`, [insp.id, submitter]);

    const sample = await one<{ id: string }>(`INSERT INTO quality.inspection_sample (inspection_id, sample_no, serial) VALUES ($1, 1, 'S-001') RETURNING id`, [insp.id]);
    const instrument = await one<{ id: string }>(`INSERT INTO quality.instrument (owner_organization_id, asset_tag, kind, unit, resolution, registered_by) VALUES ($1, 'MIC-01', 'Outside micrometer 0–25 mm', 'mm', 0.001, gen_random_uuid()) RETURNING id`, [supplierOrg]);
    const cal = await one<{ id: string }>(
      `INSERT INTO quality.calibration (instrument_id, performed_at, due_at, outcome, certificate_document_version_id, certificate_sha256, recorded_by) VALUES ($1, now() - interval '30 days', now() + interval '335 days', 'pass', $2, $3, gen_random_uuid()) RETURNING id`,
      [instrument.id, certificateVersionId, sha()],
    );
    const result = (args: { supersedes?: string; reason?: string; status?: string; instrument?: string | null; calibration?: string | null }): Promise<{ id: string }> =>
      one<{ id: string }>(
        `INSERT INTO quality.inspection_result (inspection_id, sample_id, characteristic_id, original_value, original_unit, declared_precision, normalized_value, normalized_unit, outcome, rule_version, instrument_id, calibration_id, calibration_status, supersedes_result_id, correction_reason, recorded_by)
         VALUES ($1, $2, $3, '12.010', 'mm', 3, 12.010, 'mm', 'pass', 'MEAS-1', $4, $5, $6, $7, $8, gen_random_uuid()) RETURNING id`,
        [insp.id, sample.id, characteristicId.id, args.instrument === undefined ? instrument.id : args.instrument, args.calibration === undefined ? cal.id : args.calibration, args.status ?? 'valid', args.supersedes ?? null, args.reason ?? null],
      );
    const first = await result({});
    await expect(pg.query(`UPDATE quality.inspection_result SET outcome = 'fail' WHERE id = $1`, [first.id])).rejects.toThrow(/immutable/);
    await expect(result({ supersedes: first.id })).rejects.toThrow(/chk_result_correction/);
    const corrected = await result({ supersedes: first.id, reason: 'Transcribed 12.100 as 12.010' });
    await expect(result({ supersedes: first.id, reason: 'Again' })).rejects.toThrow(/inspection_result_supersedes_result_id_key/);
    // An instrument means a calibration status; a valid status names its calibration.
    await expect(result({ instrument: null })).rejects.toThrow(/chk_result_instrument/);
    await expect(result({ calibration: null })).rejects.toThrow(/chk_result_calibration/);
    const expired = await result({ status: 'expired', calibration: null });
    await pg.query(`INSERT INTO quality.result_disposition (result_id, decision, reason, decided_by) VALUES ($1, 'accept', 'Re-checked on a calibrated gauge block', gen_random_uuid())`, [expired.id]);
    await expect(pg.query(`INSERT INTO quality.result_disposition (result_id, decision, reason, decided_by) VALUES ($1, 'reinspect', 'Second thoughts', gen_random_uuid())`, [expired.id])).rejects.toThrow(/result_disposition_result_id_key/);
    expect(corrected.id).toBeTruthy();
    // 0023: a unit nobody defined is kept as entered (judged cannot-evaluate), but only in the shape of a unit code.
    await pg.query(
      `INSERT INTO quality.inspection_result (inspection_id, sample_id, characteristic_id, original_value, original_unit, declared_precision, outcome, rule_version, calibration_status, recorded_by)
       VALUES ($1, $2, $3, '125', 'microinch', 0, 'cannot_evaluate', 'MEAS-1', 'not_required', gen_random_uuid())`,
      [insp.id, sample.id, characteristicId.id],
    );
    await expect(
      pg.query(
        `INSERT INTO quality.inspection_result (inspection_id, sample_id, characteristic_id, original_value, original_unit, declared_precision, outcome, rule_version, calibration_status, recorded_by)
         VALUES ($1, $2, $3, '125', 'µ in!', 0, 'cannot_evaluate', 'MEAS-1', 'not_required', gen_random_uuid())`,
        [insp.id, sample.id, characteristicId.id],
      ),
    ).rejects.toThrow(/chk_result_original_unit/);

    await pg.query(`UPDATE quality.inspection SET status = 'under_review', review_started_at = now() WHERE id = $1`, [insp.id]);
    // BR-QLT-03: the submitter never reviews.
    await expect(pg.query(`UPDATE quality.inspection SET status = 'passed', reviewer_id = $2, decided_at = now() WHERE id = $1`, [insp.id, submitter])).rejects.toThrow(/chk_inspection_independent/);
    await expect(pg.query(`UPDATE quality.inspection SET status = 'failed', reviewer_id = gen_random_uuid(), decided_at = now() WHERE id = $1`, [insp.id])).rejects.toThrow(/chk_inspection_failed_reason/);
    await pg.query(`UPDATE quality.inspection SET status = 'failed', reviewer_id = gen_random_uuid(), decided_at = now(), decision_reason = 'Bore oversize on S-001' WHERE id = $1`, [insp.id]);
    await expect(pg.query(`UPDATE quality.inspection SET status = 'under_review' WHERE id = $1`, [insp.id])).rejects.toThrow(/invalid inspection transition: failed -> under_review/);
    await expect(pg.query(`UPDATE quality.inspection SET status = 'invalidated' WHERE id = $1`, [insp.id])).rejects.toThrow(/chk_inspection_invalidated/);
    await pg.query(`UPDATE quality.inspection SET status = 'invalidated', invalidated_at = now(), invalidation_reason = 'Wrong lot measured' WHERE id = $1`, [insp.id]);
  });

  it('keeps calibrations as facts and instruments only ever retire', async () => {
    const instrument = await one<{ id: string }>(`INSERT INTO quality.instrument (owner_organization_id, asset_tag, kind, registered_by) VALUES ($1, 'CAL-02', 'Vernier caliper', gen_random_uuid()) RETURNING id`, [supplierOrg]);
    await expect(pg.query(`INSERT INTO quality.instrument (owner_organization_id, asset_tag, kind, registered_by) VALUES ($1, 'CAL-02', 'Duplicate', gen_random_uuid())`, [supplierOrg])).rejects.toThrow(/instrument_owner_organization_id_asset_tag_key/);
    await expect(
      pg.query(`INSERT INTO quality.calibration (instrument_id, performed_at, due_at, outcome, certificate_document_version_id, certificate_sha256, recorded_by) VALUES ($1, now(), now() - interval '1 day', 'pass', $2, $3, gen_random_uuid())`, [instrument.id, certificateVersionId, sha()]),
    ).rejects.toThrow(/chk_calibration_due/);
    const cal = await one<{ id: string }>(
      `INSERT INTO quality.calibration (instrument_id, performed_at, due_at, outcome, certificate_document_version_id, certificate_sha256, recorded_by) VALUES ($1, now(), now() + interval '1 year', 'pass', $2, $3, gen_random_uuid()) RETURNING id`,
      [instrument.id, certificateVersionId, sha()],
    );
    await expect(pg.query(`UPDATE quality.calibration SET due_at = now() + interval '5 years' WHERE id = $1`, [cal.id])).rejects.toThrow(/immutable/);
    await pg.query(`UPDATE quality.instrument SET status = 'retired' WHERE id = $1`, [instrument.id]);
    await expect(pg.query(`UPDATE quality.instrument SET status = 'in_service' WHERE id = $1`, [instrument.id])).rejects.toThrow(/invalid instrument transition: retired -> in_service/);
    await expect(pg.query(`UPDATE quality.instrument SET asset_tag = 'CAL-03' WHERE id = $1`, [instrument.id])).rejects.toThrow(/keeps its owner and asset tag/);
    expect(customer.id).toBeTruthy();
  });
});
