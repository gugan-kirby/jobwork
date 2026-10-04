-- Acceptance, contracts, orders, payment boundary (IN-08; FR-407, FR-501, FR-502,
-- FR-801..FR-806 subset; doc 02 §8; doc 06 §§7, 12; doc 10 §§4-7; doc 05 §§4, 6).
--
-- The customer accepts an exact quotation version; that acceptance is evidence, the
-- contract is a snapshot, the order is the thing that moves. Money is a separate ledger:
-- a customer payment is never a supplier payment (BR-FIN), every posted journal balances
-- per currency, and a provider's say-so becomes truth only through a named command.

-- ------------------------------------------------------------------ quote: structured schedule

-- The quotation's payment schedule becomes data so the order can compute instalments
-- (doc 10 §4). Both columns are frozen with the rest of the version content.
ALTER TABLE commercial.quote_version
  ADD COLUMN advance_bp integer NOT NULL DEFAULT 5000 CHECK (advance_bp BETWEEN 0 AND 10000),
  ADD COLUMN balance_trigger text NOT NULL DEFAULT 'before_dispatch'
    CHECK (balance_trigger IN ('on_acceptance', 'before_dispatch', 'on_delivery', 'net_30'));

CREATE OR REPLACE FUNCTION commercial.forbid_quote_rewrite() RETURNS trigger
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
    OR NEW.advance_bp IS DISTINCT FROM OLD.advance_bp
    OR NEW.balance_trigger IS DISTINCT FROM OLD.balance_trigger
  ) THEN
    RAISE EXCEPTION 'quote version % content is immutable', OLD.version_no;
  END IF;
  RETURN NEW;
END $$;

-- Manual cash allocation is a maker-checker decision (doc 10 §7) on the same approval rail.
ALTER TABLE commercial.approval_policy DROP CONSTRAINT approval_policy_kind_check;
ALTER TABLE commercial.approval_policy ADD CONSTRAINT approval_policy_kind_check
  CHECK (kind IN ('award', 'cost_sheet', 'quote', 'allocation'));
ALTER TABLE commercial.approval_request DROP CONSTRAINT approval_request_kind_check;
ALTER TABLE commercial.approval_request ADD CONSTRAINT approval_request_kind_check
  CHECK (kind IN ('award', 'cost_sheet', 'quote', 'allocation'));
INSERT INTO commercial.approval_policy (kind, title, current_version_no)
VALUES ('allocation', 'Manual cash allocation', 1);
INSERT INTO commercial.approval_policy_version (policy_id, version_no, rules)
SELECT id, 1, '{"approverRoles":["jobwork_finance"]}'::jsonb
  FROM commercial.approval_policy WHERE kind = 'allocation';

-- ------------------------------------------------------------------ acceptance and contract

/*
 * Acceptance evidence (FR-407, BR-COM-09): the exact version and hash, the terms version
 * and hash the customer acknowledged, who did it with what authority, and the idempotency
 * key that makes a retry return this row instead of making another. One per version.
 */
CREATE TABLE commercial.acceptance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_quote_id uuid NOT NULL REFERENCES commercial.customer_quote (id),
  quote_version_id uuid NOT NULL UNIQUE REFERENCES commercial.quote_version (id),
  content_hash text NOT NULL,
  terms_version_id uuid NOT NULL REFERENCES commercial.terms_version (id),
  terms_hash text NOT NULL,
  accepted_by uuid NOT NULL,
  organization_id uuid NOT NULL REFERENCES iam.organization (id),
  authority_snapshot jsonb NOT NULL,
  idempotency_key text,
  correlation_id text NOT NULL DEFAULT '',
  accepted_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE commercial.contract_snapshot (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  acceptance_id uuid NOT NULL UNIQUE REFERENCES commercial.acceptance (id),
  snapshot jsonb NOT NULL,
  content_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION commercial.forbid_evidence_rewrite() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable evidence', TG_TABLE_NAME;
END $$;

CREATE TRIGGER trg_acceptance_immutable
  BEFORE UPDATE OR DELETE ON commercial.acceptance
  FOR EACH ROW EXECUTE FUNCTION commercial.forbid_evidence_rewrite();
CREATE TRIGGER trg_contract_snapshot_immutable
  BEFORE UPDATE OR DELETE ON commercial.contract_snapshot
  FOR EACH ROW EXECUTE FUNCTION commercial.forbid_evidence_rewrite();

-- ------------------------------------------------------------------ orders

CREATE SCHEMA orders;

/*
 * The sales order (FR-501): JobWork's sell-side commitment, born from an acceptance.
 * Its status is the doc 06 §7 lifecycle; IN-08 moves it from pending commercial release
 * to pending technical release, and later increments carry it on.
 */
CREATE TABLE orders.sales_order (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  customer_organization_id uuid NOT NULL REFERENCES iam.organization (id),
  enquiry_id uuid NOT NULL REFERENCES sourcing.enquiry (id),
  customer_quote_id uuid NOT NULL REFERENCES commercial.customer_quote (id),
  accepted_quote_version_id uuid NOT NULL REFERENCES commercial.quote_version (id),
  acceptance_id uuid NOT NULL UNIQUE REFERENCES commercial.acceptance (id),
  contract_snapshot_id uuid NOT NULL UNIQUE REFERENCES commercial.contract_snapshot (id),
  title text NOT NULL,
  currency text NOT NULL,
  total_minor bigint NOT NULL CHECK (total_minor >= 0),
  delivery_lead_days integer NOT NULL,
  delivery_site_id uuid REFERENCES iam.organization_site (id),
  status text NOT NULL DEFAULT 'pending_commercial_release' CHECK (status IN (
    'pending_commercial_release', 'pending_technical_release', 'planning',
    'released_to_production', 'in_production', 'quality_hold', 'quality_released',
    'ready_supplier_dispatch', 'in_supplier_to_jobwork_transit', 'received_jobwork',
    'ready_customer_dispatch', 'in_customer_transit', 'delivered', 'customer_accepted',
    'closed', 'cancelled'
  )),
  commercial_released_at timestamptz,
  commercial_release_basis text,
  aggregate_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_sales_order_customer ON orders.sales_order (customer_organization_id, created_at DESC);

CREATE TABLE orders.sales_order_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_order_id uuid NOT NULL REFERENCES orders.sales_order (id) ON DELETE CASCADE,
  line_no integer NOT NULL CHECK (line_no > 0),
  description text NOT NULL,
  quantity numeric(18, 4) NOT NULL CHECK (quantity > 0),
  unit text NOT NULL,
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor >= 0),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  UNIQUE (sales_order_id, line_no)
);

/*
 * The purchase order (FR-502, BR-COM-07): JobWork's buy-side commitment to one supplier,
 * a snapshot of the exact award lines and the bid versions they came from. It is born
 * `pending_baseline`: no work may be released against it until a technical baseline is
 * released and acknowledged (IN-09).
 */
CREATE TABLE orders.purchase_order (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  sales_order_id uuid NOT NULL REFERENCES orders.sales_order (id),
  award_id uuid NOT NULL REFERENCES commercial.award (id),
  supplier_organization_id uuid NOT NULL REFERENCES iam.organization (id),
  supplier_profile_id uuid NOT NULL REFERENCES supplier.supplier_profile (id),
  status text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'acknowledged', 'cancelled')),
  baseline_status text NOT NULL DEFAULT 'pending_baseline'
    CHECK (baseline_status IN ('pending_baseline', 'baseline_released')),
  currency text NOT NULL,
  total_minor bigint NOT NULL CHECK (total_minor >= 0),
  lead_time_days integer NOT NULL,
  payment_terms text NOT NULL DEFAULT '',
  instructions text NOT NULL DEFAULT '',
  content_hash text NOT NULL,
  issued_by uuid NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_by uuid,
  acknowledged_at timestamptz,
  acknowledgment_note text NOT NULL DEFAULT '',
  cancelled_at timestamptz,
  cancel_reason text,
  aggregate_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sales_order_id, supplier_organization_id),
  CONSTRAINT chk_po_acknowledged CHECK ((status = 'acknowledged') = (acknowledged_at IS NOT NULL))
);

CREATE INDEX idx_purchase_order_supplier ON orders.purchase_order (supplier_organization_id, issued_at DESC);

CREATE TABLE orders.purchase_order_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id uuid NOT NULL REFERENCES orders.purchase_order (id) ON DELETE CASCADE,
  line_no integer NOT NULL CHECK (line_no > 0),
  rfq_item_id uuid NOT NULL REFERENCES sourcing.rfq_item (id),
  bid_version_id uuid NOT NULL REFERENCES sourcing.supplier_bid_version (id),
  description text NOT NULL,
  quantity numeric(18, 4) NOT NULL CHECK (quantity > 0),
  unit text NOT NULL,
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor >= 0),
  setup_amount_minor bigint NOT NULL DEFAULT 0 CHECK (setup_amount_minor >= 0),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  UNIQUE (purchase_order_id, line_no)
);

-- An issued PO's commercial content is frozen; only acknowledgment and cancellation move.
CREATE FUNCTION orders.forbid_po_rewrite() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'an issued purchase order cannot be deleted';
  END IF;
  IF NEW.number IS DISTINCT FROM OLD.number
     OR NEW.sales_order_id IS DISTINCT FROM OLD.sales_order_id
     OR NEW.award_id IS DISTINCT FROM OLD.award_id
     OR NEW.supplier_organization_id IS DISTINCT FROM OLD.supplier_organization_id
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.total_minor IS DISTINCT FROM OLD.total_minor
     OR NEW.lead_time_days IS DISTINCT FROM OLD.lead_time_days
     OR NEW.payment_terms IS DISTINCT FROM OLD.payment_terms
     OR NEW.instructions IS DISTINCT FROM OLD.instructions
     OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
     OR NEW.issued_at IS DISTINCT FROM OLD.issued_at THEN
    RAISE EXCEPTION 'purchase order % content is immutable', OLD.number;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_purchase_order_immutable
  BEFORE UPDATE OR DELETE ON orders.purchase_order
  FOR EACH ROW EXECUTE FUNCTION orders.forbid_po_rewrite();

CREATE FUNCTION orders.forbid_po_line_rewrite() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'purchase order lines are frozen at issue';
END $$;

CREATE TRIGGER trg_purchase_order_line_immutable
  BEFORE UPDATE OR DELETE ON orders.purchase_order_line
  FOR EACH ROW EXECUTE FUNCTION orders.forbid_po_line_rewrite();

-- ------------------------------------------------------------------ finance

CREATE SCHEMA finance;

/*
 * Chart of accounts, conceptual (doc 10 §6): enough to post the IN-08 flows with
 * balanced journals. The real chart is an accounting decision (`T-04`); codes are stable
 * so journals survive a rename.
 */
CREATE TABLE finance.ledger_account (
  code text PRIMARY KEY,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('asset', 'liability', 'income', 'expense', 'clearing'))
);

INSERT INTO finance.ledger_account (code, name, kind) VALUES
  ('customer_receivable', 'Customer receivables', 'asset'),
  ('gateway_clearing', 'Payment gateway clearing', 'clearing'),
  ('bank', 'Bank', 'asset'),
  ('revenue', 'Revenue', 'income'),
  ('gst_output', 'GST output liability', 'liability'),
  ('unapplied_cash', 'Unapplied customer cash', 'liability'),
  ('suspense', 'Suspense — unidentified receipts', 'liability'),
  ('gateway_fees', 'Gateway fees', 'expense'),
  ('customer_refunds', 'Customer refunds payable', 'liability');

CREATE TABLE finance.journal (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  posted_at timestamptz NOT NULL DEFAULT now(),
  source_type text NOT NULL,
  source_id uuid,
  description text NOT NULL,
  currency text NOT NULL CHECK (char_length(currency) = 3),
  correlation_id text NOT NULL DEFAULT ''
);

CREATE TABLE finance.journal_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_id uuid NOT NULL REFERENCES finance.journal (id) ON DELETE CASCADE,
  account_code text NOT NULL REFERENCES finance.ledger_account (code),
  debit_minor bigint NOT NULL DEFAULT 0 CHECK (debit_minor >= 0),
  credit_minor bigint NOT NULL DEFAULT 0 CHECK (credit_minor >= 0),
  cost_object_type text,
  cost_object_id uuid,
  CONSTRAINT chk_journal_line_one_side CHECK (debit_minor = 0 OR credit_minor = 0),
  CONSTRAINT chk_journal_line_nonzero CHECK (debit_minor + credit_minor > 0)
);

CREATE INDEX idx_journal_line_journal ON finance.journal_line (journal_id);

/*
 * Every posted journal balances (BR-FIN, FR-806). Checked when the transaction commits,
 * so a journal is written as a whole; an imbalance anywhere rolls the whole command back.
 */
CREATE FUNCTION finance.assert_journal_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target uuid := COALESCE(NEW.journal_id, OLD.journal_id);
  diff bigint;
BEGIN
  SELECT COALESCE(SUM(debit_minor), 0) - COALESCE(SUM(credit_minor), 0) INTO diff
    FROM finance.journal_line WHERE journal_id = target;
  IF diff <> 0 THEN
    RAISE EXCEPTION 'journal % does not balance (difference % minor units)', target, diff;
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER trg_journal_balanced
  AFTER INSERT OR UPDATE OR DELETE ON finance.journal_line
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION finance.assert_journal_balanced();

-- Posted means posted: corrections are compensating journals, never edits.
CREATE FUNCTION finance.forbid_journal_rewrite() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'posted journals are immutable; post a compensating journal';
END $$;

CREATE TRIGGER trg_journal_immutable
  BEFORE UPDATE OR DELETE ON finance.journal
  FOR EACH ROW EXECUTE FUNCTION finance.forbid_journal_rewrite();
CREATE TRIGGER trg_journal_line_immutable
  BEFORE UPDATE OR DELETE ON finance.journal_line
  FOR EACH ROW EXECUTE FUNCTION finance.forbid_journal_rewrite();

/*
 * Instalments (doc 10 §4): the order's payment schedule, derived from the accepted
 * version's advance share and balance trigger. Each becomes an invoice when its trigger
 * is met; the advance is invoiced at acceptance.
 */
CREATE TABLE finance.installment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_order_id uuid NOT NULL REFERENCES orders.sales_order (id) ON DELETE CASCADE,
  seq integer NOT NULL CHECK (seq > 0),
  kind text NOT NULL CHECK (kind IN ('advance', 'balance')),
  label text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency text NOT NULL,
  trigger text NOT NULL CHECK (trigger IN ('on_acceptance', 'before_dispatch', 'on_delivery', 'net_30')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'invoiced', 'paid', 'waived')),
  invoice_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sales_order_id, seq)
);

/*
 * Customer invoices (FR-804): issued once, numbered once, never edited. Payment state is
 * a disposition; a correction is a credit note (Phase 2) and the original stands.
 */
CREATE TABLE finance.invoice (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  sales_order_id uuid NOT NULL REFERENCES orders.sales_order (id),
  installment_id uuid REFERENCES finance.installment (id),
  customer_organization_id uuid NOT NULL REFERENCES iam.organization (id),
  kind text NOT NULL CHECK (kind IN ('advance', 'balance', 'final')),
  -- ---- frozen content ----
  currency text NOT NULL,
  lines jsonb NOT NULL,
  subtotal_minor bigint NOT NULL CHECK (subtotal_minor >= 0),
  tax_rate_bp integer NOT NULL CHECK (tax_rate_bp >= 0),
  tax_minor bigint NOT NULL CHECK (tax_minor >= 0),
  total_minor bigint NOT NULL CHECK (total_minor >= 0),
  content_hash text NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  issued_by uuid NOT NULL,
  due_at timestamptz NOT NULL,
  -- ---- disposition ----
  paid_minor bigint NOT NULL DEFAULT 0 CHECK (paid_minor >= 0),
  status text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'partially_paid', 'paid', 'void')),
  voided_at timestamptz,
  void_reason text,
  aggregate_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_invoice_paid_status CHECK (
    (status = 'paid' AND paid_minor >= total_minor)
    OR (status = 'partially_paid' AND paid_minor > 0 AND paid_minor < total_minor)
    OR (status = 'issued' AND paid_minor = 0)
    OR status = 'void'
  )
);

CREATE INDEX idx_invoice_customer ON finance.invoice (customer_organization_id, issued_at DESC);

ALTER TABLE finance.installment
  ADD CONSTRAINT fk_installment_invoice FOREIGN KEY (invoice_id) REFERENCES finance.invoice (id);

CREATE FUNCTION finance.forbid_invoice_rewrite() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'an issued invoice cannot be deleted';
  END IF;
  IF NEW.number IS DISTINCT FROM OLD.number
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.lines IS DISTINCT FROM OLD.lines
     OR NEW.subtotal_minor IS DISTINCT FROM OLD.subtotal_minor
     OR NEW.tax_rate_bp IS DISTINCT FROM OLD.tax_rate_bp
     OR NEW.tax_minor IS DISTINCT FROM OLD.tax_minor
     OR NEW.total_minor IS DISTINCT FROM OLD.total_minor
     OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
     OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
     OR NEW.sales_order_id IS DISTINCT FROM OLD.sales_order_id
     OR NEW.customer_organization_id IS DISTINCT FROM OLD.customer_organization_id THEN
    RAISE EXCEPTION 'invoice % content is immutable', OLD.number;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_invoice_immutable
  BEFORE UPDATE OR DELETE ON finance.invoice
  FOR EACH ROW EXECUTE FUNCTION finance.forbid_invoice_rewrite();

/* Credit (doc 10 §4): a limit somebody approved, and holds somebody placed with a reason. */
CREATE TABLE finance.credit_profile (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_organization_id uuid NOT NULL UNIQUE REFERENCES iam.organization (id),
  limit_minor bigint NOT NULL CHECK (limit_minor >= 0),
  currency text NOT NULL,
  terms_days integer NOT NULL CHECK (terms_days >= 0),
  approved_by uuid NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT now(),
  valid_until date,
  note text NOT NULL DEFAULT '',
  aggregate_version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE finance.credit_hold (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_organization_id uuid NOT NULL REFERENCES iam.organization (id),
  reason text NOT NULL CHECK (length(reason) >= 3),
  placed_by uuid NOT NULL,
  placed_at timestamptz NOT NULL DEFAULT now(),
  released_by uuid,
  released_at timestamptz,
  release_reason text,
  CONSTRAINT chk_credit_hold_release CHECK ((released_at IS NULL) = (released_by IS NULL))
);

CREATE INDEX idx_credit_hold_active ON finance.credit_hold (customer_organization_id)
  WHERE released_at IS NULL;

/*
 * Payment intents (doc 06 §12, doc 10 §7): created server-side from an invoice's open
 * balance, never from a client amount. The provider's intent id is unique per provider.
 */
CREATE TABLE finance.payment_intent (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES finance.invoice (id),
  sales_order_id uuid NOT NULL REFERENCES orders.sales_order (id),
  customer_organization_id uuid NOT NULL REFERENCES iam.organization (id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL,
  provider text NOT NULL,
  provider_intent_id text NOT NULL,
  checkout_url text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'created' CHECK (status IN (
    'created', 'pending_customer', 'authorized', 'captured', 'failed', 'cancelled', 'expired'
  )),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_event_at timestamptz,
  UNIQUE (provider, provider_intent_id)
);

CREATE INDEX idx_payment_intent_invoice ON finance.payment_intent (invoice_id, created_at DESC);

/*
 * What the provider (or the bank) actually did. Unique per provider transaction id, so a
 * duplicated or replayed callback can never post twice (FR-803).
 */
CREATE TABLE finance.payment_transaction (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  provider_transaction_id text NOT NULL,
  intent_id uuid REFERENCES finance.payment_intent (id),
  customer_organization_id uuid REFERENCES iam.organization (id),
  kind text NOT NULL CHECK (kind IN ('authorize', 'capture', 'refund', 'reversal', 'bank_transfer')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  reference text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded', 'allocated', 'suspense', 'ignored')),
  journal_id uuid REFERENCES finance.journal (id),
  note text NOT NULL DEFAULT '',
  UNIQUE (provider, provider_transaction_id)
);

CREATE INDEX idx_payment_transaction_suspense ON finance.payment_transaction (received_at)
  WHERE status = 'suspense';

CREATE TABLE finance.payment_allocation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id uuid NOT NULL REFERENCES finance.payment_transaction (id),
  invoice_id uuid NOT NULL REFERENCES finance.invoice (id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  allocated_by uuid,
  allocated_at timestamptz NOT NULL DEFAULT now(),
  approval_request_id uuid REFERENCES commercial.approval_request (id),
  journal_id uuid REFERENCES finance.journal (id),
  UNIQUE (transaction_id, invoice_id)
);

/* Overpayment stays the customer's money, visible and refundable — never a wallet (D-03). */
CREATE TABLE finance.unapplied_credit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_organization_id uuid NOT NULL REFERENCES iam.organization (id),
  transaction_id uuid NOT NULL REFERENCES finance.payment_transaction (id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz,
  consumed_by_allocation_id uuid REFERENCES finance.payment_allocation (id)
);

/*
 * Webhook receipts (doc 08 §11): every delivery claimed once per provider, with the
 * signature verdict and what became of it. A duplicate is answered from here.
 */
CREATE TABLE finance.webhook_receipt (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  delivery_id text NOT NULL,
  event_type text NOT NULL DEFAULT '',
  body_sha256 text NOT NULL,
  signature_ok boolean NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('processed', 'duplicate', 'rejected', 'suspense', 'ignored')),
  transaction_id uuid REFERENCES finance.payment_transaction (id),
  note text NOT NULL DEFAULT '',
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, delivery_id)
);
