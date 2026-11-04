-- ADR-0007 P5: a customer and the supplier named on their order can write to each other. The
-- customer stays "Customer" to the supplier, JobWork can read everything, and the leakage gate
-- still holds contact details for review.
ALTER TABLE communication.message DROP CONSTRAINT message_audience_check;
ALTER TABLE communication.message ADD CONSTRAINT message_audience_check
  CHECK (audience IN ('internal', 'customer', 'supplier', 'shared_technical', 'customer_supplier'));
