-- NCRs, deviations and quality release (IN-15 F-15.1; doc 06 §10; doc 09 §§11–14; FR-703–FR-706;
-- BR-QLT-01–06).
--
-- A failed inspection opens an NCR scoped to an affected quantity and its lots and serials. The
-- NCR moves through containment to a disposition: rework (with a reinspection that is a new
-- inspection record), a deviation (approved inside JobWork and, when required, by the customer),
-- or rejection. Every decision is an append-only record; the failed results themselves are
-- never touched. A quality release is an immutable snapshot of a computed checklist and its hash.

-- ----------------------------------------------------------------- NCR

CREATE TABLE quality.ncr (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  work_package_id uuid NOT NULL REFERENCES orders.work_package (id),
  inspection_id uuid NOT NULL REFERENCES quality.inspection (id),
  baseline_id uuid NOT NULL REFERENCES dms.baseline (id),
  -- Branch lineage (doc 09 §11): a new defect found while working an NCR opens a child.
  parent_ncr_id uuid REFERENCES quality.ncr (id),
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 200),
  description text NOT NULL CHECK (char_length(description) BETWEEN 3 AND 2000),
  severity text NOT NULL CHECK (severity IN ('critical', 'major', 'minor')),
  detection_stage text NOT NULL,
  affected_quantity numeric(18, 4) NOT NULL CHECK (affected_quantity > 0),
  lots text[] NOT NULL DEFAULT '{}',
  serials text[] NOT NULL DEFAULT '{}',
  suspected_cause text NOT NULL DEFAULT '',
  owner_id uuid NOT NULL,
  due_at timestamptz NOT NULL,
  cost_responsibility text NOT NULL DEFAULT 'undetermined' CHECK (cost_responsibility IN ('supplier', 'jobwork', 'customer', 'undetermined')),
  corrective_action_required boolean NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN (
    'open', 'containment', 'disposition_pending', 'rework', 'reinspection', 'deviation_pending',
    'accepted_under_deviation', 'rejected', 'verified', 'closed'
  )),
  -- The disposition being worked; each new disposition is the next attempt.
  attempt_no integer NOT NULL DEFAULT 0 CHECK (attempt_no >= 0),
  disposition_decided_by uuid,
  opened_by uuid NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_by uuid,
  closed_at timestamptz,
  closure_note text,
  aggregate_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_ncr_closed CHECK (status <> 'closed' OR (closed_by IS NOT NULL AND closed_at IS NOT NULL AND char_length(coalesce(closure_note, '')) >= 3)),
  -- BR-QLT-06: whoever decided the disposition does not also verify and close it.
  CONSTRAINT chk_ncr_independent_closure CHECK (closed_by IS NULL OR disposition_decided_by IS NULL OR closed_by <> disposition_decided_by),
  CONSTRAINT chk_ncr_not_own_parent CHECK (parent_ncr_id IS NULL OR parent_ncr_id <> id)
);

CREATE INDEX idx_ncr_work_package ON quality.ncr (work_package_id, opened_at DESC);
CREATE INDEX idx_ncr_open ON quality.ncr (status) WHERE status <> 'closed';

-- Doc 06 §10, with the scope of what an NCR records fixed once opened.
CREATE FUNCTION quality.enforce_ncr_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.work_package_id <> OLD.work_package_id OR NEW.inspection_id <> OLD.inspection_id OR NEW.baseline_id <> OLD.baseline_id
     OR NEW.parent_ncr_id IS DISTINCT FROM OLD.parent_ncr_id OR NEW.affected_quantity <> OLD.affected_quantity
     OR NEW.lots <> OLD.lots OR NEW.serials <> OLD.serials OR NEW.severity <> OLD.severity THEN
    RAISE EXCEPTION 'an NCR keeps the scope it was opened with';
  END IF;
  IF NEW.attempt_no < OLD.attempt_no THEN
    RAISE EXCEPTION 'an NCR never forgets an attempt';
  END IF;
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF (OLD.status = 'open' AND NEW.status = 'containment')
     OR (OLD.status = 'containment' AND NEW.status = 'disposition_pending')
     OR (OLD.status = 'disposition_pending' AND NEW.status IN ('rework', 'deviation_pending', 'rejected'))
     OR (OLD.status = 'rework' AND NEW.status = 'reinspection')
     OR (OLD.status = 'reinspection' AND NEW.status IN ('disposition_pending', 'verified'))
     OR (OLD.status = 'deviation_pending' AND NEW.status IN ('accepted_under_deviation', 'disposition_pending'))
     OR (OLD.status IN ('verified', 'accepted_under_deviation', 'rejected') AND NEW.status = 'closed')
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid NCR transition: % -> %', OLD.status, NEW.status;
END $$;

CREATE TRIGGER trg_ncr_transition BEFORE UPDATE ON quality.ncr
  FOR EACH ROW EXECUTE FUNCTION quality.enforce_ncr_transition();

-- The failed results an NCR covers. Recorded once; the results themselves stay as they are.
CREATE TABLE quality.ncr_defect (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ncr_id uuid NOT NULL REFERENCES quality.ncr (id),
  result_id uuid NOT NULL REFERENCES quality.inspection_result (id),
  characteristic_id uuid NOT NULL REFERENCES quality.characteristic (id),
  UNIQUE (ncr_id, result_id)
);

CREATE TRIGGER trg_ncr_defect_immutable BEFORE UPDATE OR DELETE ON quality.ncr_defect
  FOR EACH ROW EXECUTE FUNCTION quality.forbid_rewrite();

CREATE TABLE quality.ncr_containment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ncr_id uuid NOT NULL REFERENCES quality.ncr (id),
  action text NOT NULL CHECK (char_length(action) BETWEEN 3 AND 1000),
  location text NOT NULL DEFAULT '',
  quantity numeric(18, 4) CHECK (quantity IS NULL OR quantity > 0),
  recorded_by uuid NOT NULL,
  recorded_by_organization_id uuid NOT NULL REFERENCES iam.organization (id),
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_ncr_containment_immutable BEFORE UPDATE OR DELETE ON quality.ncr_containment
  FOR EACH ROW EXECUTE FUNCTION quality.forbid_rewrite();

-- One row per disposition decided (doc 09 §11). Rework, remake and sort carry a plan, the
-- supplier's record of doing it, and the reinspection that judged it; each is filled once.
CREATE TABLE quality.ncr_disposition (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ncr_id uuid NOT NULL REFERENCES quality.ncr (id),
  attempt_no integer NOT NULL CHECK (attempt_no > 0),
  disposition text NOT NULL CHECK (disposition IN ('rework', 'remake', 'sort', 'use_as_is', 'return', 'scrap')),
  plan text NOT NULL DEFAULT '',
  decided_by uuid NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT now(),
  rework_note text,
  rework_recorded_by uuid,
  rework_recorded_at timestamptz,
  reinspection_id uuid REFERENCES quality.inspection (id),
  outcome text NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending', 'verified', 'still_nonconforming', 'deviation_approved', 'deviation_rejected', 'rejected')),
  UNIQUE (ncr_id, attempt_no),
  CONSTRAINT chk_disposition_plan CHECK (disposition NOT IN ('rework', 'remake', 'sort') OR char_length(plan) >= 3)
);

CREATE FUNCTION quality.disposition_fills_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW.ncr_id <> OLD.ncr_id OR NEW.attempt_no <> OLD.attempt_no OR NEW.disposition <> OLD.disposition
     OR NEW.plan <> OLD.plan OR NEW.decided_by <> OLD.decided_by OR NEW.decided_at <> OLD.decided_at
     OR (OLD.rework_recorded_at IS NOT NULL AND (NEW.rework_note IS DISTINCT FROM OLD.rework_note OR NEW.rework_recorded_by IS DISTINCT FROM OLD.rework_recorded_by OR NEW.rework_recorded_at IS DISTINCT FROM OLD.rework_recorded_at))
     OR (OLD.reinspection_id IS NOT NULL AND NEW.reinspection_id IS DISTINCT FROM OLD.reinspection_id)
     OR (OLD.outcome <> 'pending' AND NEW.outcome <> OLD.outcome) THEN
    RAISE EXCEPTION 'a disposition is decided once and each of its later facts is recorded once';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_ncr_disposition_once BEFORE UPDATE OR DELETE ON quality.ncr_disposition
  FOR EACH ROW EXECUTE FUNCTION quality.disposition_fills_once();

-- Doc 09 §13: the supplier's problem definition, occurrence and escape causes and actions,
-- accepted by JobWork, then verified effective.
CREATE TABLE quality.corrective_action (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ncr_id uuid NOT NULL UNIQUE REFERENCES quality.ncr (id),
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'responded', 'accepted', 'verified')),
  due_at timestamptz NOT NULL,
  requested_by uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  problem_definition text,
  occurrence_cause text,
  escape_cause text,
  actions jsonb NOT NULL DEFAULT '[]',
  responded_by uuid,
  responded_at timestamptz,
  review_note text,
  accepted_by uuid,
  accepted_at timestamptz,
  effectiveness_evidence text,
  verified_by uuid,
  verified_at timestamptz,
  aggregate_version integer NOT NULL DEFAULT 1,
  CONSTRAINT chk_ca_responded CHECK (status = 'requested' OR (char_length(coalesce(problem_definition, '')) >= 3 AND char_length(coalesce(occurrence_cause, '')) >= 3 AND char_length(coalesce(escape_cause, '')) >= 3 AND jsonb_array_length(actions) > 0)),
  CONSTRAINT chk_ca_accepted CHECK (status NOT IN ('accepted', 'verified') OR accepted_by IS NOT NULL),
  CONSTRAINT chk_ca_verified CHECK (status <> 'verified' OR (verified_by IS NOT NULL AND char_length(coalesce(effectiveness_evidence, '')) >= 3))
);

CREATE FUNCTION quality.enforce_corrective_action_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = OLD.status
     OR (OLD.status = 'requested' AND NEW.status = 'responded')
     OR (OLD.status = 'responded' AND NEW.status IN ('accepted', 'requested'))
     OR (OLD.status = 'accepted' AND NEW.status = 'verified') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid corrective action transition: % -> %', OLD.status, NEW.status;
END $$;

CREATE TRIGGER trg_corrective_action_transition BEFORE UPDATE ON quality.corrective_action
  FOR EACH ROW EXECUTE FUNCTION quality.enforce_corrective_action_transition();

-- ----------------------------------------------------------------- deviation (doc 09 §12)

CREATE TABLE quality.deviation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  ncr_id uuid NOT NULL REFERENCES quality.ncr (id),
  status text NOT NULL DEFAULT 'pending_internal' CHECK (status IN ('pending_internal', 'pending_customer', 'approved', 'rejected', 'withdrawn')),
  characteristic_ids uuid[] NOT NULL CHECK (cardinality(characteristic_ids) > 0),
  quantity numeric(18, 4) NOT NULL CHECK (quantity > 0),
  lots text[] NOT NULL DEFAULT '{}',
  serials text[] NOT NULL DEFAULT '{}',
  expires_at timestamptz NOT NULL,
  rationale text NOT NULL CHECK (char_length(rationale) >= 3),
  risk_assessment text NOT NULL CHECK (char_length(risk_assessment) >= 3),
  fit_function_safety text NOT NULL CHECK (char_length(fit_function_safety) >= 3),
  price_effect text NOT NULL DEFAULT '',
  warranty_effect text NOT NULL DEFAULT '',
  traceability_effect text NOT NULL DEFAULT '',
  labeling_effect text NOT NULL DEFAULT '',
  customer_approval_required boolean NOT NULL,
  approval_request_id uuid REFERENCES commercial.approval_request (id),
  requested_by uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  decision_reason text,
  aggregate_version integer NOT NULL DEFAULT 1,
  CONSTRAINT chk_deviation_expiry CHECK (expires_at > requested_at AND expires_at <= requested_at + interval '180 days'),
  CONSTRAINT chk_deviation_decided CHECK (status NOT IN ('approved', 'rejected') OR decided_at IS NOT NULL)
);

CREATE FUNCTION quality.enforce_deviation_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.ncr_id <> OLD.ncr_id OR NEW.characteristic_ids <> OLD.characteristic_ids OR NEW.quantity <> OLD.quantity
     OR NEW.lots <> OLD.lots OR NEW.serials <> OLD.serials OR NEW.expires_at <> OLD.expires_at OR NEW.rationale <> OLD.rationale
     OR NEW.risk_assessment <> OLD.risk_assessment OR NEW.fit_function_safety <> OLD.fit_function_safety
     OR NEW.price_effect <> OLD.price_effect OR NEW.warranty_effect <> OLD.warranty_effect
     OR NEW.traceability_effect <> OLD.traceability_effect OR NEW.labeling_effect <> OLD.labeling_effect
     OR NEW.customer_approval_required <> OLD.customer_approval_required THEN
    RAISE EXCEPTION 'a deviation is decided exactly as it was requested';
  END IF;
  IF NEW.status = OLD.status
     OR (OLD.status = 'pending_internal' AND NEW.status IN ('pending_customer', 'approved', 'rejected', 'withdrawn'))
     OR (OLD.status = 'pending_customer' AND NEW.status IN ('approved', 'rejected', 'withdrawn')) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid deviation transition: % -> %', OLD.status, NEW.status;
END $$;

CREATE TRIGGER trg_deviation_transition BEFORE UPDATE ON quality.deviation
  FOR EACH ROW EXECUTE FUNCTION quality.enforce_deviation_transition();

CREATE TABLE quality.deviation_customer_decision (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deviation_id uuid NOT NULL UNIQUE REFERENCES quality.deviation (id),
  decision text NOT NULL CHECK (decision IN ('approved', 'rejected')),
  reason text NOT NULL DEFAULT '',
  decided_by uuid NOT NULL,
  membership_id uuid NOT NULL,
  authority_snapshot jsonb NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_deviation_customer_decision_immutable BEFORE UPDATE OR DELETE ON quality.deviation_customer_decision
  FOR EACH ROW EXECUTE FUNCTION quality.forbid_rewrite();

-- ----------------------------------------------------------------- quality release (doc 09 §14)

CREATE TABLE quality.quality_release (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  work_package_id uuid NOT NULL REFERENCES orders.work_package (id),
  quantity numeric(18, 4) NOT NULL CHECK (quantity > 0),
  lots text[] NOT NULL DEFAULT '{}',
  serials text[] NOT NULL DEFAULT '{}',
  deviation_ids uuid[] NOT NULL DEFAULT '{}',
  checklist jsonb NOT NULL,
  snapshot_sha256 text NOT NULL UNIQUE CHECK (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  released_by uuid NOT NULL,
  released_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_quality_release_work_package ON quality.quality_release (work_package_id, released_at);

CREATE TRIGGER trg_quality_release_immutable BEFORE UPDATE OR DELETE ON quality.quality_release
  FOR EACH ROW EXECUTE FUNCTION quality.forbid_rewrite();

-- ----------------------------------------------------------------- approvals, queue, notifications

-- Approval kind `deviation` (doc 03 §4: internal quality, never the requester).
ALTER TABLE commercial.approval_policy DROP CONSTRAINT approval_policy_kind_check;
ALTER TABLE commercial.approval_policy ADD CONSTRAINT approval_policy_kind_check CHECK (kind IN ('award', 'cost_sheet', 'quote', 'allocation', 'change', 'deviation'));
ALTER TABLE commercial.approval_request DROP CONSTRAINT approval_request_kind_check;
ALTER TABLE commercial.approval_request ADD CONSTRAINT approval_request_kind_check CHECK (kind IN ('award', 'cost_sheet', 'quote', 'allocation', 'change', 'deviation'));
INSERT INTO commercial.approval_policy (kind, title, current_version_no) VALUES ('deviation', 'Deviation (concession) approval', 1);
INSERT INTO commercial.approval_policy_version (policy_id, version_no, rules)
SELECT id, 1, '{"approverRoles":["jobwork_quality","jobwork_engineering"]}'::jsonb
  FROM commercial.approval_policy WHERE kind = 'deviation';

INSERT INTO platform.sla_policy_version (policy_key, version, calendar_key, target_minutes, escalation_steps, reason)
VALUES ('ncrs_open', 1, 'chennai', 2700,
        jsonb_build_array(
          jsonb_build_object('step', 1, 'afterMinutes', 2700, 'notify', 'owner'),
          jsonb_build_object('step', 2, 'afterMinutes', 5400, 'notify', 'escalation')),
        'IN-15 NCR closure target (five working days)');

INSERT INTO platform.work_queue (key, label, owning_team, sla_policy_key)
VALUES ('ncrs_open', 'Open NCRs', 'Quality', 'ncrs_open');

INSERT INTO communication.template_version (template_key, version, channel, audience, subject, body, variables) VALUES
  ('supplier.ncr_opened', 1, 'in_app', 'supplier',
   '{{ncrNumber}} opened on {{purchaseOrderNumber}}',
   'JobWork quality has opened a nonconformance on {{purchaseOrderNumber}}. Contain the affected parts and respond.', ARRAY['ncrNumber', 'purchaseOrderNumber', 'link']),
  ('supplier.ncr_opened', 1, 'email', 'supplier',
   '{{ncrNumber}} opened on {{purchaseOrderNumber}}',
   E'JobWork quality has opened a nonconformance on {{purchaseOrderNumber}}. Contain the affected parts and respond with your containment and, where asked, a corrective action:\n{{link}}', ARRAY['ncrNumber', 'purchaseOrderNumber', 'link']),
  ('supplier.ncr_disposition', 1, 'in_app', 'supplier',
   '{{ncrNumber}}: {{dispositionLabel}}',
   'JobWork quality has decided how {{ncrNumber}} on {{purchaseOrderNumber}} is resolved: {{dispositionLabel}}.', ARRAY['ncrNumber', 'purchaseOrderNumber', 'dispositionLabel', 'link']),
  ('supplier.ncr_disposition', 1, 'email', 'supplier',
   '{{ncrNumber}}: {{dispositionLabel}}',
   E'JobWork quality has decided how {{ncrNumber}} on {{purchaseOrderNumber}} is resolved: {{dispositionLabel}}. The plan and what to do next are here:\n{{link}}', ARRAY['ncrNumber', 'purchaseOrderNumber', 'dispositionLabel', 'link']),
  ('customer.deviation_decision_needed', 1, 'in_app', 'customer',
   '{{deviationNumber}} needs your decision',
   'Parts on order {{orderNumber}} do not fully meet one requirement. JobWork asks whether you accept them as they are, within a stated scope.', ARRAY['deviationNumber', 'orderNumber', 'link']),
  ('customer.deviation_decision_needed', 1, 'email', 'customer',
   '{{deviationNumber}} needs your decision',
   E'Parts on order {{orderNumber}} do not fully meet one requirement. JobWork asks whether you accept them as they are, within a stated quantity and period, and sets out the effect on fit, warranty and labelling:\n{{link}}', ARRAY['deviationNumber', 'orderNumber', 'link']);
