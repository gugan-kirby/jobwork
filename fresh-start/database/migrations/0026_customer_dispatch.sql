-- Customer dispatch, delivery and acceptance (IN-17 F-17.1; doc 06 §§7, 11, 13; doc 10 §§11–12;
-- doc 03 §4; FR-902, FR-904, FR-905; BR-LOG-01, BR-LOG-03, BR-LOG-05).
--
-- Leg 2 reuses IN-16's shipment aggregate and leg machine. For a JobWork-to-customer leg,
-- `receiving_check` reads "awaiting the customer's acceptance" and `accepted` reads "accepted by
-- the customer or by the acceptance window". The database refuses either without its evidence:
-- a proof of delivery before acceptance is awaited, an acceptance record before it is accepted.
-- A refused delivery ends the leg; the way back is a return leg of its own (BR-LOG-01).

-- ----------------------------------------------------------------- shipment

ALTER TABLE logistics.shipment DROP CONSTRAINT shipment_status_check;
ALTER TABLE logistics.shipment ADD CONSTRAINT shipment_status_check CHECK (status IN (
  'draft', 'planned', 'ready_for_release', 'released', 'picked_up', 'in_transit',
  'delivered_to_destination', 'receiving_check', 'accepted', 'discrepancy_hold', 'cancelled', 'refused'
));

ALTER TABLE logistics.shipment
  -- A return leg names the outbound shipment it brings back.
  ADD COLUMN returns_shipment_id uuid REFERENCES logistics.shipment (id),
  -- Leg 2's packing check (neutral cartons, supplier marks removed, JobWork labels, the customer's
  -- packaging note); frozen at release with the documents.
  ADD COLUMN packing_check jsonb NOT NULL DEFAULT '{}',
  -- Set once by the proof of delivery: the end of the customer's acceptance window.
  ADD COLUMN acceptance_due_at timestamptz,
  ADD CONSTRAINT chk_shipment_return_leg CHECK (returns_shipment_id IS NULL OR leg = 'customer_to_jobwork'),
  ADD CONSTRAINT chk_shipment_acceptance_due CHECK (acceptance_due_at IS NULL OR leg = 'jobwork_to_customer');

CREATE UNIQUE INDEX uq_shipment_return ON logistics.shipment (returns_shipment_id) WHERE returns_shipment_id IS NOT NULL;

CREATE TABLE logistics.acceptance_policy_version (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version integer NOT NULL UNIQUE CHECK (version > 0),
  window_days integer NOT NULL CHECK (window_days BETWEEN 1 AND 90),
  deemed_acceptance boolean NOT NULL,
  warranty_statement text NOT NULL CHECK (char_length(warranty_statement) >= 20),
  reason text NOT NULL,
  effective_from timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE logistics.proof_of_delivery (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id uuid NOT NULL UNIQUE REFERENCES logistics.shipment (id),
  received_by_name text NOT NULL CHECK (char_length(received_by_name) BETWEEN 2 AND 120),
  received_at timestamptz NOT NULL,
  -- Where it was handed over: the destination snapshot, or a redirect's.
  delivered_to_snapshot jsonb NOT NULL,
  packages_received integer NOT NULL CHECK (packages_received >= 0),
  remarks text NOT NULL CHECK (remarks IN ('clean', 'with_remarks')),
  remarks_note text NOT NULL DEFAULT '',
  document_version_ids uuid[] NOT NULL DEFAULT '{}',
  source text NOT NULL CHECK (source IN ('carrier', 'driver', 'jobwork_staff')),
  recorded_by uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_pod_remarks CHECK (remarks = 'clean' OR char_length(remarks_note) >= 3)
);

CREATE TABLE logistics.delivery_acceptance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id uuid NOT NULL UNIQUE REFERENCES logistics.shipment (id),
  basis text NOT NULL CHECK (basis IN ('explicit', 'deemed')),
  accepted_by uuid,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  policy_version_id uuid NOT NULL REFERENCES logistics.acceptance_policy_version (id),
  -- As shown to the customer: acceptance never waives warranty (doc 19 §8).
  warranty_statement text NOT NULL,
  note text NOT NULL DEFAULT '',
  CONSTRAINT chk_acceptance_actor CHECK ((basis = 'explicit') = (accepted_by IS NOT NULL))
);

-- Doc 06 §11 plus leg 2: refusal at the door, a customer's report withdrawn, nothing arrived.
CREATE OR REPLACE FUNCTION logistics.enforce_shipment_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.leg <> OLD.leg OR NEW.sales_order_id <> OLD.sales_order_id OR NEW.work_package_id IS DISTINCT FROM OLD.work_package_id
     OR NEW.shipper_organization_id <> OLD.shipper_organization_id OR NEW.consignee_organization_id <> OLD.consignee_organization_id
     OR NEW.returns_shipment_id IS DISTINCT FROM OLD.returns_shipment_id THEN
    RAISE EXCEPTION 'a shipment keeps its leg and its parties';
  END IF;
  IF OLD.status NOT IN ('draft', 'planned', 'ready_for_release') AND (
       NEW.origin_snapshot IS DISTINCT FROM OLD.origin_snapshot OR NEW.destination_snapshot IS DISTINCT FROM OLD.destination_snapshot
       OR NEW.documents IS DISTINCT FROM OLD.documents OR NEW.release_snapshot IS DISTINCT FROM OLD.release_snapshot
       OR NEW.origin_site_id IS DISTINCT FROM OLD.origin_site_id OR NEW.destination_site_id IS DISTINCT FROM OLD.destination_site_id
       OR NEW.packing_check IS DISTINCT FROM OLD.packing_check) THEN
    RAISE EXCEPTION 'a released shipment keeps its addresses, documents, packing check and release record';
  END IF;
  IF OLD.status NOT IN ('draft', 'planned', 'ready_for_release', 'released') AND (
       NEW.carrier_mode IS DISTINCT FROM OLD.carrier_mode OR NEW.carrier_name IS DISTINCT FROM OLD.carrier_name OR NEW.tracking_reference IS DISTINCT FROM OLD.tracking_reference) THEN
    RAISE EXCEPTION 'a picked-up shipment keeps its carrier';
  END IF;
  IF OLD.acceptance_due_at IS NOT NULL AND NEW.acceptance_due_at IS DISTINCT FROM OLD.acceptance_due_at THEN
    RAISE EXCEPTION 'the acceptance window is set once, by the proof of delivery';
  END IF;
  IF NEW.status <> OLD.status THEN
    IF NOT (
         (OLD.status = 'draft' AND NEW.status IN ('planned', 'cancelled'))
      OR (OLD.status = 'planned' AND NEW.status IN ('ready_for_release', 'cancelled'))
      OR (OLD.status = 'ready_for_release' AND NEW.status IN ('released', 'planned', 'cancelled'))
      OR (OLD.status = 'released' AND NEW.status = 'picked_up')
      OR (OLD.status = 'picked_up' AND NEW.status IN ('in_transit', 'delivered_to_destination', 'receiving_check'))
      OR (OLD.status = 'in_transit' AND NEW.status IN ('delivered_to_destination', 'receiving_check'))
      OR (OLD.status = 'delivered_to_destination' AND NEW.status = 'receiving_check')
      OR (OLD.status = 'receiving_check' AND NEW.status IN ('accepted', 'discrepancy_hold'))
      OR (OLD.status = 'discrepancy_hold' AND NEW.status = 'accepted')
      OR (NEW.leg = 'jobwork_to_customer' AND OLD.status IN ('picked_up', 'in_transit', 'delivered_to_destination') AND NEW.status = 'refused')
      OR (NEW.leg = 'jobwork_to_customer' AND OLD.status = 'discrepancy_hold' AND NEW.status = 'receiving_check')
      OR (NEW.leg = 'jobwork_to_customer' AND OLD.status = 'delivered_to_destination' AND NEW.status = 'discrepancy_hold')
    ) THEN
      RAISE EXCEPTION 'invalid shipment transition: % -> %', OLD.status, NEW.status;
    END IF;
  END IF;
  -- BR-LOG-05 at the constraint: POD and acceptance are different evidence.
  IF NEW.leg = 'jobwork_to_customer' AND NEW.status = 'receiving_check' AND OLD.status <> 'receiving_check'
     AND NOT EXISTS (SELECT 1 FROM logistics.proof_of_delivery WHERE shipment_id = NEW.id) THEN
    RAISE EXCEPTION 'a delivery awaits acceptance only once its proof of delivery is recorded';
  END IF;
  IF NEW.leg = 'jobwork_to_customer' AND NEW.status = 'accepted' AND OLD.status <> 'accepted'
     AND NOT EXISTS (SELECT 1 FROM logistics.delivery_acceptance WHERE shipment_id = NEW.id) THEN
    RAISE EXCEPTION 'a delivery is accepted only by the customer or by its acceptance window';
  END IF;
  RETURN NEW;
END $$;

-- ----------------------------------------------------------------- confirmations and overrides

-- The destination and receiving contact as confirmed, bound to the site snapshot's hash: an edit
-- to the site afterwards leaves the confirmation standing for the old address only.
CREATE TABLE logistics.address_confirmation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id uuid NOT NULL REFERENCES logistics.shipment (id),
  site_id uuid NOT NULL REFERENCES iam.organization_site (id),
  snapshot_hash text NOT NULL,
  party text NOT NULL CHECK (party IN ('customer', 'jobwork')),
  confirmed_by uuid NOT NULL,
  note text NOT NULL DEFAULT '',
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_confirmation_note CHECK (party = 'customer' OR char_length(note) >= 3)
);

CREATE INDEX idx_address_confirmation_shipment ON logistics.address_confirmation (shipment_id, confirmed_at);

-- Doc 03 §4: an override covers exactly the reasons its owner approved, and no others.
CREATE TABLE logistics.dispatch_override (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id uuid NOT NULL REFERENCES logistics.shipment (id),
  guard_key text NOT NULL CHECK (guard_key IN ('quality', 'payment', 'commitment', 'holds')),
  reasons jsonb NOT NULL CHECK (jsonb_typeof(reasons) = 'array' AND jsonb_array_length(reasons) > 0),
  reasons_hash text NOT NULL,
  justification text NOT NULL CHECK (char_length(justification) BETWEEN 10 AND 1000),
  approval_request_id uuid NOT NULL UNIQUE REFERENCES commercial.approval_request (id),
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'approved', 'rejected', 'returned')),
  requested_by uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid,
  decided_at timestamptz,
  CONSTRAINT chk_override_decided CHECK ((status = 'requested') = (decided_at IS NULL) AND (decided_at IS NULL) = (decided_by IS NULL))
);

CREATE UNIQUE INDEX uq_dispatch_override_pending ON logistics.dispatch_override (shipment_id, guard_key) WHERE status = 'requested';

CREATE FUNCTION logistics.override_decides_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status <> 'requested' OR NEW.shipment_id <> OLD.shipment_id OR NEW.guard_key <> OLD.guard_key
     OR NEW.reasons <> OLD.reasons OR NEW.reasons_hash <> OLD.reasons_hash OR NEW.justification <> OLD.justification
     OR NEW.approval_request_id <> OLD.approval_request_id OR NEW.requested_by <> OLD.requested_by THEN
    RAISE EXCEPTION 'a dispatch override is requested as it stands and decided once';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_dispatch_override_decides_once BEFORE UPDATE OR DELETE ON logistics.dispatch_override
  FOR EACH ROW EXECUTE FUNCTION logistics.override_decides_once();

-- ----------------------------------------------------------------- delivery exceptions

CREATE TABLE logistics.delivery_exception (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  shipment_id uuid NOT NULL REFERENCES logistics.shipment (id),
  kind text NOT NULL CHECK (kind IN ('address_change', 'refused', 'not_received', 'shortage', 'damage', 'wrong_item', 'quality_defect', 'documents')),
  raised_by_party text NOT NULL CHECK (raised_by_party IN ('customer', 'jobwork', 'carrier')),
  raised_by uuid,
  -- JobWork's lot marking as the customer sees it, and how many pieces.
  lot_marking text NOT NULL DEFAULT '' CHECK (char_length(lot_marking) <= 60),
  quantity numeric(18, 4) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  description text NOT NULL CHECK (char_length(description) BETWEEN 3 AND 2000),
  evidence_document_version_ids uuid[] NOT NULL DEFAULT '{}',
  -- Reported after acceptance: recorded for IN-18's warranty case, holds nothing.
  warranty_claim boolean NOT NULL DEFAULT false,
  requested_site_id uuid REFERENCES iam.organization_site (id),
  requested_snapshot jsonb,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolution text CHECK (resolution IN ('found_delivered', 'customer_withdrew', 'handed_to_case', 'redirected', 'declined', 'returned_to_stock')),
  resolution_note text,
  -- The support case (IN-18) or carrier reference this exception continues under.
  case_reference text NOT NULL DEFAULT '',
  carrier_charge_note text NOT NULL DEFAULT '',
  resolved_by uuid,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_exception_address CHECK ((kind = 'address_change') = (requested_snapshot IS NOT NULL)),
  CONSTRAINT chk_exception_resolved CHECK (status = 'open' OR (resolution IS NOT NULL AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL AND char_length(coalesce(resolution_note, '')) >= 3))
);

CREATE INDEX idx_delivery_exception_shipment ON logistics.delivery_exception (shipment_id, created_at);

CREATE FUNCTION logistics.exception_resolves_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status <> 'open' OR NEW.shipment_id <> OLD.shipment_id OR NEW.kind <> OLD.kind OR NEW.number <> OLD.number
     OR NEW.description <> OLD.description OR NEW.quantity <> OLD.quantity OR NEW.lot_marking <> OLD.lot_marking
     OR NEW.evidence_document_version_ids <> OLD.evidence_document_version_ids OR NEW.warranty_claim <> OLD.warranty_claim
     OR NEW.requested_snapshot IS DISTINCT FROM OLD.requested_snapshot OR NEW.raised_by IS DISTINCT FROM OLD.raised_by THEN
    RAISE EXCEPTION 'a delivery exception is recorded as raised and resolved once';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_delivery_exception_resolves_once BEFORE UPDATE OR DELETE ON logistics.delivery_exception
  FOR EACH ROW EXECUTE FUNCTION logistics.exception_resolves_once();

CREATE TRIGGER trg_proof_of_delivery_immutable BEFORE UPDATE OR DELETE ON logistics.proof_of_delivery
  FOR EACH ROW EXECUTE FUNCTION logistics.forbid_rewrite();
CREATE TRIGGER trg_delivery_acceptance_immutable BEFORE UPDATE OR DELETE ON logistics.delivery_acceptance
  FOR EACH ROW EXECUTE FUNCTION logistics.forbid_rewrite();
CREATE TRIGGER trg_address_confirmation_immutable BEFORE UPDATE OR DELETE ON logistics.address_confirmation
  FOR EACH ROW EXECUTE FUNCTION logistics.forbid_rewrite();
CREATE TRIGGER trg_acceptance_policy_immutable BEFORE UPDATE OR DELETE ON logistics.acceptance_policy_version
  FOR EACH ROW EXECUTE FUNCTION logistics.forbid_rewrite();

INSERT INTO logistics.acceptance_policy_version (version, window_days, deemed_acceptance, warranty_statement, reason) VALUES
  (1, 7, true,
   'Accepting confirms the quantity and the visible condition of this delivery. It does not waive JobWork''s warranty: a defect found later is reported as a warranty claim under your order''s terms.',
   'IN-17 owner default: seven days from delivery to report a shortage, damage or nonconformance (D-20 open)');

-- ----------------------------------------------------------------- approvals

-- Approval kind `dispatch_override` (doc 03 §4): the owner of the hold decides, never logistics.
ALTER TABLE commercial.approval_policy DROP CONSTRAINT approval_policy_kind_check;
ALTER TABLE commercial.approval_policy ADD CONSTRAINT approval_policy_kind_check CHECK (kind IN ('award', 'cost_sheet', 'quote', 'allocation', 'change', 'deviation', 'dispatch_override'));
ALTER TABLE commercial.approval_request DROP CONSTRAINT approval_request_kind_check;
ALTER TABLE commercial.approval_request ADD CONSTRAINT approval_request_kind_check CHECK (kind IN ('award', 'cost_sheet', 'quote', 'allocation', 'change', 'deviation', 'dispatch_override'));
INSERT INTO commercial.approval_policy (kind, title, current_version_no) VALUES ('dispatch_override', 'Customer dispatch override', 1);
INSERT INTO commercial.approval_policy_version (policy_id, version_no, rules)
SELECT id, 1, '{"approverRolesByGuard":{"quality":["jobwork_quality"],"payment":["jobwork_finance"],"commitment":["jobwork_sales"],"holds":["jobwork_engineering"]}}'::jsonb
  FROM commercial.approval_policy WHERE kind = 'dispatch_override';

-- ----------------------------------------------------------------- queues and notifications

INSERT INTO platform.sla_policy_version (policy_key, version, calendar_key, target_minutes, escalation_steps, reason)
SELECT key, 1, 'chennai', minutes,
       jsonb_build_array(
         jsonb_build_object('step', 1, 'afterMinutes', minutes, 'notify', 'owner'),
         jsonb_build_object('step', 2, 'afterMinutes', minutes * 2, 'notify', 'escalation')),
       'IN-17 delivery targets'
  FROM (VALUES ('customer_dispatches_to_release', 240), ('deliveries_awaiting_pod', 1080), ('delivery_exceptions_open', 540)) AS t (key, minutes);

INSERT INTO platform.work_queue (key, label, owning_team, sla_policy_key) VALUES
  ('customer_dispatches_to_release', 'Customer dispatches to release', 'Logistics', 'customer_dispatches_to_release'),
  ('deliveries_awaiting_pod', 'Deliveries awaiting proof of delivery', 'Logistics', 'deliveries_awaiting_pod'),
  ('delivery_exceptions_open', 'Delivery exceptions', 'Support', 'delivery_exceptions_open');

INSERT INTO communication.template_version (template_key, version, channel, audience, subject, body, variables) VALUES
  ('customer.delivery_address_confirmation', 1, 'in_app', 'customer',
   'Confirm the delivery address for {{orderNumber}}',
   'JobWork is preparing {{shipmentNumber}} for order {{orderNumber}}. Confirm the delivery address and the receiving contact so it can leave.', ARRAY['orderNumber', 'shipmentNumber', 'link']),
  ('customer.delivery_address_confirmation', 1, 'email', 'customer',
   'Confirm the delivery address for {{orderNumber}}',
   E'JobWork is preparing {{shipmentNumber}} for order {{orderNumber}}. Confirm the delivery address and the receiving contact so it can leave:\n{{link}}', ARRAY['orderNumber', 'shipmentNumber', 'link']),
  ('customer.delivery_dispatched', 1, 'in_app', 'customer',
   '{{shipmentNumber}} is on the way',
   'Your delivery {{shipmentNumber}} for order {{orderNumber}} has left JobWork. Have receiving ready.', ARRAY['orderNumber', 'shipmentNumber', 'link']),
  ('customer.delivery_dispatched', 1, 'email', 'customer',
   '{{shipmentNumber}} is on the way',
   E'Your delivery {{shipmentNumber}} for order {{orderNumber}} has left JobWork. Tracking and the delivery note are here:\n{{link}}', ARRAY['orderNumber', 'shipmentNumber', 'link']),
  ('customer.delivery_confirmation_needed', 1, 'in_app', 'customer',
   'Confirm {{shipmentNumber}} by {{dueDate}}',
   'Delivery {{shipmentNumber}} for order {{orderNumber}} was handed over. Accept it, or report a shortage, damage or defect, by {{dueDate}}.', ARRAY['orderNumber', 'shipmentNumber', 'dueDate', 'link']),
  ('customer.delivery_confirmation_needed', 1, 'email', 'customer',
   'Confirm {{shipmentNumber}} by {{dueDate}}',
   E'Delivery {{shipmentNumber}} for order {{orderNumber}} was handed over. Accept it, or report a shortage, damage or defect with photos, by {{dueDate}}. After that date it is taken as accepted; your warranty is not affected:\n{{link}}', ARRAY['orderNumber', 'shipmentNumber', 'dueDate', 'link']),
  ('customer.delivery_deemed_accepted', 1, 'in_app', 'customer',
   '{{shipmentNumber}} taken as accepted',
   'No issue was reported for {{shipmentNumber}} on order {{orderNumber}} within the window, so it is taken as accepted. Your warranty is not affected.', ARRAY['orderNumber', 'shipmentNumber', 'link']),
  ('customer.delivery_deemed_accepted', 1, 'email', 'customer',
   '{{shipmentNumber}} taken as accepted',
   E'No issue was reported for {{shipmentNumber}} on order {{orderNumber}} within the window, so it is taken as accepted. A defect found later is still reported as a warranty claim:\n{{link}}', ARRAY['orderNumber', 'shipmentNumber', 'link']),
  ('internal.delivery_exception_opened', 1, 'in_app', 'internal',
   '{{exceptionNumber}}: {{exceptionLabel}} on {{shipmentNumber}}',
   'A delivery exception is open on {{shipmentNumber}}. Triage it from the logistics board.', ARRAY['exceptionNumber', 'exceptionLabel', 'shipmentNumber', 'link']),
  ('internal.delivery_exception_opened', 1, 'email', 'internal',
   '{{exceptionNumber}}: {{exceptionLabel}} on {{shipmentNumber}}',
   E'A delivery exception is open on {{shipmentNumber}}. Triage it here:\n{{link}}', ARRAY['exceptionNumber', 'exceptionLabel', 'shipmentNumber', 'link']);
