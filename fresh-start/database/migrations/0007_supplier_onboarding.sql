-- Supplier onboarding: the identity a supplier states about itself, the works site it
-- makes from, and the network-membership state machine JobWork moves it through
-- (FR-105, doc 06 §14, doc 14 §5). Eligibility stays a computed projection over
-- verification items — nothing here stores it.

ALTER TABLE supplier.supplier_profile
  ADD COLUMN trade_name text NOT NULL DEFAULT '',
  ADD COLUMN website text NOT NULL DEFAULT '',
  ADD COLUMN year_established integer
    CHECK (year_established IS NULL OR year_established BETWEEN 1800 AND 2200),
  ADD COLUMN employee_band text
    CHECK (employee_band IS NULL OR employee_band IN
      ('1-10', '11-50', '51-200', '201-500', '500+')),
  ADD COLUMN primary_contact_name text NOT NULL DEFAULT '',
  ADD COLUMN primary_contact_email text NOT NULL DEFAULT '',
  ADD COLUMN primary_contact_phone text NOT NULL DEFAULT '',
  -- The works address is an organization site, not a second copy of an address: one
  -- table owns addresses (doc 05 §4), and a supplier's is never customer-facing.
  ADD COLUMN works_site_id uuid REFERENCES iam.organization_site (id),
  ADD COLUMN submitted_for_approval_at timestamptz,
  ADD COLUMN submitted_by uuid,
  ADD COLUMN decided_by uuid,
  ADD COLUMN decided_at timestamptz,
  ADD COLUMN decision_reason text;

-- `submitted` and `rejected` join the membership states. Eligibility is unaffected by
-- all of them except the exclusion of a non-active profile from matching.
ALTER TABLE supplier.supplier_profile DROP CONSTRAINT supplier_profile_status_check;
ALTER TABLE supplier.supplier_profile ADD CONSTRAINT supplier_profile_status_check
  CHECK (status IN ('onboarding', 'submitted', 'active', 'paused', 'rejected', 'exited'));

/*
 * A decision is a fact about people, so the row must name the decider — and never the
 * person who asked for the decision. Reviewer separation is a data rule here for the
 * same reason it is on verification_item: an application bug must not be able to let a
 * supplier admit itself.
 */
-- NOT VALID by intent, not by expedience: a profile admitted before this model existed
-- has no decider to name, and inventing one would be a worse lie than grandfathering it.
-- Postgres still enforces the check on every insert and update from here on, which is
-- exactly the invariant wanted — every *decision* names its decider.
ALTER TABLE supplier.supplier_profile ADD CONSTRAINT chk_supplier_decided CHECK (
  status NOT IN ('active', 'rejected')
  OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)
) NOT VALID;

ALTER TABLE supplier.supplier_profile ADD CONSTRAINT chk_supplier_self_decision CHECK (
  decided_by IS NULL OR submitted_by IS NULL OR decided_by <> submitted_by
);

-- A supplier makes parts somewhere it actually is: the works site must belong to the
-- same organization as the profile. A composite foreign key states that in the schema
-- rather than trusting every future writer to check it.
ALTER TABLE iam.organization_site
  ADD CONSTRAINT uq_organization_site_org UNIQUE (id, organization_id);

ALTER TABLE supplier.supplier_profile
  DROP CONSTRAINT supplier_profile_works_site_id_fkey,
  ADD CONSTRAINT fk_supplier_works_site
    FOREIGN KEY (works_site_id, organization_id)
    REFERENCES iam.organization_site (id, organization_id);

/*
 * Network membership (doc 14 §5):
 *
 *   onboarding -> submitted -> active            (approve)
 *   onboarding -> submitted -> onboarding        (return for changes)
 *              \-> rejected                      (reject; re-openable)
 *   active     -> paused -> active               (suspend / reinstate)
 *   any        -> exited                         (leaves the network)
 *
 * Admission and eligibility are deliberately separate: an active supplier with expired
 * evidence is still a member of the network and still excluded from matching.
 */
CREATE FUNCTION supplier.enforce_profile_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF NEW.status = 'exited'
     OR (OLD.status = 'onboarding' AND NEW.status IN ('submitted', 'rejected'))
     OR (OLD.status = 'submitted' AND NEW.status IN ('active', 'onboarding', 'rejected'))
     OR (OLD.status = 'active' AND NEW.status = 'paused')
     OR (OLD.status = 'paused' AND NEW.status = 'active')
     OR (OLD.status = 'rejected' AND NEW.status = 'onboarding') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid supplier profile transition: % -> %', OLD.status, NEW.status;
END $$;

CREATE TRIGGER trg_supplier_profile_transition
  BEFORE UPDATE OF status ON supplier.supplier_profile
  FOR EACH ROW EXECUTE FUNCTION supplier.enforce_profile_transition();

CREATE INDEX idx_supplier_profile_status ON supplier.supplier_profile (status);
