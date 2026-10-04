-- Evaluation, award, cost sheet, customer quote (IN-07; FR-402..FR-406; doc 02 §1,
-- doc 05 §6, doc 06 §6, doc 07 §4, doc 03 §§4-5).
--
-- Four aggregates that must never be one record (BR-COM-02): what a supplier bid (owned
-- by `sourcing`), what JobWork thinks it will really cost (`cost_sheet`), what JobWork
-- offers the customer (`customer_quote`), and the decisions in between (`award`,
-- `approval_*`). Nothing in a customer-facing row names a supplier; the lineage from
-- quote back to bid runs through `cost_sheet_version_id`, which no customer projection
-- reads.

CREATE SCHEMA commercial;

/*
 * Approval policy as versioned data (doc 03 §4, FR-1006). A running approval records
 * the version it was evaluated against, so a later policy change never re-colours
 * history.
 */
CREATE TABLE commercial.approval_policy (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL UNIQUE CHECK (kind IN ('award', 'cost_sheet', 'quote')),
  title text NOT NULL,
  current_version_no integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE commercial.approval_policy_version (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id uuid NOT NULL REFERENCES commercial.approval_policy (id),
  version_no integer NOT NULL CHECK (version_no > 0),
  rules jsonb NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'retired')),
  effective_from timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  activated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (policy_id, version_no)
);

-- One active version per policy: two active rule sets would make "the policy" a coin toss.
CREATE UNIQUE INDEX uq_policy_active_version
  ON commercial.approval_policy_version (policy_id) WHERE status = 'active';

/*
 * An approval request names the exact subject version and hash it is about; the decision
 * is an immutable record with the deciding authority snapshotted (doc 03 §5). Current
 * approval state is a projection over decisions, never a boolean on the subject.
 */
CREATE TABLE commercial.approval_request (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('award', 'cost_sheet', 'quote')),
  subject_type text NOT NULL,
  subject_id uuid NOT NULL,
  subject_version_no integer,
  subject_hash text NOT NULL,
  policy_version_id uuid NOT NULL REFERENCES commercial.approval_policy_version (id),
  requested_by uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  amount_minor bigint,
  currency text,
  margin_bp integer,
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  required_roles text[] NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'returned', 'superseded')),
  decided_at timestamptz,
  CONSTRAINT chk_approval_request_decided CHECK ((status = 'pending') = (decided_at IS NULL))
);

CREATE INDEX idx_approval_request_pending ON commercial.approval_request (requested_at)
  WHERE status = 'pending';

CREATE TABLE commercial.approval_decision (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES commercial.approval_request (id),
  decision text NOT NULL CHECK (decision IN ('approved', 'rejected', 'returned')),
  decided_by uuid NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT now(),
  authority_snapshot jsonb NOT NULL,
  reason text NOT NULL DEFAULT '',
  correlation_id text NOT NULL DEFAULT '',
  CONSTRAINT chk_decision_negative_reason CHECK (
    decision = 'approved' OR length(reason) > 0
  )
);

-- Separation of duties is a database fact, not a UI courtesy: the requester never decides.
CREATE FUNCTION commercial.forbid_self_approval() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  requester uuid;
BEGIN
  SELECT requested_by INTO requester FROM commercial.approval_request WHERE id = NEW.request_id;
  IF requester = NEW.decided_by THEN
    RAISE EXCEPTION 'the requester of an approval cannot decide it';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_approval_separation
  BEFORE INSERT ON commercial.approval_decision
  FOR EACH ROW EXECUTE FUNCTION commercial.forbid_self_approval();

CREATE FUNCTION commercial.forbid_decision_rewrite() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'approval decisions are immutable';
END $$;

CREATE TRIGGER trg_approval_decision_immutable
  BEFORE UPDATE OR DELETE ON commercial.approval_decision
  FOR EACH ROW EXECUTE FUNCTION commercial.forbid_decision_rewrite();

/*
 * Evaluation (FR-402, doc 07 §4): a normalized scenario over the live bid versions.
 * Originals are copied for display and never altered; every input and rate is in the
 * scenario so the same inputs produce the same hash.
 */
CREATE TABLE commercial.evaluation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_id uuid NOT NULL REFERENCES sourcing.rfq (id),
  config_version text NOT NULL,
  scenario jsonb NOT NULL,
  scenario_hash text NOT NULL,
  note text NOT NULL DEFAULT '',
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_evaluation_rfq ON commercial.evaluation (rfq_id, created_at DESC);

CREATE TABLE commercial.evaluation_row (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evaluation_id uuid NOT NULL REFERENCES commercial.evaluation (id) ON DELETE CASCADE,
  bid_version_id uuid NOT NULL REFERENCES sourcing.supplier_bid_version (id),
  supplier_organization_id uuid NOT NULL REFERENCES iam.organization (id),
  original_total_minor bigint NOT NULL,
  normalized_landed_minor bigint NOT NULL,
  components jsonb NOT NULL,
  lines jsonb NOT NULL,
  lead_time_days integer NOT NULL,
  validity_until date NOT NULL,
  feasibility text NOT NULL,
  rank integer NOT NULL,
  flags text[] NOT NULL DEFAULT '{}',
  UNIQUE (evaluation_id, bid_version_id)
);

/*
 * Award (FR-403, BR-COM-07): exact bid versions and lines, per RFQ item, possibly split
 * across suppliers. Proposed by one person, decided by another through an approval
 * request; approval is what moves the bid versions to `selected`.
 */
CREATE TABLE commercial.award (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_id uuid NOT NULL REFERENCES sourcing.rfq (id),
  evaluation_id uuid REFERENCES commercial.evaluation (id),
  status text NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed', 'approved', 'rejected', 'withdrawn')),
  single_source boolean NOT NULL DEFAULT false,
  rationale text NOT NULL DEFAULT '',
  fallback_note text NOT NULL DEFAULT '',
  proposed_by uuid NOT NULL,
  proposed_at timestamptz NOT NULL DEFAULT now(),
  approval_request_id uuid REFERENCES commercial.approval_request (id),
  decided_at timestamptz,
  buy_total_minor bigint NOT NULL DEFAULT 0,
  currency text NOT NULL,
  aggregate_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_award_approved_per_rfq ON commercial.award (rfq_id) WHERE status = 'approved';
CREATE INDEX idx_award_rfq ON commercial.award (rfq_id, proposed_at DESC);

CREATE TABLE commercial.award_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  award_id uuid NOT NULL REFERENCES commercial.award (id) ON DELETE CASCADE,
  rfq_item_id uuid NOT NULL REFERENCES sourcing.rfq_item (id),
  bid_version_id uuid NOT NULL REFERENCES sourcing.supplier_bid_version (id),
  supplier_organization_id uuid NOT NULL REFERENCES iam.organization (id),
  bid_quantity numeric(18, 4) NOT NULL CHECK (bid_quantity > 0),
  quantity numeric(18, 4) NOT NULL CHECK (quantity > 0),
  unit text NOT NULL,
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor >= 0),
  setup_amount_minor bigint NOT NULL DEFAULT 0 CHECK (setup_amount_minor >= 0),
  line_total_minor bigint NOT NULL CHECK (line_total_minor >= 0),
  UNIQUE (award_id, rfq_item_id, bid_version_id)
);

/*
 * Cost sheet (FR-404): landed cost, JobWork's own components, margin. Versions freeze
 * from the moment approval is requested; a change after that is a new version.
 */
CREATE TABLE commercial.cost_sheet (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_id uuid NOT NULL REFERENCES sourcing.rfq (id),
  award_id uuid NOT NULL UNIQUE REFERENCES commercial.award (id),
  enquiry_id uuid NOT NULL REFERENCES sourcing.enquiry (id),
  customer_organization_id uuid NOT NULL REFERENCES iam.organization (id),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'pending_approval', 'approved', 'returned', 'superseded')),
  current_version_no integer NOT NULL DEFAULT 0,
  aggregate_version integer NOT NULL DEFAULT 1,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE commercial.cost_sheet_version (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cost_sheet_id uuid NOT NULL REFERENCES commercial.cost_sheet (id) ON DELETE CASCADE,
  version_no integer NOT NULL CHECK (version_no > 0),
  currency text NOT NULL,
  -- ---- frozen content (once status leaves draft/returned) ----
  buy_total_minor bigint NOT NULL CHECK (buy_total_minor >= 0),
  components jsonb NOT NULL,
  landed_total_minor bigint NOT NULL CHECK (landed_total_minor >= 0),
  margin_minor bigint NOT NULL,
  margin_bp integer NOT NULL,
  sell_total_minor bigint NOT NULL CHECK (sell_total_minor >= 0),
  sell_lines jsonb NOT NULL,
  note text NOT NULL DEFAULT '',
  content_hash text NOT NULL,
  -- ---- disposition ----
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'pending_approval', 'approved', 'returned', 'superseded')),
  approval_request_id uuid REFERENCES commercial.approval_request (id),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  supersedes_version_id uuid REFERENCES commercial.cost_sheet_version (id),
  UNIQUE (cost_sheet_id, version_no)
);

CREATE FUNCTION commercial.forbid_cost_sheet_rewrite() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('pending_approval', 'approved', 'superseded') THEN
      RAISE EXCEPTION 'a cost sheet version under or past approval cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status IN ('pending_approval', 'approved', 'superseded') AND (
       NEW.buy_total_minor IS DISTINCT FROM OLD.buy_total_minor
    OR NEW.components IS DISTINCT FROM OLD.components
    OR NEW.landed_total_minor IS DISTINCT FROM OLD.landed_total_minor
    OR NEW.margin_minor IS DISTINCT FROM OLD.margin_minor
    OR NEW.margin_bp IS DISTINCT FROM OLD.margin_bp
    OR NEW.sell_total_minor IS DISTINCT FROM OLD.sell_total_minor
    OR NEW.sell_lines IS DISTINCT FROM OLD.sell_lines
    OR NEW.note IS DISTINCT FROM OLD.note
    OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.version_no IS DISTINCT FROM OLD.version_no
  ) THEN
    RAISE EXCEPTION 'cost sheet version % content is frozen', OLD.version_no;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_cost_sheet_version_frozen
  BEFORE UPDATE OR DELETE ON commercial.cost_sheet_version
  FOR EACH ROW EXECUTE FUNCTION commercial.forbid_cost_sheet_rewrite();

/*
 * Terms are a versioned document the quotation cites by exact version and hash, so
 * "the terms" can never quietly change under an accepted quote.
 */
CREATE TABLE commercial.terms_document (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  title text NOT NULL,
  current_version_no integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE commercial.terms_version (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  terms_document_id uuid NOT NULL REFERENCES commercial.terms_document (id),
  version_no integer NOT NULL CHECK (version_no > 0),
  body text NOT NULL,
  content_hash text NOT NULL,
  effective_from timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (terms_document_id, version_no)
);

/*
 * Customer quotes (FR-406, BR-COM-04, doc 05 §6, D-12). Options are sibling quotes in
 * one offer set — never versions of one quote, because versions mean supersession in
 * time, not alternatives. Accepting one option withdraws its siblings; the partial
 * unique index is the backstop for the race.
 */
CREATE TABLE commercial.quote_offer_set (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enquiry_id uuid NOT NULL REFERENCES sourcing.enquiry (id),
  rfq_id uuid REFERENCES sourcing.rfq (id),
  customer_organization_id uuid NOT NULL REFERENCES iam.organization (id),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE commercial.customer_quote (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_set_id uuid NOT NULL REFERENCES commercial.quote_offer_set (id),
  enquiry_id uuid NOT NULL REFERENCES sourcing.enquiry (id),
  rfq_id uuid REFERENCES sourcing.rfq (id),
  customer_organization_id uuid NOT NULL REFERENCES iam.organization (id),
  option_label text NOT NULL DEFAULT 'standard'
    CHECK (option_label IN ('standard', 'fast', 'premium')),
  reference text UNIQUE,
  -- Internal lineage only. No customer projection may read this column (BR-COM-05).
  cost_sheet_version_id uuid REFERENCES commercial.cost_sheet_version (id),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'internal_approval', 'approved', 'sent', 'revision_requested',
    'accepted', 'rejected', 'expired', 'withdrawn'
  )),
  current_version_no integer NOT NULL DEFAULT 0,
  decision_reason text,
  aggregate_version integer NOT NULL DEFAULT 1,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (offer_set_id, option_label),
  -- A quote the customer has seen carries a reference; before that it has none.
  CONSTRAINT chk_quote_reference_when_sent CHECK (
    status IN ('draft', 'internal_approval', 'approved', 'withdrawn') OR reference IS NOT NULL
  )
);

CREATE UNIQUE INDEX uq_offer_set_single_acceptance
  ON commercial.customer_quote (offer_set_id) WHERE status = 'accepted';
CREATE INDEX idx_customer_quote_customer ON commercial.customer_quote (customer_organization_id, status);

CREATE TABLE commercial.quote_version (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_quote_id uuid NOT NULL REFERENCES commercial.customer_quote (id) ON DELETE CASCADE,
  version_no integer NOT NULL CHECK (version_no > 0),
  -- ---- frozen content (once status leaves draft) ----
  currency text NOT NULL CHECK (char_length(currency) = 3),
  subtotal_minor bigint NOT NULL CHECK (subtotal_minor >= 0),
  tax_rate_bp integer NOT NULL CHECK (tax_rate_bp >= 0),
  tax_minor bigint NOT NULL CHECK (tax_minor >= 0),
  freight_minor bigint NOT NULL DEFAULT 0 CHECK (freight_minor >= 0),
  total_minor bigint NOT NULL CHECK (total_minor >= 0),
  delivery_lead_days integer NOT NULL CHECK (delivery_lead_days > 0),
  payment_terms text NOT NULL DEFAULT '',
  validity_until date NOT NULL,
  assumptions text NOT NULL DEFAULT '',
  exclusions text NOT NULL DEFAULT '',
  scope_note text NOT NULL DEFAULT '',
  terms_version_id uuid NOT NULL REFERENCES commercial.terms_version (id),
  content_hash text NOT NULL,
  -- ---- disposition ----
  status text NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'internal_approval', 'approved', 'sent', 'superseded',
    'accepted', 'rejected', 'expired', 'withdrawn'
  )),
  approval_request_id uuid REFERENCES commercial.approval_request (id),
  sent_at timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  supersedes_version_id uuid REFERENCES commercial.quote_version (id),
  revision_reason text,
  UNIQUE (customer_quote_id, version_no)
);

ALTER TABLE commercial.customer_quote
  ADD COLUMN accepted_version_id uuid REFERENCES commercial.quote_version (id);

CREATE TABLE commercial.quote_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_version_id uuid NOT NULL REFERENCES commercial.quote_version (id) ON DELETE CASCADE,
  line_no integer NOT NULL CHECK (line_no > 0),
  description text NOT NULL,
  quantity numeric(18, 4) NOT NULL CHECK (quantity > 0),
  unit text NOT NULL,
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor >= 0),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  UNIQUE (quote_version_id, line_no)
);

-- Frozen means frozen (BR-COM-04): a version the customer could have seen, or that is
-- waiting for approval, never changes content. Only the disposition moves.
CREATE FUNCTION commercial.forbid_quote_rewrite() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'a quote version past draft cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'draft' AND (
       NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.subtotal_minor IS DISTINCT FROM OLD.subtotal_minor
    OR NEW.tax_rate_bp IS DISTINCT FROM OLD.tax_rate_bp
    OR NEW.tax_minor IS DISTINCT FROM OLD.tax_minor
    OR NEW.freight_minor IS DISTINCT FROM OLD.freight_minor
    OR NEW.total_minor IS DISTINCT FROM OLD.total_minor
    OR NEW.delivery_lead_days IS DISTINCT FROM OLD.delivery_lead_days
    OR NEW.payment_terms IS DISTINCT FROM OLD.payment_terms
    OR NEW.validity_until IS DISTINCT FROM OLD.validity_until
    OR NEW.assumptions IS DISTINCT FROM OLD.assumptions
    OR NEW.exclusions IS DISTINCT FROM OLD.exclusions
    OR NEW.scope_note IS DISTINCT FROM OLD.scope_note
    OR NEW.terms_version_id IS DISTINCT FROM OLD.terms_version_id
    OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
    OR NEW.version_no IS DISTINCT FROM OLD.version_no
    OR NEW.customer_quote_id IS DISTINCT FROM OLD.customer_quote_id
  ) THEN
    RAISE EXCEPTION 'quote version % content is immutable', OLD.version_no;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_quote_version_immutable
  BEFORE UPDATE OR DELETE ON commercial.quote_version
  FOR EACH ROW EXECUTE FUNCTION commercial.forbid_quote_rewrite();

CREATE FUNCTION commercial.forbid_quote_line_rewrite() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_status text;
BEGIN
  SELECT status INTO parent_status FROM commercial.quote_version
   WHERE id = COALESCE(NEW.quote_version_id, OLD.quote_version_id);
  IF parent_status <> 'draft' THEN
    RAISE EXCEPTION 'quote lines belong to a frozen version and cannot be changed';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_quote_line_immutable
  BEFORE UPDATE OR DELETE ON commercial.quote_line
  FOR EACH ROW EXECUTE FUNCTION commercial.forbid_quote_line_rewrite();

/*
 * Launch policies and terms. Edited by audited commands later (`D-21`); seeded here so
 * the first approval has a version to cite.
 */
INSERT INTO commercial.approval_policy (kind, title, current_version_no) VALUES
  ('award', 'Award approval', 1),
  ('cost_sheet', 'Cost sheet and margin approval', 1),
  ('quote', 'Customer quotation approval', 1);

INSERT INTO commercial.approval_policy_version (policy_id, version_no, rules)
SELECT id, 1, CASE kind
  WHEN 'award' THEN '{"approverRoles":["jobwork_sourcing","jobwork_sales"],"singleSourceApproverRoles":["jobwork_sourcing"]}'::jsonb
  WHEN 'cost_sheet' THEN '{"approverRoles":["jobwork_sales","jobwork_finance"],"minMarginBp":1000,"exceptionApproverRoles":["jobwork_finance"]}'::jsonb
  WHEN 'quote' THEN '{"tiers":[{"maxMinor":50000000,"roles":["jobwork_sales"]},{"maxMinor":null,"roles":["jobwork_sales","jobwork_finance"]}],"tierRequiresAll":false}'::jsonb
  END
FROM commercial.approval_policy;

INSERT INTO commercial.terms_document (code, title, current_version_no)
VALUES ('customer_quotation_terms', 'JobWork customer quotation terms', 1);

INSERT INTO commercial.terms_version (terms_document_id, version_no, body, content_hash)
SELECT id, 1,
  'Draft terms pending legal review (T-02). JobWork sells to you as principal. A quotation is valid until its stated date and binds JobWork only when you accept that exact version. You pay JobWork against its invoices on the stated schedule; no payment is due to any supplier. Material you supply for job work remains yours. JobWork inspects before dispatch and answers for conformance to the released drawing revision.',
  encode(sha256(convert_to(
    'Draft terms pending legal review (T-02). JobWork sells to you as principal. A quotation is valid until its stated date and binds JobWork only when you accept that exact version. You pay JobWork against its invoices on the stated schedule; no payment is due to any supplier. Material you supply for job work remains yours. JobWork inspects before dispatch and answers for conformance to the released drawing revision.',
    'UTF8')), 'hex')
FROM commercial.terms_document WHERE code = 'customer_quotation_terms';
