-- A supplier's bid-level charges reach the award and the purchase order (doc 10 §2, buy
-- side: tooling/NRE/setup and supplier-to-JobWork freight).
--
-- A bid prices freight to JobWork and tooling/NRE once, for the whole bid. They ride in
-- full on the first award line citing that bid (doc 07: direct attribution), so the cost
-- sheet's landed cost and the purchase order both carry what JobWork will actually pay.
-- Existing rows predate the rule and keep zero.

ALTER TABLE commercial.award_line
  ADD COLUMN freight_amount_minor bigint NOT NULL DEFAULT 0 CHECK (freight_amount_minor >= 0),
  ADD COLUMN nre_amount_minor bigint NOT NULL DEFAULT 0 CHECK (nre_amount_minor >= 0);

ALTER TABLE orders.purchase_order_line
  ADD COLUMN freight_amount_minor bigint NOT NULL DEFAULT 0 CHECK (freight_amount_minor >= 0),
  ADD COLUMN nre_amount_minor bigint NOT NULL DEFAULT 0 CHECK (nre_amount_minor >= 0);
