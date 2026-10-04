-- Engineering change control (IN-13 F-13.2; doc 06 §9; doc 09 §§7–8; FR-604–FR-605).
--
-- A change request carries a proposal from customer, supplier, JobWork or a new document
-- revision through triage, impact, internal approval and (where required) the customer's
-- decision, to a superseding baseline, the suppliers' acknowledgment, verification and
-- closure. Every judgement is an append-only record; amendments to the order and its
-- purchase orders are immutable once written.

CREATE SCHEMA change;

CREATE TABLE change.change_request (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  sales_order_id uuid NOT NULL REFERENCES orders.sales_order (id),
  origin text NOT NULL CHECK (origin IN ('customer', 'supplier', 'internal', 'document_revision')),
  classification text CHECK (classification IN ('clarification', 'correction', 'scope')),
  urgency text NOT NULL DEFAULT 'normal' CHECK (urgency IN ('normal', 'urgent')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 200),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 2000),
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN (
    'proposed', 'triage', 'clarification', 'impact_analysis', 'commercial_approval',
    'approved', 'rejected', 'released', 'implemented', 'verified', 'closed', 'withdrawn'
  )),
  info_request text,
  info_response text,
  -- What suppliers are told: written by JobWork, never the proposer's own words (identity shielding).
  supplier_brief text NOT NULL DEFAULT '',
  customer_approval_required boolean,
  approval_request_id uuid REFERENCES commercial.approval_request (id),
  candidate_baseline_id uuid REFERENCES dms.baseline (id),
  released_baseline_id uuid REFERENCES dms.baseline (id),
  context_document_version_ids uuid[] NOT NULL DEFAULT '{}',
  outcome_note text,
  proposed_by uuid NOT NULL,
  proposed_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  aggregate_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Past triage a change is classified; past impact its customer-approval need is known.
  CONSTRAINT chk_change_classified CHECK (status IN ('proposed', 'triage', 'clarification', 'withdrawn') OR classification IS NOT NULL),
  CONSTRAINT chk_change_approval_known CHECK (status NOT IN ('commercial_approval', 'approved', 'released', 'implemented', 'verified') OR customer_approval_required IS NOT NULL),
  CONSTRAINT chk_change_released CHECK (status NOT IN ('released', 'implemented', 'verified') OR released_baseline_id IS NOT NULL)
);

CREATE INDEX idx_change_request_order ON change.change_request (sales_order_id, created_at DESC);

-- Doc 06 §9, plus the exits a real process needs: a clarification closes from triage, a
-- proposal can be withdrawn before approval, an approver can return the impact, and the
-- customer can reject an internally approved change.
CREATE FUNCTION change.enforce_change_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF (OLD.status = 'proposed' AND NEW.status IN ('triage', 'withdrawn'))
     OR (OLD.status = 'triage' AND NEW.status IN ('clarification', 'impact_analysis', 'closed', 'withdrawn'))
     OR (OLD.status = 'clarification' AND NEW.status IN ('triage', 'withdrawn'))
     OR (OLD.status = 'impact_analysis' AND NEW.status IN ('commercial_approval', 'withdrawn'))
     OR (OLD.status = 'commercial_approval' AND NEW.status IN ('approved', 'rejected', 'impact_analysis'))
     OR (OLD.status = 'approved' AND NEW.status IN ('released', 'rejected'))
     OR (OLD.status = 'released' AND NEW.status = 'implemented')
     OR (OLD.status = 'implemented' AND NEW.status = 'verified')
     OR (OLD.status = 'verified' AND NEW.status = 'closed')
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid change transition: % -> %', OLD.status, NEW.status;
END $$;

CREATE TRIGGER trg_change_transition BEFORE UPDATE OF status ON change.change_request
  FOR EACH ROW EXECUTE FUNCTION change.enforce_change_transition();

ALTER TABLE dms.baseline ADD CONSTRAINT fk_baseline_change_request
  FOREIGN KEY (change_request_id) REFERENCES change.change_request (id);

-- The impact matrix (doc 09 §8), versioned whole: each recording is a new immutable version.
-- `areas` holds one entry per area: {"applicable": true, "answer": "…"} or
-- {"applicable": false, "reason": "…"}. Deltas are structured so amendments are exact.
CREATE TABLE change.impact_version (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  change_request_id uuid NOT NULL REFERENCES change.change_request (id),
  version_no integer NOT NULL CHECK (version_no > 0),
  areas jsonb NOT NULL,
  customer_price_delta_minor bigint NOT NULL DEFAULT 0,
  delivery_date_delta_days integer NOT NULL DEFAULT 0,
  purchase_orders jsonb NOT NULL DEFAULT '[]',
  wip jsonb NOT NULL DEFAULT '[]',
  recorded_by uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (change_request_id, version_no)
);

-- A supplier's own impact input for its purchase order: cost, lead time, WIP. Advisory:
-- engineering decides what enters the impact version.
CREATE TABLE change.supplier_impact (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  change_request_id uuid NOT NULL REFERENCES change.change_request (id),
  purchase_order_id uuid NOT NULL REFERENCES orders.purchase_order (id),
  supplier_organization_id uuid NOT NULL REFERENCES iam.organization (id),
  cost_delta_minor bigint NOT NULL,
  lead_time_delta_days integer NOT NULL,
  wip jsonb NOT NULL DEFAULT '[]',
  note text NOT NULL DEFAULT '',
  submitted_by uuid NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT now()
);

-- A scoped interim stop/continue decision (doc 09 §7 step 3; doc 19 §5 urgent change).
-- Only its lifting is written after issue.
CREATE TABLE change.interim_decision (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  change_request_id uuid NOT NULL REFERENCES change.change_request (id),
  purchase_order_id uuid NOT NULL REFERENCES orders.purchase_order (id),
  decision text NOT NULL CHECK (decision IN ('stop', 'continue')),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 1000),
  expires_at timestamptz NOT NULL,
  issued_by uuid NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  lifted_at timestamptz,
  lifted_by uuid,
  lift_reason text,
  CONSTRAINT chk_interim_expiry CHECK (expires_at > issued_at),
  CONSTRAINT chk_interim_lift CHECK ((lifted_at IS NULL) = (lifted_by IS NULL) AND (lifted_at IS NULL) = (lift_reason IS NULL))
);

CREATE INDEX idx_interim_decision_po ON change.interim_decision (purchase_order_id) WHERE lifted_at IS NULL;

CREATE TABLE change.customer_decision (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  change_request_id uuid NOT NULL UNIQUE REFERENCES change.change_request (id),
  decision text NOT NULL CHECK (decision IN ('approved', 'rejected')),
  reason text NOT NULL DEFAULT '',
  decided_by uuid NOT NULL,
  membership_id uuid NOT NULL,
  authority_snapshot jsonb NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT now()
);

-- The amendments a released change makes to the contract on both legs (doc 06 §6: an
-- accepted quote is never reopened; later records are new).
CREATE TABLE orders.order_amendment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_order_id uuid NOT NULL REFERENCES orders.sales_order (id),
  change_request_id uuid NOT NULL UNIQUE REFERENCES change.change_request (id),
  currency text NOT NULL,
  price_delta_minor bigint NOT NULL,
  delivery_date_delta_days integer NOT NULL,
  installment_id uuid REFERENCES finance.installment (id),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE orders.purchase_order_amendment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id uuid NOT NULL REFERENCES orders.purchase_order (id),
  change_request_id uuid NOT NULL REFERENCES change.change_request (id),
  transmittal_id uuid NOT NULL REFERENCES dms.transmittal (id),
  currency text NOT NULL,
  cost_delta_minor bigint NOT NULL,
  lead_time_delta_days integer NOT NULL,
  acknowledged_by uuid,
  acknowledged_at timestamptz,
  acknowledgment_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (purchase_order_id, change_request_id),
  CONSTRAINT chk_po_amendment_ack CHECK ((acknowledged_at IS NULL) = (acknowledged_by IS NULL))
);

-- Immutability: decisions, impact versions, supplier input and order amendments never
-- change; an interim decision only gets lifted once; a PO amendment only gets acknowledged once.
CREATE FUNCTION change.forbid_rewrite() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME;
END $$;

CREATE TRIGGER trg_impact_version_immutable BEFORE UPDATE OR DELETE ON change.impact_version
  FOR EACH ROW EXECUTE FUNCTION change.forbid_rewrite();
CREATE TRIGGER trg_supplier_impact_immutable BEFORE UPDATE OR DELETE ON change.supplier_impact
  FOR EACH ROW EXECUTE FUNCTION change.forbid_rewrite();
CREATE TRIGGER trg_customer_decision_immutable BEFORE UPDATE OR DELETE ON change.customer_decision
  FOR EACH ROW EXECUTE FUNCTION change.forbid_rewrite();
CREATE TRIGGER trg_order_amendment_immutable BEFORE UPDATE OR DELETE ON orders.order_amendment
  FOR EACH ROW EXECUTE FUNCTION change.forbid_rewrite();

CREATE FUNCTION change.lift_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.lifted_at IS NOT NULL
     OR NEW.change_request_id <> OLD.change_request_id OR NEW.purchase_order_id <> OLD.purchase_order_id
     OR NEW.decision <> OLD.decision OR NEW.reason <> OLD.reason OR NEW.expires_at <> OLD.expires_at
     OR NEW.issued_by <> OLD.issued_by OR NEW.issued_at <> OLD.issued_at THEN
    RAISE EXCEPTION 'an interim decision is only ever lifted, once';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_interim_decision_lift_once BEFORE UPDATE OR DELETE ON change.interim_decision
  FOR EACH ROW EXECUTE FUNCTION change.lift_once();

CREATE FUNCTION change.acknowledge_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.acknowledged_at IS NOT NULL
     OR NEW.purchase_order_id <> OLD.purchase_order_id OR NEW.change_request_id <> OLD.change_request_id
     OR NEW.transmittal_id <> OLD.transmittal_id OR NEW.cost_delta_minor <> OLD.cost_delta_minor
     OR NEW.lead_time_delta_days <> OLD.lead_time_delta_days OR NEW.currency <> OLD.currency THEN
    RAISE EXCEPTION 'a purchase order amendment is only ever acknowledged, once';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_po_amendment_ack_once BEFORE UPDATE OR DELETE ON orders.purchase_order_amendment
  FOR EACH ROW EXECUTE FUNCTION change.acknowledge_once();

-- Approval kind `change` (internal approval through the existing rail).
ALTER TABLE commercial.approval_policy DROP CONSTRAINT approval_policy_kind_check;
ALTER TABLE commercial.approval_policy ADD CONSTRAINT approval_policy_kind_check CHECK (kind IN ('award', 'cost_sheet', 'quote', 'allocation', 'change'));
ALTER TABLE commercial.approval_request DROP CONSTRAINT approval_request_kind_check;
ALTER TABLE commercial.approval_request ADD CONSTRAINT approval_request_kind_check CHECK (kind IN ('award', 'cost_sheet', 'quote', 'allocation', 'change'));
INSERT INTO commercial.approval_policy (kind, title, current_version_no) VALUES ('change', 'Engineering change approval', 1);
INSERT INTO commercial.approval_policy_version (policy_id, version_no, rules)
SELECT id, 1, '{"approverRoles":["jobwork_engineering"],"commercialApproverRoles":["jobwork_sales"]}'::jsonb
  FROM commercial.approval_policy WHERE kind = 'change';

-- A positive customer price delta is invoiced as its own installment.
ALTER TABLE finance.installment DROP CONSTRAINT installment_kind_check;
ALTER TABLE finance.installment ADD CONSTRAINT installment_kind_check CHECK (kind IN ('advance', 'balance', 'change'));
ALTER TABLE finance.invoice DROP CONSTRAINT invoice_kind_check;
ALTER TABLE finance.invoice ADD CONSTRAINT invoice_kind_check CHECK (kind IN ('advance', 'balance', 'final', 'change'));

-- Scrap and rework cost a change causes, against the supplier who incurs it (doc 05 §8).
INSERT INTO finance.ledger_account (code, name, kind) VALUES
  ('change_cost', 'Engineering change cost (scrap, rework)', 'expense'),
  ('supplier_accrual', 'Supplier charges accrued, not yet billed', 'liability');

-- The customer is asked to decide (F-10.3 pipeline).
INSERT INTO communication.template_version (template_key, version, channel, audience, subject, body, variables) VALUES
  ('customer.change_decision_needed', 1, 'in_app', 'customer',
   '{{changeNumber}} needs your decision',
   'A change to order {{orderNumber}} is ready for your decision: its effect on price and delivery is set out for you to approve or reject.', ARRAY['changeNumber', 'orderNumber', 'link']),
  ('customer.change_decision_needed', 1, 'email', 'customer',
   '{{changeNumber}} needs your decision',
   E'A change to order {{orderNumber}} is ready for your decision. Its effect on price and delivery is set out for you to approve or reject:\n{{link}}', ARRAY['changeNumber', 'orderNumber', 'link']);
