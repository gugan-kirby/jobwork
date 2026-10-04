-- RFQ release and immutable bids (IN-06): the sourcing round, who was invited, exactly
-- what they were shown, and what they quoted (doc 06 §§4–5, doc 05 §6, FR-304..FR-306,
-- FR-401). Two rules shape every table here:
--
--   1. A bid version's commercial content is frozen at submit; only its disposition
--      moves afterwards. Immutability is a trigger, not a convention.
--   2. Neither side may read the other. Nothing in a supplier-facing row carries the
--      customer's identity, and nothing customer-facing carries a supplier's.

/*
 * Agreements (doc 03 §1). An NDA is a versioned document the supplier accepts; the
 * acceptance names the exact version, because "they accepted the NDA" is worth nothing
 * without saying which text.
 */
CREATE TABLE sourcing.agreement (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('nda', 'supply_terms', 'quality_terms')),
  title text NOT NULL,
  current_version_no integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, title)
);

CREATE TABLE sourcing.agreement_version (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agreement_id uuid NOT NULL REFERENCES sourcing.agreement (id),
  version_no integer NOT NULL CHECK (version_no > 0),
  body text NOT NULL,
  content_hash text NOT NULL,
  effective_from timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agreement_id, version_no)
);

CREATE TABLE sourcing.agreement_acceptance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agreement_version_id uuid NOT NULL REFERENCES sourcing.agreement_version (id),
  organization_id uuid NOT NULL REFERENCES iam.organization (id),
  accepted_by uuid NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  -- The hash the acceptor saw, so a later edit of the text cannot be passed off as
  -- what they agreed to.
  content_hash text NOT NULL,
  UNIQUE (agreement_version_id, organization_id)
);

/*
 * The sourcing round. An approved enquiry can be sourced more than once (FR-304), each
 * round quoting one frozen requirement revision — never "the enquiry as it is now".
 */
CREATE TABLE sourcing.rfq (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enquiry_id uuid NOT NULL REFERENCES sourcing.enquiry (id),
  requirement_id uuid NOT NULL REFERENCES sourcing.requirement (id),
  round_no integer NOT NULL CHECK (round_no > 0),
  reference text UNIQUE,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'internal_review', 'open', 'responses_received',
    'evaluation', 'awarded', 'no_bid', 'expired', 'cancelled'
  )),
  currency text NOT NULL DEFAULT 'INR' CHECK (char_length(currency) = 3),
  deadline_at timestamptz,
  -- Explicit, because "we sometimes accept late bids" is a policy, not a mood
  -- (doc 19 §4 late bid).
  late_bid_policy text NOT NULL DEFAULT 'reject'
    CHECK (late_bid_policy IN ('reject', 'accept_flagged')),
  instructions text NOT NULL DEFAULT '',
  aggregate_version integer NOT NULL DEFAULT 1,
  released_at timestamptz,
  released_by uuid,
  closed_at timestamptz,
  closed_by uuid,
  outcome_reason text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (enquiry_id, round_no),
  -- An open round has a deadline; suppliers cannot plan against "sometime".
  CONSTRAINT chk_rfq_deadline CHECK (status = 'draft' OR deadline_at IS NOT NULL),
  CONSTRAINT chk_rfq_released CHECK (
    status IN ('draft', 'internal_review', 'cancelled') OR released_at IS NOT NULL
  )
);

CREATE INDEX idx_rfq_enquiry ON sourcing.rfq (enquiry_id, round_no DESC);
CREATE INDEX idx_rfq_open_deadline ON sourcing.rfq (deadline_at) WHERE status = 'open';

/*
 * The lines suppliers quote against, frozen from the requirement revision. A bid line
 * points here, so a later enquiry edit cannot silently re-point a submitted price at a
 * different part.
 */
CREATE TABLE sourcing.rfq_item (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_id uuid NOT NULL REFERENCES sourcing.rfq (id) ON DELETE CASCADE,
  enquiry_item_id uuid REFERENCES sourcing.enquiry_item (id),
  line_no integer NOT NULL CHECK (line_no > 0),
  part_name text NOT NULL,
  description text NOT NULL DEFAULT '',
  -- The exact quantity/unit breakpoints quoted against, as frozen.
  quantity_breakpoints jsonb NOT NULL,
  specification jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rfq_id, line_no),
  CONSTRAINT chk_rfq_item_breakpoints CHECK (jsonb_typeof(quantity_breakpoints) = 'array')
);

/*
 * One invitation per supplier, with its own state (doc 06 §4) and the eligibility facts
 * that justified it at release time (`FR-204`). A supplier added despite an exclusion
 * carries the override reason on the row — never nowhere.
 */
CREATE TABLE sourcing.rfq_supplier (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_id uuid NOT NULL REFERENCES sourcing.rfq (id) ON DELETE CASCADE,
  supplier_profile_id uuid NOT NULL REFERENCES supplier.supplier_profile (id),
  supplier_organization_id uuid NOT NULL REFERENCES iam.organization (id),
  status text NOT NULL DEFAULT 'prepared' CHECK (status IN (
    'prepared', 'invited', 'acknowledged', 'clarifying', 'responded',
    'declined', 'no_response', 'revoked'
  )),
  eligibility_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  override_reason text,
  invited_at timestamptz,
  acknowledged_at timestamptz,
  responded_at timestamptz,
  declined_at timestamptz,
  decline_code text CHECK (decline_code IS NULL OR decline_code IN (
    'capacity', 'capability', 'commercial', 'lead_time', 'material', 'other'
  )),
  decline_reason text,
  revoked_at timestamptz,
  revoke_reason text,
  aggregate_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rfq_id, supplier_profile_id),
  CONSTRAINT chk_rfq_supplier_declined CHECK (
    (status = 'declined') = (decline_code IS NOT NULL)
  ),
  CONSTRAINT chk_rfq_supplier_override CHECK (
    override_reason IS NULL OR char_length(override_reason) >= 3
  )
);

CREATE INDEX idx_rfq_supplier_org ON sourcing.rfq_supplier (supplier_organization_id, status);

/*
 * The sanitized release manifest (doc 09 §6, `BR-ENG-02`): the exact document versions
 * suppliers were shown, with the digest each carried at release. "The drawing" is never
 * a moving target — this row is what an award is defensible against.
 */
CREATE TABLE sourcing.rfq_release_item (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_id uuid NOT NULL REFERENCES sourcing.rfq (id) ON DELETE CASCADE,
  document_version_id uuid NOT NULL REFERENCES dms.document_version (id),
  role text NOT NULL DEFAULT 'reference'
    CHECK (role IN ('governing', 'reference', 'assisted_photo')),
  sha256 text NOT NULL,
  released_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rfq_id, document_version_id)
);

/*
 * Matching, recorded rather than recomputed (`FR-204`): the inputs, the configuration
 * version, every exclusion reason, and the shortlist that came out. A shortlist nobody
 * can explain six months later is not a shortlist, it is a rumour.
 */
CREATE TABLE sourcing.match_snapshot (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_id uuid REFERENCES sourcing.rfq (id) ON DELETE CASCADE,
  enquiry_id uuid NOT NULL REFERENCES sourcing.enquiry (id),
  config_version text NOT NULL,
  inputs jsonb NOT NULL,
  candidates jsonb NOT NULL,
  shortlist jsonb NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_match_snapshot_enquiry ON sourcing.match_snapshot (enquiry_id, created_at DESC);

/*
 * The bid aggregate holds the supplier's working draft — a convenience that is never
 * evidence — and points at the versions, which are.
 */
CREATE TABLE sourcing.supplier_bid (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_id uuid NOT NULL REFERENCES sourcing.rfq (id) ON DELETE CASCADE,
  rfq_supplier_id uuid NOT NULL REFERENCES sourcing.rfq_supplier (id) ON DELETE CASCADE,
  supplier_organization_id uuid NOT NULL REFERENCES iam.organization (id),
  draft jsonb NOT NULL DEFAULT '{}'::jsonb,
  current_version_no integer NOT NULL DEFAULT 0,
  aggregate_version integer NOT NULL DEFAULT 1,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rfq_id, rfq_supplier_id)
);

/*
 * A submitted bid version (doc 06 §5, `FR-401`, `BR-COM-03`).
 *
 * The frozen family is everything the content hash covers — currency, totals, lead time,
 * validity, feasibility, assumptions, exclusions. The disposition family is status and
 * the decision that settled it. The trigger below protects exactly the first list.
 */
CREATE TABLE sourcing.supplier_bid_version (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_bid_id uuid NOT NULL REFERENCES sourcing.supplier_bid (id) ON DELETE CASCADE,
  version_no integer NOT NULL CHECK (version_no > 0),

  -- ---- frozen content ----
  currency text NOT NULL CHECK (char_length(currency) = 3),
  tax_treatment text NOT NULL DEFAULT 'gst_extra'
    CHECK (tax_treatment IN ('gst_extra', 'gst_inclusive', 'exempt')),
  -- Money is integer minor units everywhere (doc 02): rupees never touch a float.
  lines_total_minor bigint NOT NULL CHECK (lines_total_minor >= 0),
  nre_amount_minor bigint NOT NULL DEFAULT 0 CHECK (nre_amount_minor >= 0),
  freight_amount_minor bigint NOT NULL DEFAULT 0 CHECK (freight_amount_minor >= 0),
  total_amount_minor bigint NOT NULL CHECK (total_amount_minor >= 0),
  lead_time_days integer NOT NULL CHECK (lead_time_days > 0),
  validity_until date NOT NULL,
  feasibility text NOT NULL DEFAULT 'feasible'
    CHECK (feasibility IN ('feasible', 'feasible_with_deviation', 'not_feasible')),
  assumptions text NOT NULL DEFAULT '',
  exclusions text NOT NULL DEFAULT '',
  payment_terms text NOT NULL DEFAULT '',
  note text NOT NULL DEFAULT '',
  content_hash text NOT NULL,

  -- ---- disposition ----
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN (
    'submitted', 'superseded', 'selected', 'rejected', 'withdrawn', 'expired'
  )),
  received_at timestamptz NOT NULL DEFAULT now(),
  late boolean NOT NULL DEFAULT false,
  submitted_by uuid,
  supersedes_version_id uuid REFERENCES sourcing.supplier_bid_version (id),
  revision_reason text,
  disposition_reason text,
  decided_at timestamptz,
  decided_by uuid,

  UNIQUE (supplier_bid_id, version_no)
);

CREATE INDEX idx_bid_version_live
  ON sourcing.supplier_bid_version (supplier_bid_id)
  WHERE status = 'submitted';

CREATE TABLE sourcing.bid_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_bid_version_id uuid NOT NULL
    REFERENCES sourcing.supplier_bid_version (id) ON DELETE CASCADE,
  rfq_item_id uuid NOT NULL REFERENCES sourcing.rfq_item (id),
  line_no integer NOT NULL CHECK (line_no > 0),
  quantity numeric(18, 4) NOT NULL CHECK (quantity > 0),
  unit text NOT NULL,
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor >= 0),
  setup_amount_minor bigint NOT NULL DEFAULT 0 CHECK (setup_amount_minor >= 0),
  lead_time_days integer CHECK (lead_time_days IS NULL OR lead_time_days > 0),
  note text NOT NULL DEFAULT '',
  UNIQUE (supplier_bid_version_id, line_no, quantity)
);

/*
 * Frozen means frozen. The disposition columns listed here may move; everything else on
 * a submitted version is evidence, and the database refuses to edit it however the
 * application asks (`BR-COM-03`).
 */
CREATE FUNCTION sourcing.forbid_bid_content_rewrite() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a submitted bid version cannot be deleted';
  END IF;
  IF NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.tax_treatment IS DISTINCT FROM OLD.tax_treatment
     OR NEW.lines_total_minor IS DISTINCT FROM OLD.lines_total_minor
     OR NEW.nre_amount_minor IS DISTINCT FROM OLD.nre_amount_minor
     OR NEW.freight_amount_minor IS DISTINCT FROM OLD.freight_amount_minor
     OR NEW.total_amount_minor IS DISTINCT FROM OLD.total_amount_minor
     OR NEW.lead_time_days IS DISTINCT FROM OLD.lead_time_days
     OR NEW.validity_until IS DISTINCT FROM OLD.validity_until
     OR NEW.feasibility IS DISTINCT FROM OLD.feasibility
     OR NEW.assumptions IS DISTINCT FROM OLD.assumptions
     OR NEW.exclusions IS DISTINCT FROM OLD.exclusions
     OR NEW.payment_terms IS DISTINCT FROM OLD.payment_terms
     OR NEW.note IS DISTINCT FROM OLD.note
     OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
     OR NEW.version_no IS DISTINCT FROM OLD.version_no
     OR NEW.supplier_bid_id IS DISTINCT FROM OLD.supplier_bid_id
     OR NEW.received_at IS DISTINCT FROM OLD.received_at THEN
    RAISE EXCEPTION 'submitted bid version % content is immutable', OLD.version_no;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_bid_version_immutable
  BEFORE UPDATE OR DELETE ON sourcing.supplier_bid_version
  FOR EACH ROW EXECUTE FUNCTION sourcing.forbid_bid_content_rewrite();

-- Bid lines are part of the frozen content; they are written once with their version.
CREATE FUNCTION sourcing.forbid_bid_line_rewrite() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'bid lines belong to a submitted version and cannot be changed';
END $$;

CREATE TRIGGER trg_bid_line_immutable
  BEFORE UPDATE OR DELETE ON sourcing.bid_line
  FOR EACH ROW EXECUTE FUNCTION sourcing.forbid_bid_line_rewrite();

/*
 * The RFQ state machine (doc 06 §4). Cancellation is always available; everything else
 * moves forward only.
 */
CREATE FUNCTION sourcing.enforce_rfq_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF NEW.status = 'cancelled'
     OR (OLD.status = 'draft' AND NEW.status IN ('internal_review', 'open'))
     OR (OLD.status = 'internal_review' AND NEW.status IN ('open', 'draft'))
     OR (OLD.status = 'open' AND NEW.status IN ('responses_received', 'evaluation', 'no_bid', 'expired'))
     OR (OLD.status = 'responses_received' AND NEW.status IN ('evaluation', 'expired'))
     OR (OLD.status = 'evaluation' AND NEW.status IN ('awarded', 'no_bid'))
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid rfq transition: % -> %', OLD.status, NEW.status;
END $$;

CREATE TRIGGER trg_rfq_transition
  BEFORE UPDATE OF status ON sourcing.rfq
  FOR EACH ROW EXECUTE FUNCTION sourcing.enforce_rfq_transition();
