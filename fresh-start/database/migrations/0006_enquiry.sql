-- Sourcing, enquiry slice: the customer's requirement as it was stated, the revisions
-- that freeze it, the documents it governs, and the structured clarification it may
-- need before sourcing starts (doc 05 §4 sourcing schema, doc 06 §3, FR-301..FR-303).

CREATE SCHEMA sourcing;

/*
 * Deferred from IN-01: doc 05 §4 places `organization_site` in `iam`, but nothing
 * needed a delivery address until now. `FR-301` does — an enquiry names destinations —
 * so the table lands here, in the migration that first depends on it.
 * A site is an address of a party we already know; it carries no supplier identity and
 * is never projected onto customer-facing output about a supplier.
 */
CREATE TABLE iam.organization_site (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES iam.organization (id),
  label text NOT NULL,
  kind text NOT NULL DEFAULT 'delivery'
    CHECK (kind IN ('registered', 'delivery', 'pickup', 'works')),
  address_line1 text NOT NULL,
  address_line2 text NOT NULL DEFAULT '',
  city text NOT NULL,
  state text NOT NULL,
  postal_code text NOT NULL,
  country_code text NOT NULL DEFAULT 'IN' CHECK (country_code ~ '^[A-Z]{2}$'),
  gstin text,
  contact_name text NOT NULL DEFAULT '',
  contact_phone text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, label)
);

CREATE INDEX idx_organization_site_org ON iam.organization_site (organization_id)
  WHERE status = 'active';

/*
 * The enquiry aggregate root. It holds lifecycle only: everything a person actually
 * wrote lives on items and is frozen into `requirement` at submit, so the root can be
 * re-read without deciding which of several drafts was the one that was sourced.
 *
 *   draft -> submitted -> under_review -> clarification_required -> under_review
 *   under_review -> approved_for_sourcing | closed
 *   draft|submitted -> cancelled
 */
CREATE TABLE sourcing.enquiry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_organization_id uuid NOT NULL REFERENCES iam.organization (id),
  -- Human handle both sides can say out loud. Allocated at submit, not at draft:
  -- an abandoned draft must not burn a number the customer has already seen.
  reference text UNIQUE,
  title text NOT NULL DEFAULT '',
  application_note text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'submitted', 'under_review', 'clarification_required',
    'approved_for_sourcing', 'closed', 'cancelled'
  )),
  confidentiality text NOT NULL DEFAULT 'confidential'
    CHECK (confidentiality IN ('standard', 'confidential', 'nda_required')),
  -- The doc 19 §3 "only a photo/vague description" path. An assisted enquiry is
  -- accepted with gaps and routed to engineering; it is never released as an RFQ
  -- from intake alone, which is why the flag lives on the row and not in a note.
  assisted_intake boolean NOT NULL DEFAULT false,
  delivery_site_id uuid REFERENCES iam.organization_site (id),
  required_by_date date,
  partial_delivery text NOT NULL DEFAULT 'not_allowed'
    CHECK (partial_delivery IN ('allowed', 'not_allowed')),
  packaging_note text NOT NULL DEFAULT '',
  -- Which requirement revision each side is entitled to read. The customer's view is
  -- the intake revision they submitted; operations reads the latest reviewed one.
  submitted_revision_no integer,
  current_revision_no integer,
  aggregate_version integer NOT NULL DEFAULT 1,
  -- Set when this enquiry was created by copying another (UC-02 reorder path).
  copied_from_enquiry_id uuid REFERENCES sourcing.enquiry (id),
  created_by uuid,
  submitted_by uuid,
  submitted_at timestamptz,
  decided_by uuid,
  decided_at timestamptz,
  decision_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- A reference exists exactly once the enquiry has left draft, and never disappears.
  CONSTRAINT chk_enquiry_reference_after_draft CHECK (
    (status IN ('draft', 'cancelled')) OR reference IS NOT NULL
  ),
  CONSTRAINT chk_enquiry_submitted_fields CHECK (
    (submitted_at IS NULL) = (submitted_by IS NULL)
  ),
  CONSTRAINT chk_enquiry_decision_reason CHECK (
    status <> 'closed' OR decision_reason IS NOT NULL
  )
);

CREATE INDEX idx_enquiry_customer ON sourcing.enquiry (customer_organization_id, created_at DESC);
-- The operations intake queue reads exactly these three states, oldest first.
CREATE INDEX idx_enquiry_triage ON sourcing.enquiry (submitted_at)
  WHERE status IN ('submitted', 'under_review', 'clarification_required');

/*
 * One line of what is wanted. Quantity is a breakpoint set, not a number: a customer
 * who asks for 10 / 100 / 1000 is asking three commercial questions at once, and the
 * RFQ has to carry all three (`FR-301`).
 *
 * Measurements keep the value and the unit the customer typed. Nothing here is silently
 * converted; normalization is a later, versioned step (doc 02 money/measurement rule).
 */
CREATE TABLE sourcing.enquiry_item (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enquiry_id uuid NOT NULL REFERENCES sourcing.enquiry (id) ON DELETE CASCADE,
  line_no integer NOT NULL CHECK (line_no > 0),
  part_name text NOT NULL DEFAULT '',
  part_number text,
  description text NOT NULL DEFAULT '',
  process_capability_id uuid REFERENCES supplier.capability (id),
  material_capability_id uuid REFERENCES supplier.capability (id),
  material_grade text,
  material_source_restriction text,
  -- [{ "quantity": 100, "unit": "piece", "kind": "production" }, ...]
  quantity_breakpoints jsonb NOT NULL DEFAULT '[]'::jsonb,
  tolerance_class text,
  -- { "value": 0.05, "unit": "mm" } — value and unit, never a bare number.
  critical_tolerance jsonb,
  surface_finish text,
  heat_treatment text,
  coating text,
  -- Inspection expectations captured at intake, not discovered at dispatch
  -- (Xometry-pattern; doc 19 §7 rework arguments start here).
  inspection_level text NOT NULL DEFAULT 'standard'
    CHECK (inspection_level IN ('standard', 'dimensional_report', 'third_party', 'first_article')),
  quality_note text NOT NULL DEFAULT '',
  target_date date,
  -- Overrides the enquiry-level destination when one line ships elsewhere (`FR-301`).
  delivery_site_id uuid REFERENCES iam.organization_site (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (enquiry_id, line_no),
  CONSTRAINT chk_item_breakpoints CHECK (jsonb_typeof(quantity_breakpoints) = 'array'),
  CONSTRAINT chk_item_tolerance CHECK (
    critical_tolerance IS NULL OR (
      jsonb_typeof(critical_tolerance) = 'object'
      AND COALESCE(jsonb_typeof(critical_tolerance -> 'value'), 'missing') = 'number'
      AND COALESCE(jsonb_typeof(critical_tolerance -> 'unit'), 'missing') = 'string'
    )
  )
);

/*
 * Documents an enquiry governs. The link is to a document version, not a document:
 * "revision B was what we quoted" has to survive revision C being uploaded (doc 19 §3).
 * Exactly one link per enquiry may be the governing document — the answer to a
 * CAD/2D conflict is a declaration, not a preference, and it is recorded here.
 */
CREATE TABLE sourcing.enquiry_document (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enquiry_id uuid NOT NULL REFERENCES sourcing.enquiry (id) ON DELETE CASCADE,
  enquiry_item_id uuid REFERENCES sourcing.enquiry_item (id) ON DELETE CASCADE,
  document_version_id uuid NOT NULL REFERENCES dms.document_version (id),
  role text NOT NULL DEFAULT 'reference'
    CHECK (role IN ('governing', 'reference', 'assisted_photo')),
  note text NOT NULL DEFAULT '',
  linked_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (enquiry_id, document_version_id)
);

CREATE UNIQUE INDEX uq_enquiry_governing_document
  ON sourcing.enquiry_document (enquiry_id) WHERE role = 'governing';

/*
 * The frozen requirement. Submitting writes an `intake` revision; a clarification that
 * changes what is being asked writes a later `reviewed` revision. Revisions are
 * append-only and content-hashed: an RFQ, a bid and a quote all cite a revision number,
 * and citing it has to mean one exact set of words forever (doc 06 §3).
 */
CREATE TABLE sourcing.requirement (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enquiry_id uuid NOT NULL REFERENCES sourcing.enquiry (id),
  revision_no integer NOT NULL CHECK (revision_no > 0),
  kind text NOT NULL CHECK (kind IN ('intake', 'reviewed')),
  -- The whole enquiry as it read at freeze time: header, items, document links.
  snapshot jsonb NOT NULL,
  content_hash text NOT NULL,
  supersedes_id uuid REFERENCES sourcing.requirement (id),
  frozen_by uuid,
  frozen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (enquiry_id, revision_no),
  CONSTRAINT chk_requirement_snapshot CHECK (jsonb_typeof(snapshot) = 'object')
);

/*
 * A frozen revision is frozen. No column of it is ever updated — the rule is stated
 * here so a future migration, ORM or well-meaning fix cannot quietly break the one
 * guarantee every downstream citation depends on (doc 02 immutability rule).
 */
CREATE FUNCTION sourcing.reject_requirement_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'requirement revisions are immutable (enquiry %, revision %)',
    OLD.enquiry_id, OLD.revision_no
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_requirement_immutable
  BEFORE UPDATE OR DELETE ON sourcing.requirement
  FOR EACH ROW EXECUTE FUNCTION sourcing.reject_requirement_mutation();

/*
 * Structured clarification (`FR-303`). A question is a row, an answer is a column on
 * that row, and neither one touches the submitted snapshot — that is the whole point:
 * operations can ask, the customer can answer, and what was originally submitted stays
 * legible next to both.
 */
CREATE TABLE sourcing.clarification (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enquiry_id uuid NOT NULL REFERENCES sourcing.enquiry (id) ON DELETE CASCADE,
  enquiry_item_id uuid REFERENCES sourcing.enquiry_item (id) ON DELETE CASCADE,
  sequence_no integer NOT NULL CHECK (sequence_no > 0),
  -- Which round of questions this belongs to, so a second round reads as a second round.
  round_no integer NOT NULL DEFAULT 1 CHECK (round_no > 0),
  topic text NOT NULL CHECK (topic IN (
    'material', 'tolerance', 'quantity', 'documents', 'quality', 'delivery', 'commercial', 'other'
  )),
  question text NOT NULL,
  -- The requirement revision the question was asked against.
  asked_against_revision_no integer NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'withdrawn')),
  answer text,
  answer_document_version_id uuid REFERENCES dms.document_version (id),
  asked_by uuid,
  asked_at timestamptz NOT NULL DEFAULT now(),
  answered_by uuid,
  answered_at timestamptz,
  UNIQUE (enquiry_id, sequence_no),
  CONSTRAINT chk_clarification_answer CHECK (
    (status = 'answered') = (answer IS NOT NULL AND answered_at IS NOT NULL)
  )
);

CREATE INDEX idx_clarification_open ON sourcing.clarification (enquiry_id)
  WHERE status = 'open';
