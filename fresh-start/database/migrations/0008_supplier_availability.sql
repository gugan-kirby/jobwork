-- Availability is the supplier's own statement about the next few weeks; suspension is
-- JobWork's judgement about the supplier (F-SO). They exclude from matching the same way
-- and mean opposite things, so they are different columns — a shop that is simply full
-- must never be recorded as one JobWork stopped.

ALTER TABLE supplier.supplier_profile
  ADD COLUMN accepting_work boolean NOT NULL DEFAULT true,
  ADD COLUMN accepting_work_note text NOT NULL DEFAULT '',
  -- Optional "back on": a date the supplier expects to take work again. Nothing acts on
  -- it automatically — a date passing is not consent to be matched again.
  ADD COLUMN accepting_work_until date,
  ADD COLUMN exited_at timestamptz;

CREATE INDEX idx_supplier_profile_available
  ON supplier.supplier_profile (accepting_work)
  WHERE status = 'active';

/*
 * `exited` is terminal: the profile keeps everything it ever declared, and nothing new
 * can be published against it. The timestamp records when, so an award made while the
 * supplier was in the network still reads correctly years later.
 */
ALTER TABLE supplier.supplier_profile ADD CONSTRAINT chk_supplier_exited CHECK (
  (status = 'exited') = (exited_at IS NOT NULL)
) NOT VALID;
