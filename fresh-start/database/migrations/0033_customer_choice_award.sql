-- ADR-0007 P2: an award can be an offer to the customer. Several may stand approved on one round,
-- one supplier each; the customer's acceptance settles which wins.
ALTER TABLE commercial.award ADD COLUMN customer_choice boolean NOT NULL DEFAULT false;

DROP INDEX commercial.uq_award_approved_per_rfq;
CREATE UNIQUE INDEX uq_award_approved_per_rfq ON commercial.award (rfq_id)
  WHERE status = 'approved' AND NOT customer_choice;
