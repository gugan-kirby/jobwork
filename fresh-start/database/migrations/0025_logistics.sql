-- Logistics leg 1, JobWork receiving and the custody ledger (IN-16 F-16.1; doc 06 §11; doc 10 §§10–15;
-- doc 05 §17; FR-901–FR-903; BR-LOG-01, BR-LOG-02, BR-LOG-04).
--
-- A shipment is one physical movement with one origin and one destination (BR-LOG-01); its
-- addresses are snapshots frozen at release (doc 10 §11). Carrier events are evidence, never the
-- receiving result. JobWork receiving is a structured custody event; what it takes in becomes stock
-- lots whose quantities move only by append-only movements. Every quantity received stays
-- accounted for across locations, and the database refuses any movement that draws more than a
-- location holds (BR-LOG-02: "fails at the constraint, not at an operator's attention").

CREATE SCHEMA logistics;

CREATE FUNCTION logistics.forbid_rewrite() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME;
END $$;

-- ----------------------------------------------------------------- shipments

CREATE TABLE logistics.shipment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  leg text NOT NULL CHECK (leg IN ('supplier_to_jobwork', 'jobwork_to_customer', 'customer_to_jobwork', 'jobwork_to_supplier')),
  sales_order_id uuid NOT NULL REFERENCES orders.sales_order (id),
  work_package_id uuid REFERENCES orders.work_package (id),
  purchase_order_id uuid REFERENCES orders.purchase_order (id),
  shipper_organization_id uuid NOT NULL REFERENCES iam.organization (id),
  consignee_organization_id uuid NOT NULL REFERENCES iam.organization (id),
  origin_site_id uuid REFERENCES iam.organization_site (id),
  destination_site_id uuid REFERENCES iam.organization_site (id),
  -- Contract snapshots (doc 10 §11): frozen at release; later profile edits never rewrite them.
  origin_snapshot jsonb,
  destination_snapshot jsonb,
  disclosure_class text NOT NULL DEFAULT 'internal' CHECK (disclosure_class IN ('internal', 'supplier_visible', 'customer_visible')),
  -- Challan, invoice and e-waybill references (doc 10 §11).
  documents jsonb NOT NULL DEFAULT '{}',
  carrier_mode text CHECK (carrier_mode IN ('carrier', 'supplier_vehicle', 'courier', 'jobwork_vehicle')),
  carrier_name text,
  tracking_reference text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft', 'planned', 'ready_for_release', 'released', 'picked_up', 'in_transit',
    'delivered_to_destination', 'receiving_check', 'accepted', 'discrepancy_hold', 'cancelled'
  )),
  release_snapshot jsonb,
  released_by uuid,
  released_at timestamptz,
  picked_up_at timestamptz,
  carrier_delivered_at timestamptz,
  created_by uuid NOT NULL,
  aggregate_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_shipment_released CHECK (status IN ('draft', 'planned', 'ready_for_release', 'cancelled')
    OR (released_at IS NOT NULL AND release_snapshot IS NOT NULL AND origin_snapshot IS NOT NULL AND destination_snapshot IS NOT NULL)),
  CONSTRAINT chk_shipment_picked_up CHECK (status IN ('draft', 'planned', 'ready_for_release', 'released', 'cancelled')
    OR (picked_up_at IS NOT NULL AND carrier_mode IS NOT NULL)),
  CONSTRAINT chk_shipment_two_parties CHECK (shipper_organization_id <> consignee_organization_id)
);

CREATE INDEX idx_shipment_order ON logistics.shipment (sales_order_id, created_at);
CREATE INDEX idx_shipment_work_package ON logistics.shipment (work_package_id);

-- Doc 06 §11, with cancellation before release. Snapshots freeze at release; carrier facts at pickup.
CREATE FUNCTION logistics.enforce_shipment_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.leg <> OLD.leg OR NEW.sales_order_id <> OLD.sales_order_id OR NEW.work_package_id IS DISTINCT FROM OLD.work_package_id
     OR NEW.shipper_organization_id <> OLD.shipper_organization_id OR NEW.consignee_organization_id <> OLD.consignee_organization_id THEN
    RAISE EXCEPTION 'a shipment keeps its leg and its parties';
  END IF;
  IF OLD.status NOT IN ('draft', 'planned', 'ready_for_release') AND (
       NEW.origin_snapshot IS DISTINCT FROM OLD.origin_snapshot OR NEW.destination_snapshot IS DISTINCT FROM OLD.destination_snapshot
       OR NEW.documents IS DISTINCT FROM OLD.documents OR NEW.release_snapshot IS DISTINCT FROM OLD.release_snapshot
       OR NEW.origin_site_id IS DISTINCT FROM OLD.origin_site_id OR NEW.destination_site_id IS DISTINCT FROM OLD.destination_site_id) THEN
    RAISE EXCEPTION 'a released shipment keeps its addresses, documents and release record';
  END IF;
  IF OLD.status NOT IN ('draft', 'planned', 'ready_for_release', 'released') AND (
       NEW.carrier_mode IS DISTINCT FROM OLD.carrier_mode OR NEW.carrier_name IS DISTINCT FROM OLD.carrier_name OR NEW.tracking_reference IS DISTINCT FROM OLD.tracking_reference) THEN
    RAISE EXCEPTION 'a picked-up shipment keeps its carrier';
  END IF;
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF (OLD.status = 'draft' AND NEW.status IN ('planned', 'cancelled'))
     OR (OLD.status = 'planned' AND NEW.status IN ('ready_for_release', 'cancelled'))
     OR (OLD.status = 'ready_for_release' AND NEW.status IN ('released', 'planned', 'cancelled'))
     OR (OLD.status = 'released' AND NEW.status = 'picked_up')
     OR (OLD.status = 'picked_up' AND NEW.status IN ('in_transit', 'delivered_to_destination', 'receiving_check'))
     OR (OLD.status = 'in_transit' AND NEW.status IN ('delivered_to_destination', 'receiving_check'))
     OR (OLD.status = 'delivered_to_destination' AND NEW.status = 'receiving_check')
     OR (OLD.status = 'receiving_check' AND NEW.status IN ('accepted', 'discrepancy_hold'))
     OR (OLD.status = 'discrepancy_hold' AND NEW.status = 'accepted')
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid shipment transition: % -> %', OLD.status, NEW.status;
END $$;

CREATE TRIGGER trg_shipment_transition BEFORE UPDATE ON logistics.shipment
  FOR EACH ROW EXECUTE FUNCTION logistics.enforce_shipment_transition();

CREATE TABLE logistics.shipment_package (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id uuid NOT NULL REFERENCES logistics.shipment (id),
  package_no integer NOT NULL CHECK (package_no > 0),
  length_mm integer CHECK (length_mm > 0),
  width_mm integer CHECK (width_mm > 0),
  height_mm integer CHECK (height_mm > 0),
  weight_g integer CHECK (weight_g > 0),
  note text NOT NULL DEFAULT '',
  UNIQUE (shipment_id, package_no)
);

CREATE TABLE logistics.shipment_item (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id uuid NOT NULL REFERENCES logistics.shipment (id),
  package_id uuid NOT NULL REFERENCES logistics.shipment_package (id),
  lot_code text NOT NULL DEFAULT '' CHECK (char_length(lot_code) <= 60),
  serials text[] NOT NULL DEFAULT '{}',
  quantity numeric(18, 4) NOT NULL CHECK (quantity > 0),
  unit text NOT NULL DEFAULT 'piece',
  -- The stock lot a JobWork-held item is picked from (legs that start at JobWork).
  stock_lot_id uuid,
  description text NOT NULL DEFAULT ''
);

CREATE INDEX idx_shipment_item_shipment ON logistics.shipment_item (shipment_id);

-- Packages and items change only while the shipment is being prepared.
CREATE FUNCTION logistics.contents_follow_shipment() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  s text;
BEGIN
  SELECT status INTO s FROM logistics.shipment WHERE id = COALESCE(NEW.shipment_id, OLD.shipment_id);
  IF s NOT IN ('draft', 'planned', 'ready_for_release') THEN
    RAISE EXCEPTION 'a released shipment keeps its packages and items';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER trg_shipment_package_frozen BEFORE INSERT OR UPDATE OR DELETE ON logistics.shipment_package
  FOR EACH ROW EXECUTE FUNCTION logistics.contents_follow_shipment();
CREATE TRIGGER trg_shipment_item_frozen BEFORE INSERT OR UPDATE OR DELETE ON logistics.shipment_item
  FOR EACH ROW EXECUTE FUNCTION logistics.contents_follow_shipment();

-- Carrier events are evidence (doc 06 §11; doc 08 §11): kept raw, normalized beside, never rewritten.
CREATE TABLE logistics.carrier_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id uuid NOT NULL REFERENCES logistics.shipment (id),
  provider text NOT NULL,
  provider_event_id text NOT NULL,
  raw_status text NOT NULL,
  normalized_status text NOT NULL CHECK (normalized_status IN ('picked_up', 'in_transit', 'out_for_delivery', 'delivered', 'exception')),
  occurred_at timestamptz NOT NULL,
  raw jsonb NOT NULL DEFAULT '{}',
  recorded_by uuid,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_event_id)
);

CREATE TRIGGER trg_carrier_event_immutable BEFORE UPDATE OR DELETE ON logistics.carrier_event
  FOR EACH ROW EXECUTE FUNCTION logistics.forbid_rewrite();

-- ----------------------------------------------------------------- receiving (doc 10 §13)

CREATE TABLE logistics.receiving_record (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id uuid NOT NULL UNIQUE REFERENCES logistics.shipment (id),
  received_by uuid NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  site_id uuid REFERENCES iam.organization_site (id),
  seal_intact boolean NOT NULL,
  packages_received integer NOT NULL CHECK (packages_received >= 0),
  -- [{"packageNo": 1, "condition": "ok" | "damaged" | "missing", "note": "…"}]
  package_conditions jsonb NOT NULL,
  photo_document_version_ids uuid[] NOT NULL DEFAULT '{}',
  decision text NOT NULL CHECK (decision IN ('accept', 'partial', 'quarantine', 'reject')),
  note text NOT NULL DEFAULT ''
);

CREATE TRIGGER trg_receiving_record_immutable BEFORE UPDATE OR DELETE ON logistics.receiving_record
  FOR EACH ROW EXECUTE FUNCTION logistics.forbid_rewrite();

-- Per shipped item: what was shipped, counted, and where each counted piece went.
CREATE TABLE logistics.receiving_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receiving_id uuid NOT NULL REFERENCES logistics.receiving_record (id),
  shipment_item_id uuid NOT NULL REFERENCES logistics.shipment_item (id),
  shipped_quantity numeric(18, 4) NOT NULL,
  counted_quantity numeric(18, 4) NOT NULL CHECK (counted_quantity >= 0),
  accepted_quantity numeric(18, 4) NOT NULL CHECK (accepted_quantity >= 0),
  quarantined_quantity numeric(18, 4) NOT NULL CHECK (quarantined_quantity >= 0),
  refused_quantity numeric(18, 4) NOT NULL CHECK (refused_quantity >= 0),
  identity_ok boolean NOT NULL,
  damaged boolean NOT NULL,
  note text NOT NULL DEFAULT '',
  UNIQUE (receiving_id, shipment_item_id),
  CONSTRAINT chk_receiving_line_split CHECK (accepted_quantity + quarantined_quantity + refused_quantity = counted_quantity)
);

CREATE TRIGGER trg_receiving_line_immutable BEFORE UPDATE OR DELETE ON logistics.receiving_line
  FOR EACH ROW EXECUTE FUNCTION logistics.forbid_rewrite();

-- BR-LOG-04: a hold and an exception, never a silent change to what was ordered or shipped.
CREATE TABLE logistics.receiving_discrepancy (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  shipment_id uuid NOT NULL REFERENCES logistics.shipment (id),
  receiving_id uuid NOT NULL REFERENCES logistics.receiving_record (id),
  kind text NOT NULL CHECK (kind IN ('shortage', 'overage', 'damage', 'wrong_item', 'document_mismatch', 'identity')),
  lot_code text NOT NULL DEFAULT '',
  quantity numeric(18, 4) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  description text NOT NULL CHECK (char_length(description) BETWEEN 3 AND 1000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolution text CHECK (resolution IN ('accept_shortage', 'replacement_expected', 'scrapped', 'released_to_stock', 'return_to_supplier', 'overage_accepted', 'document_corrected')),
  resolution_note text,
  -- Carrier claim or supplier case reference; IN-18 links the case itself.
  case_reference text NOT NULL DEFAULT '',
  resolved_by uuid,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_discrepancy_resolved CHECK (status = 'open' OR (resolution IS NOT NULL AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL AND char_length(coalesce(resolution_note, '')) >= 3))
);

CREATE FUNCTION logistics.discrepancy_resolves_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status <> 'open' OR NEW.shipment_id <> OLD.shipment_id OR NEW.kind <> OLD.kind
     OR NEW.quantity <> OLD.quantity OR NEW.lot_code <> OLD.lot_code OR NEW.description <> OLD.description THEN
    RAISE EXCEPTION 'a discrepancy is recorded as found and resolved once';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_discrepancy_resolves_once BEFORE UPDATE OR DELETE ON logistics.receiving_discrepancy
  FOR EACH ROW EXECUTE FUNCTION logistics.discrepancy_resolves_once();

-- ----------------------------------------------------------------- custody ledger (doc 05 §17)

-- JobWork's own locations, and the sinks quantities leave its custody into. Only a receipt
-- enters the ledger from outside; nothing ever leaves it, so what was received always equals the
-- sum of every location's balance: on hand + dispatched + scrapped + returned + in rework.
CREATE TABLE logistics.custody_location (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('jobwork_receiving', 'jobwork_quarantine', 'jobwork_stock', 'dispatched', 'scrapped', 'returned', 'in_rework', 'issued_to_supplier')),
  label text NOT NULL,
  on_hand boolean NOT NULL
);

INSERT INTO logistics.custody_location (code, kind, label, on_hand) VALUES
  ('JW-RECEIVING', 'jobwork_receiving', 'JobWork receiving dock', true),
  ('JW-QUARANTINE', 'jobwork_quarantine', 'JobWork quarantine', true),
  ('JW-STOCK', 'jobwork_stock', 'JobWork stock', true),
  ('OUT-DISPATCHED', 'dispatched', 'Dispatched to the customer', false),
  ('OUT-SCRAPPED', 'scrapped', 'Scrapped', false),
  ('OUT-RETURNED', 'returned', 'Returned to the supplier', false),
  ('OUT-REWORK', 'in_rework', 'Out for rework', false),
  ('OUT-ISSUED', 'issued_to_supplier', 'Issued to a supplier (customer material)', false);

CREATE TABLE logistics.stock_lot (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_code text NOT NULL,
  serials text[] NOT NULL DEFAULT '{}',
  sales_order_id uuid NOT NULL REFERENCES orders.sales_order (id),
  work_package_id uuid REFERENCES orders.work_package (id),
  baseline_id uuid REFERENCES dms.baseline (id),
  source_shipment_id uuid NOT NULL REFERENCES logistics.shipment (id),
  received_quantity numeric(18, 4) NOT NULL CHECK (received_quantity > 0),
  unit text NOT NULL DEFAULT 'piece',
  ownership text NOT NULL DEFAULT 'jobwork' CHECK (ownership IN ('jobwork', 'customer_material')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_shipment_id, lot_code)
);

CREATE TRIGGER trg_stock_lot_immutable BEFORE UPDATE OR DELETE ON logistics.stock_lot
  FOR EACH ROW EXECUTE FUNCTION logistics.forbid_rewrite();

ALTER TABLE logistics.shipment_item ADD CONSTRAINT fk_shipment_item_stock_lot FOREIGN KEY (stock_lot_id) REFERENCES logistics.stock_lot (id);

CREATE TABLE logistics.stock_movement (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id uuid NOT NULL REFERENCES logistics.stock_lot (id),
  from_location_id uuid REFERENCES logistics.custody_location (id),
  to_location_id uuid NOT NULL REFERENCES logistics.custody_location (id),
  quantity numeric(18, 4) NOT NULL CHECK (quantity > 0),
  type text NOT NULL CHECK (type IN ('receive', 'quarantine', 'release', 'pick', 'dispatch', 'return', 'scrap', 'rework_out', 'rework_in', 'adjust', 'issue')),
  operation text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}',
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_movement_receive_only_from_outside CHECK ((type = 'receive') = (from_location_id IS NULL)),
  CONSTRAINT chk_movement_moves CHECK (from_location_id IS NULL OR from_location_id <> to_location_id)
);

CREATE INDEX idx_stock_movement_lot ON logistics.stock_movement (lot_id, created_at);

CREATE VIEW logistics.stock_balance AS
SELECT lot_id, location_id, SUM(quantity) AS quantity
  FROM (
    SELECT lot_id, to_location_id AS location_id, quantity FROM logistics.stock_movement
    UNION ALL
    SELECT lot_id, from_location_id, -quantity FROM logistics.stock_movement WHERE from_location_id IS NOT NULL
  ) m
 GROUP BY lot_id, location_id;

-- BR-LOG-02 at the constraint: a movement may draw only what its from-location holds of the lot, and
-- a lot receives exactly its received quantity. The lot row is locked so two movements cannot
-- both draw the last pieces.
CREATE FUNCTION logistics.guard_movement() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  held numeric;
  received numeric;
  lot_received numeric;
BEGIN
  SELECT received_quantity INTO lot_received FROM logistics.stock_lot WHERE id = NEW.lot_id FOR UPDATE;
  IF NEW.from_location_id IS NULL THEN
    SELECT COALESCE(SUM(quantity), 0) INTO received FROM logistics.stock_movement WHERE lot_id = NEW.lot_id AND type = 'receive';
    IF received + NEW.quantity > lot_received THEN
      RAISE EXCEPTION 'lot over-received: % received of %, % more refused', received, lot_received, NEW.quantity;
    END IF;
    RETURN NEW;
  END IF;
  SELECT COALESCE(SUM(quantity), 0) INTO held FROM logistics.stock_balance WHERE lot_id = NEW.lot_id AND location_id = NEW.from_location_id;
  IF held < NEW.quantity THEN
    RAISE EXCEPTION 'over-draw refused: the location holds % of the lot, % requested', held, NEW.quantity;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_stock_movement_guard BEFORE INSERT ON logistics.stock_movement
  FOR EACH ROW EXECUTE FUNCTION logistics.guard_movement();
CREATE TRIGGER trg_stock_movement_immutable BEFORE UPDATE OR DELETE ON logistics.stock_movement
  FOR EACH ROW EXECUTE FUNCTION logistics.forbid_rewrite();

-- ----------------------------------------------------------------- queues and notifications

INSERT INTO platform.sla_policy_version (policy_key, version, calendar_key, target_minutes, escalation_steps, reason)
SELECT key, 1, 'chennai', minutes,
       jsonb_build_array(
         jsonb_build_object('step', 1, 'afterMinutes', minutes, 'notify', 'owner'),
         jsonb_build_object('step', 2, 'afterMinutes', minutes * 2, 'notify', 'escalation')),
       'IN-16 logistics targets'
  FROM (VALUES ('shipments_to_release', 240), ('shipments_awaiting_receiving', 540), ('receiving_discrepancies_open', 1080)) AS t (key, minutes);

INSERT INTO platform.work_queue (key, label, owning_team, sla_policy_key) VALUES
  ('shipments_to_release', 'Supplier shipments to release', 'Logistics', 'shipments_to_release'),
  ('shipments_awaiting_receiving', 'Shipments awaiting receiving', 'Logistics', 'shipments_awaiting_receiving'),
  ('receiving_discrepancies_open', 'Receiving discrepancies', 'Logistics', 'receiving_discrepancies_open');

INSERT INTO communication.template_version (template_key, version, channel, audience, subject, body, variables) VALUES
  ('supplier.shipment_released', 1, 'in_app', 'supplier',
   '{{shipmentNumber}} released for pickup',
   'JobWork has released {{shipmentNumber}} on {{purchaseOrderNumber}}. Hand it to the carrier and record the pickup.', ARRAY['shipmentNumber', 'purchaseOrderNumber', 'link']),
  ('supplier.shipment_released', 1, 'email', 'supplier',
   '{{shipmentNumber}} released for pickup',
   E'JobWork has released {{shipmentNumber}} on {{purchaseOrderNumber}}. Hand it to the carrier and record the pickup with its tracking reference:\n{{link}}', ARRAY['shipmentNumber', 'purchaseOrderNumber', 'link']),
  ('supplier.receiving_discrepancy', 1, 'in_app', 'supplier',
   '{{shipmentNumber}}: {{discrepancyLabel}} at receiving',
   'JobWork found {{discrepancyLabel}} when receiving {{shipmentNumber}}. The shipment is on hold until it is resolved.', ARRAY['shipmentNumber', 'discrepancyLabel', 'link']),
  ('supplier.receiving_discrepancy', 1, 'email', 'supplier',
   '{{shipmentNumber}}: {{discrepancyLabel}} at receiving',
   E'JobWork found {{discrepancyLabel}} when receiving {{shipmentNumber}}. The shipment is on hold until it is resolved. The details are here:\n{{link}}', ARRAY['shipmentNumber', 'discrepancyLabel', 'link']);
