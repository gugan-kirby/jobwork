-- Requirement revision after bids (IN-12 F-12.5; doc 19 §10 scenario 5; doc 19 §3).
--
-- Engineering may revise a reviewed requirement while it is still being sourced. The
-- revision is a new frozen requirement row (revisions are immutable); every round still
-- live on the old revision becomes `superseded` and names the revision that replaced
-- it. Bids on a superseded round are kept exactly as submitted and can never be awarded:
-- they priced a part that is no longer the part.

ALTER TABLE sourcing.requirement ADD COLUMN revision_reason text
  CHECK (revision_reason IS NULL OR char_length(revision_reason) BETWEEN 3 AND 1000);

ALTER TABLE sourcing.rfq DROP CONSTRAINT rfq_status_check;
ALTER TABLE sourcing.rfq ADD CONSTRAINT rfq_status_check CHECK (status IN (
  'draft', 'internal_review', 'open', 'responses_received',
  'evaluation', 'awarded', 'no_bid', 'expired', 'cancelled', 'superseded'
));

ALTER TABLE sourcing.rfq ADD COLUMN superseded_by_requirement_id uuid REFERENCES sourcing.requirement (id);
-- A round still in draft can be superseded before it was ever released.
ALTER TABLE sourcing.rfq DROP CONSTRAINT chk_rfq_released;
ALTER TABLE sourcing.rfq ADD CONSTRAINT chk_rfq_released CHECK (
  status IN ('draft', 'internal_review', 'cancelled', 'superseded') OR released_at IS NOT NULL
);
ALTER TABLE sourcing.rfq ADD CONSTRAINT chk_rfq_superseded
  CHECK ((status = 'superseded') = (superseded_by_requirement_id IS NOT NULL));

-- Superseding is reachable from every state in which the round is still live; a round
-- that has been awarded, closed with no bid, expired or cancelled is history.
CREATE OR REPLACE FUNCTION sourcing.enforce_rfq_transition() RETURNS trigger
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
     OR (NEW.status = 'superseded' AND OLD.status IN ('draft', 'internal_review', 'open', 'responses_received', 'evaluation'))
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid rfq transition: % -> %', OLD.status, NEW.status;
END $$;

-- Suppliers who bid on a superseded round are told it closed for a revision (F-10.3 pipeline).
INSERT INTO communication.template_version (template_key, version, channel, audience, subject, body, variables) VALUES
  ('supplier.rfq_superseded', 1, 'in_app', 'supplier',
   '{{rfqReference}} closed: requirements updated',
   'The requirement changed after bids came in. Your bid is kept as submitted; JobWork will invite you to the new round.', ARRAY['rfqReference', 'link']),
  ('supplier.rfq_superseded', 1, 'email', 'supplier',
   '{{rfqReference}} closed: requirements updated',
   E'The requirement behind {{rfqReference}} changed after bids came in, so the round is closed. Your bid is kept exactly as you submitted it.\n\nJobWork will invite you to the new round if your capabilities still match:\n{{link}}', ARRAY['rfqReference', 'link']);
