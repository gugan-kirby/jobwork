-- The reviewed supplier copy (F-FP.5; FR-305). A customer's file is the customer's words: its title
-- block, its notes, its photos can name the company and the people behind it. A supplier receives
-- only JobWork's copy of it: a version JobWork owns, prepared by one JobWork member and confirmed by
-- another, mapped to exactly one customer version. The mapping is frozen once confirmed.
--
-- The rule is enforced where access is given, not where it is displayed: no grant may hand a
-- supplier organization a customer-owned version, however the application asks.

CREATE TABLE dms.supplier_copy (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_version_id uuid NOT NULL UNIQUE REFERENCES dms.document_version (id),
  copy_version_id uuid NOT NULL UNIQUE REFERENCES dms.document_version (id),
  prepared_by uuid NOT NULL,
  prepared_at timestamptz NOT NULL DEFAULT now(),
  note text NOT NULL DEFAULT '',
  confirmed_by uuid,
  confirmed_at timestamptz,
  confirm_note text,
  CONSTRAINT chk_supplier_copy_distinct CHECK (source_version_id <> copy_version_id),
  CONSTRAINT chk_supplier_copy_confirmed CHECK ((confirmed_by IS NULL) = (confirmed_at IS NULL)),
  -- Four eyes: the person who cleaned the file is never the one who says it is clean.
  CONSTRAINT chk_supplier_copy_four_eyes CHECK (confirmed_by IS NULL OR confirmed_by <> prepared_by)
);

CREATE FUNCTION dms.guard_supplier_copy() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  copy_owner text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.confirmed_at IS NOT NULL THEN
      RAISE EXCEPTION 'a confirmed supplier copy is kept';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.confirmed_at IS NOT NULL THEN
    RAISE EXCEPTION 'a confirmed supplier copy is kept';
  END IF;
  SELECT o.type INTO copy_owner
    FROM dms.document_version v JOIN dms.document d ON d.id = v.document_id JOIN iam.organization o ON o.id = d.owning_organization_id
   WHERE v.id = NEW.copy_version_id;
  IF copy_owner IS DISTINCT FROM 'internal' THEN
    RAISE EXCEPTION 'a supplier copy is a version JobWork owns';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_supplier_copy_guard
  BEFORE INSERT OR UPDATE OR DELETE ON dms.supplier_copy
  FOR EACH ROW EXECUTE FUNCTION dms.guard_supplier_copy();

CREATE FUNCTION dms.forbid_customer_version_to_supplier() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.audience_type = 'organization' AND NEW.revoked_at IS NULL
     AND (TG_OP = 'INSERT' OR OLD.revoked_at IS NOT NULL OR NEW.document_version_id <> OLD.document_version_id)
     AND EXISTS (SELECT 1 FROM iam.organization g WHERE g.id = NEW.organization_id AND g.type = 'supplier')
     AND EXISTS (SELECT 1 FROM dms.document_version v JOIN dms.document d ON d.id = v.document_id
                   JOIN iam.organization o ON o.id = d.owning_organization_id
                  WHERE v.id = NEW.document_version_id AND o.type = 'customer') THEN
    RAISE EXCEPTION 'a customer''s own file never reaches a supplier: grant its confirmed supplier copy';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_grant_no_customer_version_to_supplier
  BEFORE INSERT OR UPDATE ON dms.audience_grant
  FOR EACH ROW EXECUTE FUNCTION dms.forbid_customer_version_to_supplier();
