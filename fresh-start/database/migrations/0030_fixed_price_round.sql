-- The fixed-price round (F-FP.2; FR-408; doc 06 §4). JobWork may offer a round at a price it sets
-- instead of asking for bids. Each line carries the offered unit price; a supplier accepts the
-- offer as offered (recorded as a bid version at exactly that price, so award, cost sheet, quote,
-- order and PO need no other path) or declines it. The first acceptance takes the offer: the round
-- moves to evaluation and every other open invitation closes as `offer_taken`.

ALTER TABLE sourcing.rfq
  ADD COLUMN pricing_mode text NOT NULL DEFAULT 'bid' CHECK (pricing_mode IN ('bid', 'fixed')),
  -- The payment terms the offer is made on; they reach the PO through the accepted bid version.
  ADD COLUMN offer_payment_terms text,
  ADD CONSTRAINT chk_rfq_offer_terms CHECK (
    (pricing_mode = 'fixed') = (offer_payment_terms IS NOT NULL AND char_length(offer_payment_terms) >= 3)
  );

ALTER TABLE sourcing.rfq_item
  ADD COLUMN offered_unit_price_minor bigint CHECK (offered_unit_price_minor > 0);

-- A fixed round's every line has an offer; a bid round's has none. The offer never changes once
-- written: a different price is a new round, never an edit under a supplier's feet.
CREATE FUNCTION sourcing.guard_rfq_item_offer() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  mode text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.offered_unit_price_minor IS DISTINCT FROM OLD.offered_unit_price_minor THEN
    RAISE EXCEPTION 'an offered price is fixed once written';
  END IF;
  SELECT pricing_mode INTO mode FROM sourcing.rfq WHERE id = NEW.rfq_id;
  IF (mode = 'fixed') <> (NEW.offered_unit_price_minor IS NOT NULL) THEN
    RAISE EXCEPTION 'a fixed-price round needs an offered price on every line, and a bid round none';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_rfq_item_offer
  BEFORE INSERT OR UPDATE ON sourcing.rfq_item
  FOR EACH ROW EXECUTE FUNCTION sourcing.guard_rfq_item_offer();

-- A bid on an offered line is the offer itself: exactly the offered price, no setup charge.
CREATE FUNCTION sourcing.guard_bid_line_offer() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  offered bigint;
BEGIN
  SELECT offered_unit_price_minor INTO offered FROM sourcing.rfq_item WHERE id = NEW.rfq_item_id;
  IF offered IS NOT NULL AND (NEW.unit_price_minor <> offered OR NEW.setup_amount_minor <> 0) THEN
    RAISE EXCEPTION 'a fixed-price line is accepted at the offered price only';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_bid_line_offer
  BEFORE INSERT ON sourcing.bid_line
  FOR EACH ROW EXECUTE FUNCTION sourcing.guard_bid_line_offer();

ALTER TABLE sourcing.rfq_supplier DROP CONSTRAINT rfq_supplier_status_check;
ALTER TABLE sourcing.rfq_supplier ADD CONSTRAINT rfq_supplier_status_check CHECK (status IN (
  'prepared', 'invited', 'acknowledged', 'clarifying', 'responded',
  'declined', 'no_response', 'revoked', 'offer_taken'
));
