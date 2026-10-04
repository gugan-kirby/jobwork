-- Technical baseline, transmittals, work packages, milestones and evidence (IN-09;
-- FR-503..FR-506; BR-ENG-02/03/06/07; BR-OPS-01..04; doc 06 §§7-8; doc 07 §13; doc 09 §§5-6, 15).
--
-- A baseline is the exact set of document versions a part is made to; once released it
-- never changes. A transmittal delivers it to one supplier and waits for acknowledgment.
-- Work starts only when every release gate passes, and a milestone is done only when
-- someone other than the supplier verifies its evidence.

-- ------------------------------------------------------------------ baseline

CREATE TABLE dms.baseline (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  sales_order_id uuid NOT NULL REFERENCES orders.sales_order (id),
  kind text NOT NULL DEFAULT 'production' CHECK (kind IN ('production', 'inspection')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'released', 'superseded')),
  note text NOT NULL DEFAULT '',
  manifest_hash text,
  supersedes_baseline_id uuid REFERENCES dms.baseline (id),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  released_by uuid,
  released_at timestamptz,
  aggregate_version integer NOT NULL DEFAULT 1,
  CONSTRAINT chk_baseline_released CHECK ((status = 'draft') = (released_at IS NULL)),
  CONSTRAINT chk_baseline_hash CHECK (status = 'draft' OR manifest_hash IS NOT NULL)
);

-- One live production baseline per order at a time.
CREATE UNIQUE INDEX uq_baseline_released ON dms.baseline (sales_order_id, kind) WHERE status = 'released';

CREATE TABLE dms.baseline_item (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  baseline_id uuid NOT NULL REFERENCES dms.baseline (id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES dms.document (id),
  document_version_id uuid NOT NULL REFERENCES dms.document_version (id),
  file_sha256 text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('governing', 'reference', 'inspection')),
  governing_priority integer NOT NULL DEFAULT 1 CHECK (governing_priority > 0),
  UNIQUE (baseline_id, document_version_id)
);

-- BR-ENG-03: once released, nothing about the manifest moves.
CREATE FUNCTION dms.forbid_baseline_rewrite() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'a released baseline cannot be deleted'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'draft' AND (
       NEW.number IS DISTINCT FROM OLD.number
    OR NEW.sales_order_id IS DISTINCT FROM OLD.sales_order_id
    OR NEW.manifest_hash IS DISTINCT FROM OLD.manifest_hash
    OR NEW.released_at IS DISTINCT FROM OLD.released_at
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR (OLD.status = 'superseded' AND NEW.status <> 'superseded')
    OR (OLD.status = 'released' AND NEW.status NOT IN ('released', 'superseded'))
  ) THEN
    RAISE EXCEPTION 'baseline % is released and immutable', OLD.number;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_baseline_immutable
  BEFORE UPDATE OR DELETE ON dms.baseline
  FOR EACH ROW EXECUTE FUNCTION dms.forbid_baseline_rewrite();

CREATE FUNCTION dms.forbid_baseline_item_rewrite() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_status text;
BEGIN
  SELECT status INTO parent_status FROM dms.baseline WHERE id = COALESCE(NEW.baseline_id, OLD.baseline_id);
  IF parent_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'items of a released baseline are frozen';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER trg_baseline_item_frozen
  BEFORE INSERT OR UPDATE OR DELETE ON dms.baseline_item
  FOR EACH ROW EXECUTE FUNCTION dms.forbid_baseline_item_rewrite();

-- ------------------------------------------------------------------ transmittal

/*
 * A formal delivery of a released baseline to one recipient (doc 09 §5), with the exact
 * manifest hash it delivered and the acknowledgment the recipient owes (BR-ENG-07).
 */
CREATE TABLE dms.transmittal (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  baseline_id uuid NOT NULL REFERENCES dms.baseline (id),
  purchase_order_id uuid NOT NULL REFERENCES orders.purchase_order (id),
  recipient_organization_id uuid NOT NULL REFERENCES iam.organization (id),
  purpose text NOT NULL DEFAULT 'for_manufacture' CHECK (purpose IN ('for_manufacture', 'for_information')),
  manifest_hash text NOT NULL,
  status text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'acknowledged', 'superseded', 'revoked')),
  acknowledgment_due_at timestamptz NOT NULL,
  issued_by uuid NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_by uuid,
  acknowledged_at timestamptz,
  acknowledgment_note text NOT NULL DEFAULT '',
  superseded_by_transmittal_id uuid REFERENCES dms.transmittal (id),
  aggregate_version integer NOT NULL DEFAULT 1,
  CONSTRAINT chk_transmittal_ack CHECK ((acknowledged_at IS NULL) = (acknowledged_by IS NULL))
);

CREATE UNIQUE INDEX uq_transmittal_live ON dms.transmittal (purchase_order_id) WHERE status IN ('issued', 'acknowledged');

CREATE FUNCTION dms.forbid_transmittal_rewrite() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'a transmittal cannot be deleted'; END IF;
  IF NEW.baseline_id IS DISTINCT FROM OLD.baseline_id
     OR NEW.purchase_order_id IS DISTINCT FROM OLD.purchase_order_id
     OR NEW.recipient_organization_id IS DISTINCT FROM OLD.recipient_organization_id
     OR NEW.manifest_hash IS DISTINCT FROM OLD.manifest_hash
     OR NEW.number IS DISTINCT FROM OLD.number
     OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
     OR (OLD.acknowledged_at IS NOT NULL AND NEW.acknowledged_at IS DISTINCT FROM OLD.acknowledged_at) THEN
    RAISE EXCEPTION 'transmittal % content is immutable', OLD.number;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_transmittal_immutable
  BEFORE UPDATE OR DELETE ON dms.transmittal
  FOR EACH ROW EXECUTE FUNCTION dms.forbid_transmittal_rewrite();

-- ------------------------------------------------------------------ work package

/*
 * One supplier's share of an order (FR-503 v1: one per purchase order). Planned, then
 * released through the gate matrix; the release snapshot says why release was valid.
 */
CREATE TABLE orders.work_package (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  sales_order_id uuid NOT NULL REFERENCES orders.sales_order (id),
  purchase_order_id uuid NOT NULL UNIQUE REFERENCES orders.purchase_order (id),
  supplier_organization_id uuid NOT NULL REFERENCES iam.organization (id),
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'released', 'in_production', 'completed', 'cancelled')),
  planned_start date,
  planned_finish date,
  quality_plan_present boolean NOT NULL DEFAULT false,
  planning_note text NOT NULL DEFAULT '',
  release_snapshot jsonb,
  released_by uuid,
  released_at timestamptz,
  completed_at timestamptz,
  aggregate_version integer NOT NULL DEFAULT 1,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_wp_released CHECK (status IN ('planned', 'cancelled') OR (released_at IS NOT NULL AND release_snapshot IS NOT NULL)),
  CONSTRAINT chk_wp_dates CHECK (planned_finish IS NULL OR planned_start IS NULL OR planned_finish >= planned_start)
);

CREATE INDEX idx_work_package_supplier ON orders.work_package (supplier_organization_id, created_at DESC);

-- The release snapshot is evidence: it never changes once written.
CREATE FUNCTION orders.forbid_release_snapshot_rewrite() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.release_snapshot IS NOT NULL AND NEW.release_snapshot IS DISTINCT FROM OLD.release_snapshot THEN
    RAISE EXCEPTION 'work package % release snapshot is immutable', OLD.number;
  END IF;
  IF OLD.released_at IS NOT NULL AND (
       NEW.planned_start IS DISTINCT FROM OLD.planned_start
    OR NEW.planned_finish IS DISTINCT FROM OLD.planned_finish
    OR NEW.released_at IS DISTINCT FROM OLD.released_at) THEN
    RAISE EXCEPTION 'work package % plan is frozen after release', OLD.number;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_work_package_release_frozen
  BEFORE UPDATE ON orders.work_package
  FOR EACH ROW EXECUTE FUNCTION orders.forbid_release_snapshot_rewrite();

-- ------------------------------------------------------------------ milestones

CREATE TABLE orders.milestone (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_package_id uuid NOT NULL REFERENCES orders.work_package (id) ON DELETE CASCADE,
  seq integer NOT NULL CHECK (seq > 0),
  title text NOT NULL,
  customer_label text,
  evidence_policy text NOT NULL DEFAULT 'photo' CHECK (evidence_policy IN ('photo', 'document', 'none')),
  min_evidence integer NOT NULL DEFAULT 1 CHECK (min_evidence >= 0),
  verifier_role text NOT NULL DEFAULT 'jobwork_quality',
  status text NOT NULL DEFAULT 'not_ready' CHECK (status IN (
    'not_ready', 'ready', 'in_progress', 'evidence_submitted', 'verified', 'rejected_evidence', 'blocked', 'waived'
  )),
  planned_date date NOT NULL,
  forecast_date date NOT NULL,
  actual_date date,
  started_by uuid,
  started_at timestamptz,
  submitted_by uuid,
  submitted_at timestamptz,
  decided_by uuid,
  decided_at timestamptz,
  decision_reason text,
  backdate_reason text,
  aggregate_version integer NOT NULL DEFAULT 1,
  UNIQUE (work_package_id, seq),
  CONSTRAINT chk_milestone_verified CHECK (status NOT IN ('verified', 'waived') OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)),
  CONSTRAINT chk_milestone_waived_reason CHECK (status <> 'waived' OR decision_reason IS NOT NULL)
);

-- FR-505: the original plan survives every delay.
CREATE FUNCTION orders.forbid_planned_date_rewrite() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  released timestamptz;
BEGIN
  SELECT released_at INTO released FROM orders.work_package WHERE id = OLD.work_package_id;
  IF released IS NOT NULL AND NEW.planned_date IS DISTINCT FROM OLD.planned_date THEN
    RAISE EXCEPTION 'the planned date of a released milestone is preserved; append a forecast instead';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_milestone_plan_preserved
  BEFORE UPDATE ON orders.milestone
  FOR EACH ROW EXECUTE FUNCTION orders.forbid_planned_date_rewrite();

CREATE TABLE orders.milestone_forecast (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  milestone_id uuid NOT NULL REFERENCES orders.milestone (id) ON DELETE CASCADE,
  revision_no integer NOT NULL CHECK (revision_no > 0),
  forecast_date date NOT NULL,
  reason_code text NOT NULL CHECK (reason_code IN ('machine', 'material', 'labour', 'quality', 'customer', 'other')),
  reason text NOT NULL CHECK (length(reason) >= 3),
  recorded_by uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (milestone_id, revision_no)
);

CREATE TABLE orders.milestone_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  milestone_id uuid NOT NULL REFERENCES orders.milestone (id) ON DELETE CASCADE,
  document_version_id uuid NOT NULL REFERENCES dms.document_version (id),
  file_sha256 text NOT NULL,
  baseline_id uuid REFERENCES dms.baseline (id),
  note text NOT NULL DEFAULT '',
  observed_at timestamptz NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  submitted_by uuid NOT NULL,
  flagged boolean NOT NULL DEFAULT false,
  flag_reason text,
  UNIQUE (milestone_id, document_version_id),
  CONSTRAINT chk_evidence_flag CHECK (flagged = (flag_reason IS NOT NULL))
);

CREATE INDEX idx_milestone_evidence_sha ON orders.milestone_evidence (file_sha256);

CREATE FUNCTION orders.forbid_append_only_rewrite() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME;
END $$;

CREATE TRIGGER trg_milestone_forecast_append_only
  BEFORE UPDATE OR DELETE ON orders.milestone_forecast
  FOR EACH ROW EXECUTE FUNCTION orders.forbid_append_only_rewrite();
CREATE TRIGGER trg_milestone_evidence_append_only
  BEFORE UPDATE OR DELETE ON orders.milestone_evidence
  FOR EACH ROW EXECUTE FUNCTION orders.forbid_append_only_rewrite();

-- ------------------------------------------------------------------ containment

/* doc 19 §5: work started without release is recorded, never quietly absorbed. */
CREATE TABLE orders.containment_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id uuid NOT NULL REFERENCES orders.purchase_order (id),
  work_package_id uuid REFERENCES orders.work_package (id),
  kind text NOT NULL CHECK (kind IN ('unauthorized_start', 'subcontracting', 'other')),
  description text NOT NULL,
  reported_by uuid,
  reported_at timestamptz NOT NULL DEFAULT now(),
  disposition text,
  disposed_by uuid,
  disposed_at timestamptz,
  CONSTRAINT chk_containment_disposed CHECK ((disposed_at IS NULL) = (disposed_by IS NULL))
);
