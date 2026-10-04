-- A result keeps the unit as it was entered, even one no conversion version defines (IN-14
-- F-14.3; doc 07 §14; doc 19 §6). Such a result is recorded as "cannot evaluate" with the
-- original kept, so the unit cannot be a foreign key to the known units: it is checked for
-- shape instead. The normalized unit, always a known one, stays a foreign key.

ALTER TABLE quality.inspection_result DROP CONSTRAINT inspection_result_original_unit_fkey;
ALTER TABLE quality.inspection_result ADD CONSTRAINT chk_result_original_unit
  CHECK (original_unit IS NULL OR original_unit ~ '^[A-Za-z_]{1,16}$');
