-- Quality plans, inspections and instruments (IN-14 F-14.1; doc 09 §§9–10, §16; doc 05 §§4, 9, 18;
-- doc 06 §10; FR-701–FR-702; BR-QLT-03, BR-QLT-05).
--
-- A work package's quality plan is a versioned set of characteristics bound to the baseline it
-- was written against. An inspection runs one stage of that plan on samples; every result keeps
-- the value and unit as entered, its normalized form, the rule and conversion versions that
-- judged it, and the instrument's calibration status at the time. Results are never rewritten:
-- a correction is a new row that supersedes the old with a reason.

CREATE SCHEMA quality;

CREATE FUNCTION quality.forbid_rewrite() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME;
END $$;

-- ----------------------------------------------------------------- units (doc 05 §§9, 18)

-- `code` is the wire code; `ucum` the UCUM equivalent where one exists. A dimension has at most
-- one normalized unit; a dimension with none (hardness scales) is only ever compared unit to
-- unit, because no exact conversion exists between its scales.
CREATE TABLE quality.unit (
  code text PRIMARY KEY CHECK (code ~ '^[A-Za-z_]{1,16}$'),
  ucum text,
  dimension text NOT NULL CHECK (dimension IN ('length', 'angle', 'temperature', 'mass', 'torque', 'hardness', 'count')),
  label text NOT NULL,
  is_normalized boolean NOT NULL DEFAULT false
);

CREATE UNIQUE INDEX uq_unit_normalized ON quality.unit (dimension) WHERE is_normalized;

-- Conversion factors are versioned reference data with a cited source; a version is never
-- edited, only retired in favour of the next. Each row maps a unit onto its dimension's
-- normalized unit as an exact affine map: normalized = value × factor + offset, with factor and
-- offset as integer fractions so °F (×5/9) stays exact.
CREATE TABLE quality.unit_conversion_version (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version integer NOT NULL UNIQUE CHECK (version > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  effective_from timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL CHECK (char_length(source) >= 3),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_unit_conversion_active ON quality.unit_conversion_version (status) WHERE status = 'active';

CREATE TABLE quality.unit_conversion (
  version_id uuid NOT NULL REFERENCES quality.unit_conversion_version (id),
  from_unit text NOT NULL REFERENCES quality.unit (code),
  to_unit text NOT NULL REFERENCES quality.unit (code),
  factor_num bigint NOT NULL CHECK (factor_num > 0),
  factor_den bigint NOT NULL CHECK (factor_den > 0),
  offset_num bigint NOT NULL DEFAULT 0,
  offset_den bigint NOT NULL DEFAULT 1 CHECK (offset_den > 0),
  citation text NOT NULL,
  PRIMARY KEY (version_id, from_unit),
  CONSTRAINT chk_conversion_not_identity CHECK (from_unit <> to_unit)
);

CREATE FUNCTION quality.check_conversion_target() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  f quality.unit;
  t quality.unit;
BEGIN
  SELECT * INTO f FROM quality.unit WHERE code = NEW.from_unit;
  SELECT * INTO t FROM quality.unit WHERE code = NEW.to_unit;
  IF NOT t.is_normalized OR f.dimension <> t.dimension THEN
    RAISE EXCEPTION 'a conversion maps % onto the normalized unit of its own dimension', NEW.from_unit;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_unit_conversion_target BEFORE INSERT ON quality.unit_conversion
  FOR EACH ROW EXECUTE FUNCTION quality.check_conversion_target();
CREATE TRIGGER trg_unit_conversion_immutable BEFORE UPDATE OR DELETE ON quality.unit_conversion
  FOR EACH ROW EXECUTE FUNCTION quality.forbid_rewrite();

CREATE FUNCTION quality.retire_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW.version <> OLD.version OR NEW.source <> OLD.source OR NEW.effective_from <> OLD.effective_from
     OR NOT (OLD.status = 'active' AND NEW.status = 'retired') THEN
    RAISE EXCEPTION '% versions are never rewritten, only retired', TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_unit_conversion_version_retire BEFORE UPDATE OR DELETE ON quality.unit_conversion_version
  FOR EACH ROW EXECUTE FUNCTION quality.retire_only();

INSERT INTO quality.unit (code, ucum, dimension, label, is_normalized) VALUES
  ('mm', 'mm', 'length', 'millimetre', true),
  ('um', 'um', 'length', 'micrometre', false),
  ('m', 'm', 'length', 'metre', false),
  ('inch', '[in_i]', 'length', 'inch', false),
  ('deg', 'deg', 'angle', 'degree', true),
  ('degC', 'Cel', 'temperature', 'degree Celsius', true),
  ('degF', '[degF]', 'temperature', 'degree Fahrenheit', false),
  ('K', 'K', 'temperature', 'kelvin', false),
  ('kg', 'kg', 'mass', 'kilogram', true),
  ('g', 'g', 'mass', 'gram', false),
  ('N_m', 'N.m', 'torque', 'newton metre', true),
  ('HRC', NULL, 'hardness', 'Rockwell C', false),
  ('HRB', NULL, 'hardness', 'Rockwell B', false),
  ('HV', NULL, 'hardness', 'Vickers', false),
  ('count', '{count}', 'count', 'count', true);

WITH v AS (
  INSERT INTO quality.unit_conversion_version (version, source)
  VALUES (1, 'NIST SP 811 (2008 edition), Appendix B; SI Brochure (9th edition) — exact definitions only')
  RETURNING id
)
INSERT INTO quality.unit_conversion (version_id, from_unit, to_unit, factor_num, factor_den, offset_num, offset_den, citation)
SELECT v.id, f, t, fn, fd, onum, oden, c FROM v, (VALUES
  ('um', 'mm', 1, 1000, 0, 1, 'SI prefixes: 1 µm = 10⁻³ mm exactly'),
  ('m', 'mm', 1000, 1, 0, 1, 'SI prefixes: 1 m = 10³ mm exactly'),
  ('inch', 'mm', 254, 10, 0, 1, 'NIST SP 811 B.8: 1 in = 2.54 cm exactly (1959 international inch)'),
  ('degF', 'degC', 5, 9, -160, 9, 'NIST SP 811 4.2.1.1: t/°C = (t/°F − 32)/1.8'),
  ('K', 'degC', 1, 1, -27315, 100, 'SI Brochure 2.3.1: t/°C = T/K − 273.15'),
  ('g', 'kg', 1, 1000, 0, 1, 'SI prefixes: 1 g = 10⁻³ kg exactly')
) AS c (f, t, fn, fd, onum, oden, c);

-- ----------------------------------------------------------------- templates (doc 09 §16)

CREATE TABLE quality.plan_template (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  label text NOT NULL,
  capability_codes text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- A template version is what a plan snapshots: stages with their default sample sizes, the
-- characteristics every plan starts from, and whether the drawing must add its own.
CREATE TABLE quality.plan_template_version (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES quality.plan_template (id),
  version_no integer NOT NULL CHECK (version_no > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  stages jsonb NOT NULL,
  characteristics jsonb NOT NULL,
  requires_drawing_characteristic boolean NOT NULL DEFAULT true,
  effective_from timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_id, version_no)
);

CREATE FUNCTION quality.template_version_retire_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW.stages <> OLD.stages OR NEW.characteristics <> OLD.characteristics
     OR NEW.requires_drawing_characteristic <> OLD.requires_drawing_characteristic
     OR NOT (OLD.status = NEW.status OR (OLD.status = 'active' AND NEW.status = 'retired')) THEN
    RAISE EXCEPTION 'template versions are never rewritten, only retired';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_template_version_immutable BEFORE UPDATE OR DELETE ON quality.plan_template_version
  FOR EACH ROW EXECUTE FUNCTION quality.template_version_retire_only();

-- Launch template (owner default for D-06): machined parts. FAI checks every characteristic on
-- one piece; final inspection samples five with acceptance number 0.
WITH t AS (
  INSERT INTO quality.plan_template (code, label, capability_codes)
  VALUES ('cnc_machined_part', 'CNC machined part', ARRAY['cnc_milling', 'cnc_turning', 'vmc_machining'])
  RETURNING id
)
INSERT INTO quality.plan_template_version (template_id, version_no, stages, characteristics, requires_drawing_characteristic)
SELECT t.id, 1,
  '[{"stage": "fai", "sampleSize": 1}, {"stage": "final", "sampleSize": 5}]'::jsonb,
  '[
     {"name": "Visual: free of burrs and sharp edges", "kind": "attribute", "acceptedValues": ["conforming"], "criticality": "minor", "mandatory": true, "stages": ["fai", "final"], "method": "Visual, every sampled piece", "instrumentKind": "", "reactionPlan": "Deburr and re-inspect the lot"},
     {"name": "Surface roughness Ra", "kind": "variable", "unit": "um", "upper": {"value": "3.2", "inclusive": true}, "criticality": "minor", "mandatory": true, "stages": ["fai"], "method": "Stylus profilometer, 0.8 mm cut-off", "instrumentKind": "surface_roughness_tester", "reactionPlan": "Hold the lot; review tooling and feed"}
   ]'::jsonb,
  true
FROM t;

-- ----------------------------------------------------------------- plans (doc 09 §9; FR-701)

CREATE TABLE quality.quality_plan (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_package_id uuid NOT NULL REFERENCES orders.work_package (id),
  version_no integer NOT NULL CHECK (version_no > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'superseded')),
  template_version_id uuid NOT NULL REFERENCES quality.plan_template_version (id),
  -- The baseline the characteristics were written against (doc 09 §6).
  baseline_id uuid NOT NULL REFERENCES dms.baseline (id),
  -- [{"stage": "fai", "sampleSize": 1}, …] snapshotted from the template, adjustable in draft.
  stages jsonb NOT NULL,
  supersedes_plan_id uuid REFERENCES quality.quality_plan (id),
  created_by uuid NOT NULL,
  approved_by uuid,
  approved_at timestamptz,
  aggregate_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (work_package_id, version_no),
  CONSTRAINT chk_plan_approved CHECK (status = 'draft' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);

CREATE UNIQUE INDEX uq_quality_plan_approved ON quality.quality_plan (work_package_id) WHERE status = 'approved';
CREATE UNIQUE INDEX uq_quality_plan_draft ON quality.quality_plan (work_package_id) WHERE status = 'draft';

-- draft → approved → superseded. Once approved, nothing but the status moves.
CREATE FUNCTION quality.enforce_plan_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'draft' AND (
       NEW.baseline_id <> OLD.baseline_id OR NEW.stages <> OLD.stages OR NEW.template_version_id <> OLD.template_version_id
       OR NEW.approved_by IS DISTINCT FROM OLD.approved_by OR NEW.approved_at IS DISTINCT FROM OLD.approved_at) THEN
    RAISE EXCEPTION 'an approved quality plan is frozen';
  END IF;
  IF NEW.status = OLD.status
     OR (OLD.status = 'draft' AND NEW.status = 'approved')
     OR (OLD.status = 'approved' AND NEW.status = 'superseded') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid quality plan transition: % -> %', OLD.status, NEW.status;
END $$;

CREATE TRIGGER trg_quality_plan_transition BEFORE UPDATE ON quality.quality_plan
  FOR EACH ROW EXECUTE FUNCTION quality.enforce_plan_transition();

CREATE TABLE quality.characteristic (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES quality.quality_plan (id),
  seq integer NOT NULL CHECK (seq > 0),
  -- Balloon number or drawing/BOM reference; empty for template-wide checks.
  drawing_reference text NOT NULL DEFAULT '' CHECK (char_length(drawing_reference) <= 60),
  name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 200),
  kind text NOT NULL CHECK (kind IN ('variable', 'attribute')),
  criticality text NOT NULL CHECK (criticality IN ('critical', 'major', 'minor')),
  mandatory boolean NOT NULL DEFAULT true,
  unit text REFERENCES quality.unit (code),
  nominal numeric,
  lower_limit numeric,
  lower_inclusive boolean,
  upper_limit numeric,
  upper_inclusive boolean,
  accepted_values text[] NOT NULL DEFAULT '{}',
  stages text[] NOT NULL,
  method text NOT NULL DEFAULT '',
  instrument_kind text NOT NULL DEFAULT '',
  reaction_plan text NOT NULL DEFAULT '',
  UNIQUE (plan_id, seq),
  CONSTRAINT chk_characteristic_stages CHECK (
    cardinality(stages) > 0
    AND stages <@ ARRAY['incoming', 'in_process', 'fai', 'final', 'jobwork_incoming', 'customer_receiving']),
  CONSTRAINT chk_characteristic_shape CHECK (
    (kind = 'variable' AND unit IS NOT NULL AND cardinality(accepted_values) = 0
      AND (lower_limit IS NOT NULL OR upper_limit IS NOT NULL)
      AND (lower_limit IS NULL) = (lower_inclusive IS NULL)
      AND (upper_limit IS NULL) = (upper_inclusive IS NULL)
      AND (lower_limit IS NULL OR upper_limit IS NULL OR lower_limit < upper_limit
           OR (lower_limit = upper_limit AND lower_inclusive AND upper_inclusive)))
    OR (kind = 'attribute' AND unit IS NULL AND nominal IS NULL AND lower_limit IS NULL AND upper_limit IS NULL
      AND cardinality(accepted_values) > 0))
);

-- Characteristics change only while their plan is a draft.
CREATE FUNCTION quality.characteristic_follows_plan() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  plan_status text;
BEGIN
  SELECT status INTO plan_status FROM quality.quality_plan WHERE id = COALESCE(NEW.plan_id, OLD.plan_id);
  IF plan_status <> 'draft' THEN
    RAISE EXCEPTION 'characteristics of an approved quality plan are frozen';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.plan_id <> OLD.plan_id THEN
    RAISE EXCEPTION 'a characteristic cannot move between plans';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER trg_characteristic_frozen BEFORE INSERT OR UPDATE OR DELETE ON quality.characteristic
  FOR EACH ROW EXECUTE FUNCTION quality.characteristic_follows_plan();

-- ----------------------------------------------------------------- instruments

CREATE TABLE quality.instrument (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_organization_id uuid NOT NULL REFERENCES iam.organization (id),
  asset_tag text NOT NULL CHECK (char_length(asset_tag) BETWEEN 1 AND 60),
  kind text NOT NULL CHECK (char_length(kind) BETWEEN 2 AND 80),
  description text NOT NULL DEFAULT '',
  unit text REFERENCES quality.unit (code),
  resolution numeric CHECK (resolution > 0),
  range_low numeric,
  range_high numeric,
  status text NOT NULL DEFAULT 'in_service' CHECK (status IN ('in_service', 'retired')),
  registered_by uuid NOT NULL,
  aggregate_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_organization_id, asset_tag),
  CONSTRAINT chk_instrument_range CHECK (range_low IS NULL OR range_high IS NULL OR range_low < range_high)
);

CREATE FUNCTION quality.enforce_instrument_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.owner_organization_id <> OLD.owner_organization_id OR NEW.asset_tag <> OLD.asset_tag THEN
    RAISE EXCEPTION 'an instrument keeps its owner and asset tag';
  END IF;
  IF NEW.status = OLD.status OR (OLD.status = 'in_service' AND NEW.status = 'retired') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid instrument transition: % -> %', OLD.status, NEW.status;
END $$;

CREATE TRIGGER trg_instrument_transition BEFORE UPDATE ON quality.instrument
  FOR EACH ROW EXECUTE FUNCTION quality.enforce_instrument_transition();

-- Append-only: a calibration is a fact about one moment, with its certificate.
CREATE TABLE quality.calibration (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instrument_id uuid NOT NULL REFERENCES quality.instrument (id),
  performed_at timestamptz NOT NULL,
  due_at timestamptz NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('pass', 'out_of_tolerance')),
  certificate_document_version_id uuid NOT NULL REFERENCES dms.document_version (id),
  certificate_sha256 text NOT NULL CHECK (certificate_sha256 ~ '^[0-9a-f]{64}$'),
  note text NOT NULL DEFAULT '',
  recorded_by uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_calibration_due CHECK (due_at > performed_at)
);

CREATE INDEX idx_calibration_instrument ON quality.calibration (instrument_id, performed_at DESC);

CREATE TRIGGER trg_calibration_immutable BEFORE UPDATE OR DELETE ON quality.calibration
  FOR EACH ROW EXECUTE FUNCTION quality.forbid_rewrite();

-- ----------------------------------------------------------------- inspections (doc 06 §10)

CREATE TABLE quality.inspection (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  work_package_id uuid NOT NULL REFERENCES orders.work_package (id),
  plan_id uuid NOT NULL REFERENCES quality.quality_plan (id),
  baseline_id uuid NOT NULL REFERENCES dms.baseline (id),
  stage text NOT NULL CHECK (stage IN ('incoming', 'in_process', 'fai', 'final', 'jobwork_incoming', 'customer_receiving')),
  sample_size integer NOT NULL CHECK (sample_size > 0),
  lot text NOT NULL DEFAULT '',
  -- Who measures: the supplier for its own stages, JobWork for its incoming inspection.
  inspecting_organization_id uuid NOT NULL REFERENCES iam.organization (id),
  milestone_id uuid REFERENCES orders.milestone (id),
  reinspection_of uuid REFERENCES quality.inspection (id),
  status text NOT NULL DEFAULT 'planned' CHECK (status IN (
    'planned', 'in_progress', 'results_submitted', 'under_review', 'passed', 'failed', 'invalidated'
  )),
  note text NOT NULL DEFAULT '',
  planned_by uuid NOT NULL,
  planned_at timestamptz NOT NULL DEFAULT now(),
  started_by uuid,
  started_at timestamptz,
  inspected_at timestamptz,
  submitted_by uuid,
  submitted_at timestamptz,
  reviewer_id uuid,
  review_started_at timestamptz,
  decided_at timestamptz,
  decision_reason text,
  invalidated_at timestamptz,
  invalidation_reason text,
  aggregate_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_inspection_submitted CHECK (status IN ('planned', 'in_progress', 'invalidated') OR (submitted_by IS NOT NULL AND submitted_at IS NOT NULL AND inspected_at IS NOT NULL)),
  CONSTRAINT chk_inspection_decided CHECK (status NOT IN ('passed', 'failed') OR (decided_at IS NOT NULL AND reviewer_id IS NOT NULL)),
  CONSTRAINT chk_inspection_failed_reason CHECK (status <> 'failed' OR char_length(coalesce(decision_reason, '')) >= 3),
  CONSTRAINT chk_inspection_invalidated CHECK (status <> 'invalidated' OR (invalidated_at IS NOT NULL AND char_length(coalesce(invalidation_reason, '')) >= 3)),
  -- BR-QLT-03 and doc 09 §9: whoever submitted the results never reviews them.
  CONSTRAINT chk_inspection_independent CHECK (reviewer_id IS NULL OR submitted_by IS NULL OR reviewer_id <> submitted_by)
);

CREATE INDEX idx_inspection_work_package ON quality.inspection (work_package_id, created_at DESC);
CREATE INDEX idx_inspection_status ON quality.inspection (status) WHERE status IN ('results_submitted', 'under_review');

CREATE FUNCTION quality.enforce_inspection_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.work_package_id <> OLD.work_package_id OR NEW.plan_id <> OLD.plan_id OR NEW.baseline_id <> OLD.baseline_id
     OR NEW.stage <> OLD.stage OR NEW.sample_size <> OLD.sample_size OR NEW.inspecting_organization_id <> OLD.inspecting_organization_id THEN
    RAISE EXCEPTION 'an inspection keeps what it was planned against';
  END IF;
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF (OLD.status = 'planned' AND NEW.status IN ('in_progress', 'invalidated'))
     OR (OLD.status = 'in_progress' AND NEW.status IN ('results_submitted', 'invalidated'))
     OR (OLD.status = 'results_submitted' AND NEW.status IN ('under_review', 'invalidated'))
     OR (OLD.status = 'under_review' AND NEW.status IN ('passed', 'failed', 'invalidated'))
     OR (OLD.status IN ('passed', 'failed') AND NEW.status = 'invalidated')
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid inspection transition: % -> %', OLD.status, NEW.status;
END $$;

CREATE TRIGGER trg_inspection_transition BEFORE UPDATE ON quality.inspection
  FOR EACH ROW EXECUTE FUNCTION quality.enforce_inspection_transition();

CREATE TABLE quality.inspection_sample (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_id uuid NOT NULL REFERENCES quality.inspection (id),
  sample_no integer NOT NULL CHECK (sample_no > 0),
  serial text NOT NULL DEFAULT '',
  lot text NOT NULL DEFAULT '',
  cavity text NOT NULL DEFAULT '',
  UNIQUE (inspection_id, sample_no)
);

CREATE TRIGGER trg_inspection_sample_immutable BEFORE UPDATE OR DELETE ON quality.inspection_sample
  FOR EACH ROW EXECUTE FUNCTION quality.forbid_rewrite();

-- FR-702 and doc 09 §10: the value as entered, its normalized form, and everything that judged it.
CREATE TABLE quality.inspection_result (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_id uuid NOT NULL REFERENCES quality.inspection (id),
  sample_id uuid NOT NULL REFERENCES quality.inspection_sample (id),
  characteristic_id uuid NOT NULL REFERENCES quality.characteristic (id),
  original_value text NOT NULL CHECK (char_length(original_value) BETWEEN 1 AND 60),
  original_unit text REFERENCES quality.unit (code),
  declared_precision integer CHECK (declared_precision BETWEEN 0 AND 12),
  normalized_value numeric,
  normalized_unit text REFERENCES quality.unit (code),
  outcome text NOT NULL CHECK (outcome IN ('pass', 'fail', 'cannot_evaluate')),
  outcome_reason text NOT NULL DEFAULT '',
  rule_version text NOT NULL,
  conversion_version_id uuid REFERENCES quality.unit_conversion_version (id),
  method text NOT NULL DEFAULT '',
  instrument_id uuid REFERENCES quality.instrument (id),
  calibration_id uuid REFERENCES quality.calibration (id),
  calibration_status text NOT NULL CHECK (calibration_status IN ('valid', 'expired', 'uncalibrated', 'not_required')),
  supersedes_result_id uuid UNIQUE REFERENCES quality.inspection_result (id),
  correction_reason text,
  recorded_by uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_result_correction CHECK (supersedes_result_id IS NULL OR char_length(coalesce(correction_reason, '')) >= 3),
  CONSTRAINT chk_result_normalized CHECK ((normalized_value IS NULL) = (normalized_unit IS NULL)),
  CONSTRAINT chk_result_instrument CHECK ((instrument_id IS NULL) = (calibration_status = 'not_required')),
  CONSTRAINT chk_result_calibration CHECK (calibration_status <> 'valid' OR calibration_id IS NOT NULL)
);

CREATE INDEX idx_inspection_result_inspection ON quality.inspection_result (inspection_id);

CREATE TRIGGER trg_inspection_result_immutable BEFORE UPDATE OR DELETE ON quality.inspection_result
  FOR EACH ROW EXECUTE FUNCTION quality.forbid_rewrite();

-- BR-QLT-05: a result measured with an expired or uncalibrated instrument waits for JobWork
-- quality's disposition: accepted with a reason, or sent back for reinspection.
CREATE TABLE quality.result_disposition (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  result_id uuid NOT NULL UNIQUE REFERENCES quality.inspection_result (id),
  decision text NOT NULL CHECK (decision IN ('accept', 'reinspect')),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 1000),
  decided_by uuid NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_result_disposition_immutable BEFORE UPDATE OR DELETE ON quality.result_disposition
  FOR EACH ROW EXECUTE FUNCTION quality.forbid_rewrite();

CREATE TABLE quality.inspection_attachment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_id uuid NOT NULL REFERENCES quality.inspection (id),
  document_version_id uuid NOT NULL REFERENCES dms.document_version (id),
  file_sha256 text NOT NULL CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  note text NOT NULL DEFAULT '',
  added_by uuid NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (inspection_id, document_version_id)
);

CREATE TRIGGER trg_inspection_attachment_immutable BEFORE UPDATE OR DELETE ON quality.inspection_attachment
  FOR EACH ROW EXECUTE FUNCTION quality.forbid_rewrite();

-- ----------------------------------------------------------------- queue and notifications

INSERT INTO platform.sla_policy_version (policy_key, version, calendar_key, target_minutes, escalation_steps, reason)
VALUES ('inspections_awaiting_review', 1, 'chennai', 540,
        jsonb_build_array(
          jsonb_build_object('step', 1, 'afterMinutes', 540, 'notify', 'owner'),
          jsonb_build_object('step', 2, 'afterMinutes', 1080, 'notify', 'escalation')),
        'IN-14 inspection review target');

INSERT INTO platform.work_queue (key, label, owning_team, sla_policy_key)
VALUES ('inspections_awaiting_review', 'Inspections awaiting review', 'Quality', 'inspections_awaiting_review');

INSERT INTO communication.template_version (template_key, version, channel, audience, subject, body, variables) VALUES
  ('supplier.inspection_planned', 1, 'in_app', 'supplier',
   '{{purchaseOrderNumber}}: {{stageLabel}} inspection planned',
   'JobWork has planned a {{stageLabel}} inspection of {{sampleSize}} piece(s) on {{purchaseOrderNumber}}.', ARRAY['purchaseOrderNumber', 'stageLabel', 'sampleSize', 'link']),
  ('supplier.inspection_planned', 1, 'email', 'supplier',
   '{{purchaseOrderNumber}}: {{stageLabel}} inspection planned',
   E'JobWork has planned a {{stageLabel}} inspection of {{sampleSize}} piece(s) on {{purchaseOrderNumber}}. The characteristics to measure and how to record them are here:\n{{link}}', ARRAY['purchaseOrderNumber', 'stageLabel', 'sampleSize', 'link']),
  ('supplier.inspection_decided', 1, 'in_app', 'supplier',
   '{{inspectionNumber}}: {{outcomeLabel}}',
   'JobWork quality has reviewed {{inspectionNumber}} on {{purchaseOrderNumber}}: {{outcomeLabel}}.', ARRAY['inspectionNumber', 'purchaseOrderNumber', 'outcomeLabel', 'link']),
  ('supplier.inspection_decided', 1, 'email', 'supplier',
   '{{inspectionNumber}}: {{outcomeLabel}}',
   E'JobWork quality has reviewed {{inspectionNumber}} on {{purchaseOrderNumber}}: {{outcomeLabel}}. The results and the reviewer''s note are here:\n{{link}}', ARRAY['inspectionNumber', 'purchaseOrderNumber', 'outcomeLabel', 'link']);
