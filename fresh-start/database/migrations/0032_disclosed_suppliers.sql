-- Disclosed suppliers (ADR-0007): a customer quote names the supplier who will make the part, and
-- several suppliers may be quoted on one enquiry. JobWork stays the seller; cost, bids and margin
-- stay out of every customer projection.

ALTER TABLE commercial.customer_quote
  ADD COLUMN supplier_organization_id uuid REFERENCES iam.organization (id);

-- Quotes already raised name their supplier when their award has exactly one.
UPDATE commercial.customer_quote q
   SET supplier_organization_id = one.supplier_organization_id
  FROM (
    SELECT v.id AS cost_sheet_version_id, min(l.supplier_organization_id::text)::uuid AS supplier_organization_id
      FROM commercial.cost_sheet_version v
      JOIN commercial.cost_sheet s ON s.id = v.cost_sheet_id
      JOIN commercial.award_line l ON l.award_id = s.award_id
     GROUP BY v.id
    HAVING count(DISTINCT l.supplier_organization_id) = 1
  ) one
 WHERE one.cost_sheet_version_id = q.cost_sheet_version_id;

-- One option per supplier in an offer: Standard from two suppliers is two quotes.
ALTER TABLE commercial.customer_quote DROP CONSTRAINT customer_quote_offer_set_id_option_label_key;
CREATE UNIQUE INDEX uq_offer_set_option_supplier ON commercial.customer_quote
  (offer_set_id, option_label, COALESCE(supplier_organization_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- A rating is earned: one per delivered order, from the customer who received it.
CREATE TABLE supplier.rating (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_organization_id uuid NOT NULL REFERENCES iam.organization (id),
  customer_organization_id uuid NOT NULL REFERENCES iam.organization (id),
  sales_order_id uuid NOT NULL UNIQUE REFERENCES orders.sales_order (id),
  score smallint NOT NULL CHECK (score BETWEEN 1 AND 5),
  note text NOT NULL DEFAULT '',
  created_by uuid NOT NULL REFERENCES iam.user_account (id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_rating_supplier ON supplier.rating (supplier_organization_id);
