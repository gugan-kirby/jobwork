-- IN-13 F-13.1: close the uncontrolled-baseline path before change control arrives.
--
-- Until now a second production baseline could be released at any time and silently
-- supersede the first, even under work already in production (FR-604, BR-ENG-05). From
-- here a superseding baseline must name the change request that authorized it; the
-- change module (0021) adds the foreign key and the only command that sets it.

ALTER TABLE dms.baseline ADD COLUMN change_request_id uuid;
ALTER TABLE dms.baseline ADD CONSTRAINT chk_baseline_supersedes_by_change
  CHECK (supersedes_baseline_id IS NULL OR change_request_id IS NOT NULL);

-- Every baseline a work package worked to, in order (BR-ENG-04): its release snapshot
-- names the first; each acknowledged change adds the next. Append-only.
CREATE TABLE orders.work_package_baseline (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_package_id uuid NOT NULL REFERENCES orders.work_package (id),
  baseline_id uuid NOT NULL REFERENCES dms.baseline (id),
  transmittal_id uuid NOT NULL REFERENCES dms.transmittal (id),
  effective_from timestamptz NOT NULL DEFAULT now(),
  recorded_by uuid NOT NULL,
  UNIQUE (work_package_id, baseline_id)
);

CREATE TRIGGER trg_work_package_baseline_append_only
  BEFORE UPDATE OR DELETE ON orders.work_package_baseline
  FOR EACH ROW EXECUTE FUNCTION orders.forbid_append_only_rewrite();

INSERT INTO orders.work_package_baseline (work_package_id, baseline_id, transmittal_id, effective_from, recorded_by)
SELECT w.id,
       (w.release_snapshot -> 'baseline' ->> 'baselineId')::uuid,
       (w.release_snapshot -> 'transmittal' ->> 'transmittalId')::uuid,
       w.released_at,
       w.released_by
  FROM orders.work_package w
 WHERE w.released_at IS NOT NULL
   AND w.release_snapshot -> 'baseline' ->> 'baselineId' IS NOT NULL
   AND w.release_snapshot -> 'transmittal' ->> 'transmittalId' IS NOT NULL;
