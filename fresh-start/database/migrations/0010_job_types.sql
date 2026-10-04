-- Job types (F-MX.1). Every enquiry says what kind of work it is, because the answer
-- changes what else is mandatory and, later, how material custody and GST paperwork run:
--
--   job_work        a treatment or process on goods the customer owns (CGST Act s.2(68));
--                   the customer is the principal and normally supplies the material.
--   new_model       a part not made for this customer before; material is sourced.
--   correction_ecn  a correction or engineering change to a part already enquired or
--                   ordered; carries the ECN reference and what changed.

ALTER TABLE sourcing.enquiry
  ADD COLUMN job_type text NOT NULL DEFAULT 'job_work'
    CHECK (job_type IN ('job_work', 'new_model', 'correction_ecn')),
  -- Who provides the raw material. The default follows the job type at draft time; the
  -- column stores the resolved answer so a frozen revision never has to re-derive it.
  ADD COLUMN material_supply text NOT NULL DEFAULT 'to_be_sourced'
    CHECK (material_supply IN ('customer_supplied', 'to_be_sourced')),
  -- Correction/ECN: the customer's own change reference and a description of the change.
  -- Mandatory at submit for that job type; enforced by the command, since a draft is
  -- allowed to be incomplete.
  ADD COLUMN change_reference text NOT NULL DEFAULT '',
  ADD COLUMN change_description text NOT NULL DEFAULT '',
  -- Correction/ECN: the enquiry being corrected. Optional (the original may predate the
  -- platform) but when present it must be the same customer's — checked by the command,
  -- because a cross-organization reference is a leak, not a constraint violation.
  ADD COLUMN related_enquiry_id uuid REFERENCES sourcing.enquiry (id);

CREATE INDEX idx_enquiry_related ON sourcing.enquiry (related_enquiry_id)
  WHERE related_enquiry_id IS NOT NULL;

ALTER TABLE sourcing.enquiry ADD CONSTRAINT chk_enquiry_not_self_related
  CHECK (related_enquiry_id IS NULL OR related_enquiry_id <> id);

/*
 * Capability families. The wizard asks Category → Sub category (prototype tile 5);
 * the family is data on the taxonomy, not a map in a client bundle, so a new process
 * lands in the right group by the same `D-21` governance that adds it.
 */
ALTER TABLE supplier.capability
  ADD COLUMN is_family boolean NOT NULL DEFAULT false;

INSERT INTO supplier.capability (code, kind, label, is_family) VALUES
  ('machining', 'process', 'CNC machining', true),
  ('sheet_metal', 'process', 'Sheet metal', true),
  ('fabrication', 'process', 'Fabrication', true),
  ('casting', 'process', 'Casting', true),
  ('forming', 'process', 'Forming', true),
  ('moulding', 'process', 'Moulding', true);

UPDATE supplier.capability c SET parent_id = f.id
  FROM supplier.capability f
 WHERE f.is_family AND c.kind = 'process' AND NOT c.is_family
   AND f.code = CASE c.code
     WHEN 'cnc_milling' THEN 'machining'
     WHEN 'cnc_turning' THEN 'machining'
     WHEN 'vmc_machining' THEN 'machining'
     WHEN 'sheet_metal_laser' THEN 'sheet_metal'
     WHEN 'sheet_metal_bending' THEN 'sheet_metal'
     WHEN 'fabrication_welding' THEN 'fabrication'
     WHEN 'casting_investment' THEN 'casting'
     WHEN 'casting_sand' THEN 'casting'
     WHEN 'forging' THEN 'forming'
     WHEN 'injection_moulding' THEN 'moulding'
   END;

-- A family is a grouping, never something a requirement or a declaration points at.
ALTER TABLE supplier.capability ADD CONSTRAINT chk_capability_family_is_root
  CHECK (NOT is_family OR parent_id IS NULL);
