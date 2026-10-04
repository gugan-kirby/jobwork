-- Supplier network: profiles, capability taxonomy, declared capability/machine/capacity
-- versions, certifications, service areas, and the verification lifecycle
-- (doc 05 §4 supplier schema, doc 06 §14, FR-105, FR-201..FR-203).

CREATE SCHEMA supplier;

CREATE TABLE supplier.supplier_profile (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL UNIQUE REFERENCES iam.organization (id),
  -- Region class, never a street address: this is the coarsest geography a
  -- customer-facing capability card may ever carry (FR-203).
  region_class text NOT NULL DEFAULT 'unspecified',
  summary text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'onboarding'
    CHECK (status IN ('onboarding', 'active', 'paused', 'exited')),
  aggregate_version integer NOT NULL DEFAULT 1,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Reference taxonomy (doc 05 §18). Seeded here for launch; later edits are audited
-- configuration commands under the `D-21` governance decision, never ad-hoc SQL.
-- Retiring a code never deletes it: history keeps the ids it matched on.
CREATE TABLE supplier.capability (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('process', 'material', 'finish')),
  label text NOT NULL,
  parent_id uuid REFERENCES supplier.capability (id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  effective_from timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_capability_kind ON supplier.capability (kind) WHERE status = 'active';

/*
 * Declared capability, machine and capacity are append-only version chains: publishing
 * an edit supersedes the previous version, it never rewrites it (UC-11). An RFQ that
 * matched against version 2 can still read exactly what version 2 said, years later.
 */
CREATE TABLE supplier.supplier_capability (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_profile_id uuid NOT NULL REFERENCES supplier.supplier_profile (id),
  capability_id uuid NOT NULL REFERENCES supplier.capability (id),
  version_no integer NOT NULL,
  status text NOT NULL DEFAULT 'published'
    CHECK (status IN ('published', 'superseded', 'withdrawn')),
  -- Declared limits (tolerance class, max part size, lot range). Free-form by design:
  -- the matching engine reads named keys it understands and ignores the rest.
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence_document_version_id uuid REFERENCES dms.document_version (id),
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_until timestamptz,
  supersedes_id uuid REFERENCES supplier.supplier_capability (id),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (supplier_profile_id, capability_id, version_no),
  CONSTRAINT chk_capability_attributes CHECK (jsonb_typeof(attributes) = 'object')
);

-- One live declaration per capability per supplier; superseded rows stay readable.
CREATE UNIQUE INDEX uq_supplier_capability_live
  ON supplier.supplier_capability (supplier_profile_id, capability_id)
  WHERE status = 'published';

CREATE TABLE supplier.machine (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_profile_id uuid NOT NULL REFERENCES supplier.supplier_profile (id),
  capability_id uuid REFERENCES supplier.capability (id),
  machine_key text NOT NULL,
  version_no integer NOT NULL,
  status text NOT NULL DEFAULT 'published'
    CHECK (status IN ('published', 'superseded', 'withdrawn')),
  label text NOT NULL,
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  axes integer CHECK (axes IS NULL OR axes BETWEEN 2 AND 9),
  -- Envelope is measurement data, so it is structurally validated rather than trusted:
  -- three numeric millimetre dimensions, optional numeric max weight (doc 07 §14).
  envelope jsonb NOT NULL,
  supersedes_id uuid REFERENCES supplier.machine (id),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (supplier_profile_id, machine_key, version_no),
  -- COALESCE, not a bare jsonb_typeof: an absent key yields NULL, and a NULL CHECK
  -- passes — a missing dimension has to fail as loudly as a wrong-typed one.
  CONSTRAINT chk_machine_envelope CHECK (
    jsonb_typeof(envelope) = 'object'
    AND COALESCE(jsonb_typeof(envelope -> 'xMm'), 'missing') = 'number'
    AND COALESCE(jsonb_typeof(envelope -> 'yMm'), 'missing') = 'number'
    AND COALESCE(jsonb_typeof(envelope -> 'zMm'), 'missing') = 'number'
    AND COALESCE(jsonb_typeof(envelope -> 'maxWeightKg'), 'number') = 'number'
  )
);

CREATE UNIQUE INDEX uq_machine_live
  ON supplier.machine (supplier_profile_id, machine_key)
  WHERE status = 'published';

CREATE TABLE supplier.capacity_window (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_profile_id uuid NOT NULL REFERENCES supplier.supplier_profile (id),
  capability_id uuid REFERENCES supplier.capability (id),
  version_no integer NOT NULL,
  status text NOT NULL DEFAULT 'published'
    CHECK (status IN ('published', 'superseded', 'withdrawn')),
  window_start date NOT NULL,
  window_end date NOT NULL,
  -- Declared, not promised: capacity confidence is a soft score input (doc 07 §2.1).
  available_hours numeric(10, 2) CHECK (available_hours IS NULL OR available_hours >= 0),
  note text,
  supersedes_id uuid REFERENCES supplier.capacity_window (id),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_capacity_window_order CHECK (window_end >= window_start)
);

CREATE INDEX idx_capacity_window_live
  ON supplier.capacity_window (supplier_profile_id, window_start, window_end)
  WHERE status = 'published';

CREATE TABLE supplier.certification (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_profile_id uuid NOT NULL REFERENCES supplier.supplier_profile (id),
  certification_type text NOT NULL,
  certificate_number text,
  issuer text,
  issued_on date,
  expires_on date,
  evidence_document_version_id uuid REFERENCES dms.document_version (id),
  status text NOT NULL DEFAULT 'declared'
    CHECK (status IN ('declared', 'verified', 'expired', 'revoked')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_certification_dates CHECK (expires_on IS NULL OR issued_on IS NULL OR expires_on >= issued_on)
);

CREATE INDEX idx_certification_supplier ON supplier.certification (supplier_profile_id, certification_type);

CREATE TABLE supplier.service_area (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_profile_id uuid NOT NULL REFERENCES supplier.supplier_profile (id),
  region_class text NOT NULL,
  country_code text NOT NULL DEFAULT 'IN' CHECK (char_length(country_code) = 2),
  radius_km integer CHECK (radius_km IS NULL OR radius_km > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (supplier_profile_id, region_class)
);

/*
 * Verification is a lifecycle, not a boolean (doc 06 §14). Each item carries its own
 * status, evidence, expiry and reviewer; organization eligibility is computed over
 * items, never stored as a flag that could drift from them.
 *
 *   draft -> submitted -> under_review -> verified
 *                     \-> returned_for_evidence -> submitted
 *   verified -> expiring -> expired
 *   verified -> revoked
 */
CREATE TABLE supplier.verification_item (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_profile_id uuid NOT NULL REFERENCES supplier.supplier_profile (id),
  kind text NOT NULL CHECK (kind IN
    ('gst', 'udyam', 'pan', 'bank_account', 'address_proof', 'quality_system', 'certification')),
  version_no integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN
    ('draft', 'submitted', 'under_review', 'verified', 'returned_for_evidence',
     'expiring', 'expired', 'revoked')),
  reference_value text,
  evidence_document_version_id uuid REFERENCES dms.document_version (id),
  expires_at timestamptz,
  submitted_by uuid,
  submitted_at timestamptz,
  reviewed_by uuid,
  reviewed_at timestamptz,
  review_reason text,
  supersedes_id uuid REFERENCES supplier.verification_item (id),
  aggregate_version integer NOT NULL DEFAULT 1,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (supplier_profile_id, kind, version_no),
  -- A decided item states who decided it and when. An implication, not an equality:
  -- an item that later expires keeps the reviewer who verified it — that is history,
  -- and forgetting it would be the bug.
  CONSTRAINT chk_verification_reviewed CHECK (
    status NOT IN ('verified', 'returned_for_evidence', 'revoked')
    OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
  ),
  -- Reviewer separation is a data rule, not only an application check (doc 03 §5).
  CONSTRAINT chk_verification_self_review CHECK (
    reviewed_by IS NULL OR submitted_by IS NULL OR reviewed_by <> submitted_by
  )
);

CREATE INDEX idx_verification_supplier ON supplier.verification_item (supplier_profile_id, kind);
CREATE INDEX idx_verification_due
  ON supplier.verification_item (expires_at)
  WHERE status IN ('verified', 'expiring');

CREATE FUNCTION supplier.enforce_verification_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF (OLD.status = 'draft' AND NEW.status = 'submitted')
     OR (OLD.status = 'submitted' AND NEW.status IN ('under_review', 'returned_for_evidence'))
     OR (OLD.status = 'under_review' AND NEW.status IN ('verified', 'returned_for_evidence'))
     OR (OLD.status = 'returned_for_evidence' AND NEW.status = 'submitted')
     OR (OLD.status = 'verified' AND NEW.status IN ('expiring', 'expired', 'revoked'))
     OR (OLD.status = 'expiring' AND NEW.status IN ('expired', 'revoked', 'verified'))
     OR (OLD.status = 'expired' AND NEW.status = 'revoked') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid verification transition: % -> %', OLD.status, NEW.status;
END $$;

CREATE TRIGGER trg_verification_transition
  BEFORE UPDATE OF status ON supplier.verification_item
  FOR EACH ROW EXECUTE FUNCTION supplier.enforce_verification_transition();

-- Published capability and machine versions are evidence: once superseded they are
-- read-only, so a later edit can never change what an old RFQ matched against.
CREATE FUNCTION supplier.forbid_superseded_rewrite() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('superseded', 'withdrawn') THEN
    RAISE EXCEPTION 'supplier.% version % is settled and cannot be edited',
      TG_TABLE_NAME, OLD.version_no;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_supplier_capability_immutable
  BEFORE UPDATE OR DELETE ON supplier.supplier_capability
  FOR EACH ROW EXECUTE FUNCTION supplier.forbid_superseded_rewrite();

CREATE TRIGGER trg_machine_immutable
  BEFORE UPDATE OR DELETE ON supplier.machine
  FOR EACH ROW EXECUTE FUNCTION supplier.forbid_superseded_rewrite();

CREATE TRIGGER trg_capacity_window_immutable
  BEFORE UPDATE OR DELETE ON supplier.capacity_window
  FOR EACH ROW EXECUTE FUNCTION supplier.forbid_superseded_rewrite();

/*
 * Eligibility is a projection over items, computed the same way every time (doc 07
 * §2.1 hard filter, FR-202). A supplier appears here once per live capability with the
 * mandatory-verification verdict of the moment; exclusion reason codes are values, not
 * prose, so operations can explain and audit a miss.
 */
CREATE VIEW supplier.eligibility AS
SELECT
  p.id AS supplier_profile_id,
  p.organization_id,
  p.region_class,
  p.status AS profile_status,
  sc.id AS supplier_capability_id,
  sc.capability_id,
  c.code AS capability_code,
  c.kind AS capability_kind,
  sc.version_no AS capability_version_no,
  sc.attributes,
  (
    SELECT count(*) FROM supplier.verification_item v
     WHERE v.supplier_profile_id = p.id
       AND v.kind IN ('gst', 'pan', 'bank_account')
       -- `expiring` is a warning, not a withdrawal: the evidence is still valid
       -- until its stored date passes (doc 06 §14).
       AND v.status IN ('verified', 'expiring')
       AND (v.expires_at IS NULL OR v.expires_at > now())
  ) AS mandatory_verified_count,
  (
    SELECT count(*) FROM supplier.certification cert
     WHERE cert.supplier_profile_id = p.id
       AND cert.status = 'verified'
       AND (cert.expires_on IS NULL OR cert.expires_on >= current_date)
  ) AS live_certification_count
FROM supplier.supplier_profile p
JOIN supplier.supplier_capability sc ON sc.supplier_profile_id = p.id AND sc.status = 'published'
JOIN supplier.capability c ON c.id = sc.capability_id AND c.status = 'active'
WHERE sc.valid_from <= now()
  AND (sc.valid_until IS NULL OR sc.valid_until > now());

-- Launch taxonomy (Chennai-first categories). Governance of later edits: `D-21`.
INSERT INTO supplier.capability (code, kind, label) VALUES
  ('cnc_milling', 'process', 'CNC milling'),
  ('cnc_turning', 'process', 'CNC turning'),
  ('vmc_machining', 'process', 'VMC machining'),
  ('sheet_metal_laser', 'process', 'Sheet metal laser cutting'),
  ('sheet_metal_bending', 'process', 'Sheet metal bending'),
  ('fabrication_welding', 'process', 'Fabrication and welding'),
  ('casting_investment', 'process', 'Investment casting'),
  ('casting_sand', 'process', 'Sand casting'),
  ('forging', 'process', 'Forging'),
  ('injection_moulding', 'process', 'Plastic injection moulding'),
  ('surface_anodising', 'finish', 'Anodising'),
  ('surface_powder_coating', 'finish', 'Powder coating'),
  ('surface_plating', 'finish', 'Electroplating'),
  ('heat_treatment', 'finish', 'Heat treatment'),
  ('material_aluminium', 'material', 'Aluminium alloys'),
  ('material_mild_steel', 'material', 'Mild steel'),
  ('material_stainless_steel', 'material', 'Stainless steel'),
  ('material_engineering_plastic', 'material', 'Engineering plastics');
