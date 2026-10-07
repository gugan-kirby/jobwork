-- Supplier settlement, credit notes, support cases (IN-18; doc 10 §§5–6, 15; doc 06 §15; FR-801,
-- FR-805, FR-806, FR-906; BR-FIN-03, BR-FIN-04, BR-FIN-06, BR-FIN-07).
--
-- A supplier's bill is matched against its purchase order and what JobWork actually accepted, and is
-- paid only from a settlement whose eligibility was computed and frozen. Customer money and supplier
-- money never touch: a credit note or refund to the customer is its own record, and a recovery from
-- the supplier is another. A support case links them, and closes only when every action is verified.

-- ----------------------------------------------------------------- accounts (doc 10 §6, conceptual)

INSERT INTO finance.ledger_account (code, name, kind) VALUES
  ('supplier_payable', 'Supplier payables', 'liability'),
  ('cost_of_goods', 'Cost of goods (supplier work)', 'expense'),
  ('gst_input', 'GST input credit', 'asset'),
  ('supplier_recovery', 'Recoveries due from suppliers', 'asset'),
  ('warranty_cost', 'Warranty and customer-remedy cost', 'expense');

-- ----------------------------------------------------------------- supplier bills (FR-805; BR-FIN-07)

CREATE TABLE finance.supplier_bill (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  purchase_order_id uuid NOT NULL REFERENCES orders.purchase_order (id),
  supplier_organization_id uuid NOT NULL REFERENCES iam.organization (id),
  -- The supplier's own invoice number and date, as on its document.
  supplier_reference text NOT NULL CHECK (char_length(supplier_reference) BETWEEN 1 AND 60),
  bill_date date NOT NULL,
  currency text NOT NULL,
  quantity numeric(18, 4) NOT NULL CHECK (quantity > 0),
  taxable_minor bigint NOT NULL CHECK (taxable_minor >= 0),
  tax_minor bigint NOT NULL CHECK (tax_minor >= 0),
  total_minor bigint NOT NULL CHECK (total_minor = taxable_minor + tax_minor),
  document_version_id uuid REFERENCES dms.document_version (id),
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'matched', 'match_exception', 'exception_approved', 'rejected')),
  -- The match as computed: PO, receipt, bill, tolerance and reasons.
  match_snapshot jsonb,
  approval_request_id uuid REFERENCES commercial.approval_request (id),
  decided_by uuid,
  decided_at timestamptz,
  decision_note text NOT NULL DEFAULT '',
  journal_id uuid REFERENCES finance.journal (id),
  submitted_by uuid NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  aggregate_version integer NOT NULL DEFAULT 1,
  UNIQUE (supplier_organization_id, supplier_reference)
);

CREATE INDEX idx_supplier_bill_po ON finance.supplier_bill (purchase_order_id);

-- What the supplier billed is what it billed: content never changes, only the decision on it.
CREATE FUNCTION finance.bill_content_fixed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW.purchase_order_id <> OLD.purchase_order_id OR NEW.supplier_reference <> OLD.supplier_reference
     OR NEW.bill_date <> OLD.bill_date OR NEW.quantity <> OLD.quantity OR NEW.taxable_minor <> OLD.taxable_minor
     OR NEW.tax_minor <> OLD.tax_minor OR NEW.currency <> OLD.currency OR NEW.document_version_id IS DISTINCT FROM OLD.document_version_id THEN
    RAISE EXCEPTION 'a supplier bill keeps what was billed';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_supplier_bill_content_fixed BEFORE UPDATE OR DELETE ON finance.supplier_bill
  FOR EACH ROW EXECUTE FUNCTION finance.bill_content_fixed();

-- BR-FIN-03/04: a settlement exists only for a matched (or approved) bill, and its eligibility is frozen.
CREATE TABLE finance.settlement (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_bill_id uuid NOT NULL UNIQUE REFERENCES finance.supplier_bill (id),
  status text NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'eligible', 'scheduled', 'paid')),
  eligibility jsonb NOT NULL,
  scheduled_for date,
  paid_at timestamptz,
  payment_reference text NOT NULL DEFAULT '',
  journal_id uuid REFERENCES finance.journal (id),
  paid_by uuid,
  aggregate_version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_settlement_paid CHECK (status <> 'paid' OR (paid_at IS NOT NULL AND paid_by IS NOT NULL AND char_length(payment_reference) >= 3 AND journal_id IS NOT NULL))
);

CREATE FUNCTION finance.settlement_paid_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status = 'paid' THEN
    RAISE EXCEPTION 'a paid settlement is final; a reversal is its own record';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_settlement_paid_once BEFORE UPDATE OR DELETE ON finance.settlement
  FOR EACH ROW EXECUTE FUNCTION finance.settlement_paid_once();

-- ----------------------------------------------------------------- credit notes (FR-804, BR-FIN-06)

CREATE TABLE finance.credit_note (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  invoice_id uuid NOT NULL REFERENCES finance.invoice (id),
  sales_order_id uuid NOT NULL REFERENCES orders.sales_order (id),
  customer_organization_id uuid NOT NULL REFERENCES iam.organization (id),
  currency text NOT NULL,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 1000),
  taxable_minor bigint NOT NULL CHECK (taxable_minor >= 0),
  tax_minor bigint NOT NULL CHECK (tax_minor >= 0),
  total_minor bigint NOT NULL CHECK (total_minor = taxable_minor + tax_minor AND total_minor > 0),
  case_id uuid,
  content_hash text NOT NULL,
  journal_id uuid NOT NULL REFERENCES finance.journal (id),
  issued_by uuid NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_credit_note_immutable BEFORE UPDATE OR DELETE ON finance.credit_note
  FOR EACH ROW EXECUTE FUNCTION logistics.forbid_rewrite();

-- ----------------------------------------------------------------- support cases (doc 06 §15)

CREATE SCHEMA support;

CREATE TABLE support.case (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('delivery_issue', 'warranty', 'dispute', 'supplier_failure', 'chargeback')),
  sales_order_id uuid NOT NULL REFERENCES orders.sales_order (id),
  customer_organization_id uuid NOT NULL REFERENCES iam.organization (id),
  -- The leg-2 shipment the case is about, when there is one; the supplier work stays internal.
  shipment_id uuid REFERENCES logistics.shipment (id),
  purchase_order_id uuid REFERENCES orders.purchase_order (id),
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 200),
  description text NOT NULL CHECK (char_length(description) BETWEEN 3 AND 4000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN (
    'open', 'triage', 'investigating', 'resolution_proposed', 'resolution_approved', 'executing', 'verifying', 'closed', 'rejected', 'withdrawn'
  )),
  opened_by uuid NOT NULL,
  opened_by_party text NOT NULL CHECK (opened_by_party IN ('customer', 'jobwork')),
  owner_id uuid,
  approval_request_id uuid REFERENCES commercial.approval_request (id),
  closed_at timestamptz,
  close_note text NOT NULL DEFAULT '',
  aggregate_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_case_order ON support.case (sales_order_id, created_at);

ALTER TABLE finance.credit_note ADD CONSTRAINT fk_credit_note_case FOREIGN KEY (case_id) REFERENCES support.case (id);

-- Doc 06 §15: open → triage → investigating → resolution_proposed → resolution_approved → executing →
-- verifying → closed; open/triage → rejected | withdrawn. A rejected proposal goes back to investigating.
CREATE FUNCTION support.enforce_case_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.sales_order_id <> OLD.sales_order_id OR NEW.kind <> OLD.kind OR NEW.customer_organization_id <> OLD.customer_organization_id THEN
    RAISE EXCEPTION 'a case keeps its order and kind';
  END IF;
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF (OLD.status = 'open' AND NEW.status IN ('triage', 'rejected', 'withdrawn'))
     OR (OLD.status = 'triage' AND NEW.status IN ('investigating', 'rejected', 'withdrawn'))
     OR (OLD.status = 'investigating' AND NEW.status = 'resolution_proposed')
     OR (OLD.status = 'resolution_proposed' AND NEW.status IN ('resolution_approved', 'investigating'))
     OR (OLD.status = 'resolution_approved' AND NEW.status = 'executing')
     OR (OLD.status = 'executing' AND NEW.status = 'verifying')
     OR (OLD.status = 'verifying' AND NEW.status IN ('closed', 'executing'))
  THEN
    IF NEW.status = 'closed' AND EXISTS (SELECT 1 FROM support.resolution_action a WHERE a.case_id = NEW.id AND a.status NOT IN ('verified', 'cancelled')) THEN
      RAISE EXCEPTION 'a case closes only when every resolution action is verified or cancelled';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid case transition: % -> %', OLD.status, NEW.status;
END $$;

CREATE TABLE support.case_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES support.case (id),
  audience text NOT NULL CHECK (audience IN ('customer', 'internal')),
  kind text NOT NULL,
  note text NOT NULL DEFAULT '',
  evidence_document_version_ids uuid[] NOT NULL DEFAULT '{}',
  author_id uuid,
  author_party text NOT NULL CHECK (author_party IN ('customer', 'jobwork', 'system')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_case_event_case ON support.case_event (case_id, created_at);

CREATE TABLE support.resolution_action (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES support.case (id),
  seq integer NOT NULL CHECK (seq > 0),
  kind text NOT NULL CHECK (kind IN ('return_to_jobwork', 'return_to_supplier', 'rework', 'replacement', 'credit_note', 'refund', 'supplier_recovery', 'carrier_claim', 'concession')),
  description text NOT NULL CHECK (char_length(description) BETWEEN 3 AND 1000),
  amount_minor bigint CHECK (amount_minor IS NULL OR amount_minor > 0),
  quantity numeric(18, 4) CHECK (quantity IS NULL OR quantity > 0),
  stock_lot_id uuid REFERENCES logistics.stock_lot (id),
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'done', 'verified', 'cancelled')),
  -- What carried it out: a credit note, a shipment, a reference.
  result jsonb NOT NULL DEFAULT '{}',
  done_by uuid,
  done_at timestamptz,
  verified_by uuid,
  verified_at timestamptz,
  UNIQUE (case_id, seq),
  CONSTRAINT chk_action_money CHECK (kind NOT IN ('credit_note', 'refund', 'supplier_recovery') OR amount_minor IS NOT NULL),
  -- Whoever carried it out does not also verify it (doc 06 §15 "verifying").
  CONSTRAINT chk_action_verifier CHECK (verified_by IS NULL OR verified_by IS DISTINCT FROM done_by)
);

CREATE TRIGGER trg_case_transition BEFORE UPDATE ON support.case
  FOR EACH ROW EXECUTE FUNCTION support.enforce_case_transition();
CREATE TRIGGER trg_case_event_immutable BEFORE UPDATE OR DELETE ON support.case_event
  FOR EACH ROW EXECUTE FUNCTION logistics.forbid_rewrite();

-- IN-17's delivery exceptions hand over to a case by id; closing the case lifts their hold.
ALTER TABLE logistics.delivery_exception ADD COLUMN case_id uuid REFERENCES support.case (id);

-- ----------------------------------------------------------------- approvals, queues, templates

ALTER TABLE commercial.approval_policy DROP CONSTRAINT approval_policy_kind_check;
ALTER TABLE commercial.approval_policy ADD CONSTRAINT approval_policy_kind_check CHECK (kind IN ('award', 'cost_sheet', 'quote', 'allocation', 'change', 'deviation', 'dispatch_override', 'bill_exception', 'case_resolution'));
ALTER TABLE commercial.approval_request DROP CONSTRAINT approval_request_kind_check;
ALTER TABLE commercial.approval_request ADD CONSTRAINT approval_request_kind_check CHECK (kind IN ('award', 'cost_sheet', 'quote', 'allocation', 'change', 'deviation', 'dispatch_override', 'bill_exception', 'case_resolution'));
INSERT INTO commercial.approval_policy (kind, title, current_version_no) VALUES
  ('bill_exception', 'Supplier bill match exception', 1),
  ('case_resolution', 'Support case resolution', 1);
INSERT INTO commercial.approval_policy_version (policy_id, version_no, rules)
SELECT id, 1, CASE kind
  WHEN 'bill_exception' THEN '{"approverRoles":["jobwork_finance"],"tolerance":{"basisPoints":100,"capMinor":50000}}'::jsonb
  ELSE '{"moneyRoles":["jobwork_finance"],"physicalRoles":["jobwork_quality"]}'::jsonb END
  FROM commercial.approval_policy WHERE kind IN ('bill_exception', 'case_resolution');

INSERT INTO platform.sla_policy_version (policy_key, version, calendar_key, target_minutes, escalation_steps, reason)
SELECT key, 1, 'chennai', minutes,
       jsonb_build_array(
         jsonb_build_object('step', 1, 'afterMinutes', minutes, 'notify', 'owner'),
         jsonb_build_object('step', 2, 'afterMinutes', minutes * 2, 'notify', 'escalation')),
       'IN-18 settlement and support targets'
  FROM (VALUES ('supplier_bills_to_match', 1080), ('settlements_held', 2700), ('cases_open', 1080)) AS t (key, minutes);

INSERT INTO platform.work_queue (key, label, owning_team, sla_policy_key) VALUES
  ('supplier_bills_to_match', 'Supplier bills to match', 'Finance', 'supplier_bills_to_match'),
  ('settlements_held', 'Supplier settlements held', 'Finance', 'settlements_held'),
  ('cases_open', 'Support cases', 'Support', 'cases_open');

INSERT INTO communication.template_version (template_key, version, channel, audience, subject, body, variables) VALUES
  ('customer.case_update', 1, 'in_app', 'customer',
   '{{caseNumber}}: {{caseStatus}}',
   'There is news on your case {{caseNumber}} for order {{orderNumber}}.', ARRAY['caseNumber', 'caseStatus', 'orderNumber', 'link']),
  ('customer.case_update', 1, 'email', 'customer',
   '{{caseNumber}}: {{caseStatus}}',
   E'There is news on your case {{caseNumber}} for order {{orderNumber}}:\n{{link}}', ARRAY['caseNumber', 'caseStatus', 'orderNumber', 'link']),
  ('supplier.settlement_paid', 1, 'in_app', 'supplier',
   'Bill {{supplierReference}} paid',
   'JobWork has paid your bill {{supplierReference}} on {{purchaseOrderNumber}}, reference {{paymentReference}}.', ARRAY['supplierReference', 'purchaseOrderNumber', 'paymentReference', 'link']),
  ('supplier.settlement_paid', 1, 'email', 'supplier',
   'Bill {{supplierReference}} paid',
   E'JobWork has paid your bill {{supplierReference}} on {{purchaseOrderNumber}}, reference {{paymentReference}}:\n{{link}}', ARRAY['supplierReference', 'purchaseOrderNumber', 'paymentReference', 'link']);
