-- The customer's target price (F-FP.1; FR-308). Optional, per item and per unit, in the enquiry's
-- currency. It is part of the frozen requirement revision, read by the customer and JobWork staff,
-- and never copied into a sourcing round: suppliers price against JobWork's offer, not the
-- customer's number. The platform quotes in INR today; the currency is carried so money is never
-- a bare number (doc 05).

ALTER TABLE sourcing.enquiry
  ADD COLUMN currency text NOT NULL DEFAULT 'INR' CHECK (char_length(currency) = 3);

ALTER TABLE sourcing.enquiry_item
  ADD COLUMN target_unit_price_minor bigint CHECK (target_unit_price_minor >= 0);
