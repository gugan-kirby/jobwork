-- Work queues, SLA policies and the business calendar (IN-11 F-11.1; doc 07 §11;
-- doc 05 §4 platform row; BR-SYS-07; UC-35, UC-38).
--
-- What is in a queue stays a question asked of each module's own tables (the F-OPS
-- summary filters): an enquiry is awaiting triage because its status says so, not because
-- a queue row says so. The queue owns only what nobody else does — who has picked an item
-- up, when it is due, and how far it has been escalated. A deadline is an instant plus the
-- calendar and policy versions it was computed from, so it can always be explained.

-- ------------------------------------------------------------------ business calendar

-- A calendar version is what deadlines were computed against, so it never changes once
-- written; a new holiday is a new version. Activating a version retires the previous one.
CREATE TABLE platform.business_calendar_version (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  calendar_key text NOT NULL CHECK (calendar_key ~ '^[a-z][a-z0-9_]{1,40}$'),
  version integer NOT NULL CHECK (version > 0),
  time_zone text NOT NULL,
  -- ISO weekday numbers: 1 = Monday … 7 = Sunday.
  working_days smallint[] NOT NULL CHECK (cardinality(working_days) BETWEEN 1 AND 7 AND working_days <@ ARRAY[1, 2, 3, 4, 5, 6, 7]::smallint[]),
  day_start time NOT NULL,
  day_end time NOT NULL,
  holidays date[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 500),
  activated_by uuid REFERENCES iam.user_account (id),
  activated_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  UNIQUE (calendar_key, version),
  CONSTRAINT chk_calendar_hours CHECK (day_end > day_start),
  CONSTRAINT chk_calendar_retired CHECK ((status = 'retired') = (retired_at IS NOT NULL))
);
CREATE UNIQUE INDEX uq_calendar_active ON platform.business_calendar_version (calendar_key) WHERE status = 'active';

-- An unknown zone name would make every deadline silently UTC; refuse it at the door.
CREATE FUNCTION platform.check_calendar_zone() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM now() AT TIME ZONE NEW.time_zone;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_calendar_zone
  BEFORE INSERT ON platform.business_calendar_version
  FOR EACH ROW EXECUTE FUNCTION platform.check_calendar_zone();

-- Versions of configuration may only retire; their content is history.
CREATE FUNCTION platform.forbid_version_rewrite() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'platform.% versions are never deleted', TG_TABLE_NAME;
  END IF;
  IF OLD.status = 'active' AND NEW.status = 'retired'
     AND (to_jsonb(NEW) - 'status' - 'retired_at') = (to_jsonb(OLD) - 'status' - 'retired_at') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'platform.% versions are immutable; publish a new version instead', TG_TABLE_NAME;
END $$;

CREATE TRIGGER trg_calendar_version_immutable
  BEFORE UPDATE OR DELETE ON platform.business_calendar_version
  FOR EACH ROW EXECUTE FUNCTION platform.forbid_version_rewrite();

-- ------------------------------------------------------------------ SLA policy

-- `target_minutes` is the due time in working minutes from when the item started
-- waiting; `escalation_steps` are [{step, afterMinutes, notify: owner|escalation}] in
-- the same working minutes. A running item keeps the policy version it opened under.
CREATE TABLE platform.sla_policy_version (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_key text NOT NULL CHECK (policy_key ~ '^[a-z][a-z0-9_]{1,60}$'),
  version integer NOT NULL CHECK (version > 0),
  calendar_key text NOT NULL,
  target_minutes integer NOT NULL CHECK (target_minutes > 0),
  escalation_steps jsonb NOT NULL CHECK (jsonb_typeof(escalation_steps) = 'array' AND jsonb_array_length(escalation_steps) BETWEEN 1 AND 5),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 500),
  activated_by uuid REFERENCES iam.user_account (id),
  activated_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  UNIQUE (policy_key, version),
  CONSTRAINT chk_policy_retired CHECK ((status = 'retired') = (retired_at IS NOT NULL))
);
CREATE UNIQUE INDEX uq_policy_active ON platform.sla_policy_version (policy_key) WHERE status = 'active';

CREATE TRIGGER trg_policy_version_immutable
  BEFORE UPDATE OR DELETE ON platform.sla_policy_version
  FOR EACH ROW EXECUTE FUNCTION platform.forbid_version_rewrite();

-- ------------------------------------------------------------------ queues

-- Membership and who may act are code (`operations/domain/queues.ts`, test-matched to
-- these rows); this row is the configuration an operations lead changes: the owning team,
-- the SLA policy, and who hears about an item that is twice past due.
CREATE TABLE platform.work_queue (
  key text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{1,60}$'),
  label text NOT NULL,
  owning_team text NOT NULL,
  -- NULL: a watch list (nothing is "due"), e.g. invitations, which expire on their own.
  sla_policy_key text,
  escalation_roles text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One subject's stay in one queue. A subject that leaves and comes back is a new stay
-- with a new clock; the old one stays closed as the record of the first.
CREATE TABLE platform.queue_assignment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_key text NOT NULL REFERENCES platform.work_queue (key),
  subject_type text NOT NULL,
  subject_id uuid NOT NULL,
  -- A record number, or a neutral word where the record has none: it goes into
  -- notifications, so never a name, an amount or an address.
  reference text NOT NULL,
  waiting_since timestamptz NOT NULL,
  clock_started_at timestamptz NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  policy_version_id uuid REFERENCES platform.sla_policy_version (id),
  calendar_version_id uuid REFERENCES platform.business_calendar_version (id),
  -- BR-SYS-07: the declared zone the deadline's working hours were read in.
  time_zone text,
  due_at timestamptz,
  due_version integer NOT NULL DEFAULT 1 CHECK (due_version > 0),
  escalation_level integer NOT NULL DEFAULT 0 CHECK (escalation_level >= 0),
  next_escalation_at timestamptz,
  assignee_user_id uuid REFERENCES iam.user_account (id),
  assigned_at timestamptz,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  closed_at timestamptz,
  aggregate_version integer NOT NULL DEFAULT 1,
  CONSTRAINT chk_assignment_closed CHECK ((status = 'closed') = (closed_at IS NOT NULL)),
  CONSTRAINT chk_assignment_deadline CHECK (
    (policy_version_id IS NULL AND due_at IS NULL AND calendar_version_id IS NULL)
    OR (policy_version_id IS NOT NULL AND due_at IS NOT NULL AND calendar_version_id IS NOT NULL AND time_zone IS NOT NULL)
  ),
  CONSTRAINT chk_assignment_assigned CHECK ((assignee_user_id IS NULL) = (assigned_at IS NULL))
);
CREATE UNIQUE INDEX uq_assignment_open ON platform.queue_assignment (queue_key, subject_id) WHERE status = 'open';
CREATE INDEX idx_assignment_next_escalation ON platform.queue_assignment (next_escalation_at)
  WHERE status = 'open' AND next_escalation_at IS NOT NULL;
CREATE INDEX idx_assignment_subject ON platform.queue_assignment (subject_id, queue_key);
CREATE INDEX idx_assignment_assignee ON platform.queue_assignment (assignee_user_id) WHERE status = 'open';

-- What a stay is about never changes, and a closed stay is history.
CREATE FUNCTION platform.guard_queue_assignment() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'queue assignments are never deleted';
  END IF;
  IF OLD.status = 'closed' THEN
    RAISE EXCEPTION 'a closed queue assignment is history';
  END IF;
  IF NEW.queue_key <> OLD.queue_key OR NEW.subject_type <> OLD.subject_type OR NEW.subject_id <> OLD.subject_id
     OR NEW.waiting_since <> OLD.waiting_since OR NEW.clock_started_at <> OLD.clock_started_at
     OR NEW.opened_at <> OLD.opened_at OR NEW.policy_version_id IS DISTINCT FROM OLD.policy_version_id THEN
    RAISE EXCEPTION 'a queue assignment keeps its subject, clock and policy';
  END IF;
  IF NEW.due_version < OLD.due_version THEN
    RAISE EXCEPTION 'due_version only moves forward';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_queue_assignment_guard
  BEFORE UPDATE OR DELETE ON platform.queue_assignment
  FOR EACH ROW EXECUTE FUNCTION platform.guard_queue_assignment();

-- Escalation fires once per step per deadline (doc 07 §11): the key is the guarantee,
-- whatever number of sweeps race for it.
CREATE TABLE platform.sla_escalation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_assignment_id uuid NOT NULL REFERENCES platform.queue_assignment (id),
  step integer NOT NULL CHECK (step > 0),
  due_version integer NOT NULL CHECK (due_version > 0),
  notify text NOT NULL CHECK (notify IN ('owner', 'escalation')),
  fired_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (queue_assignment_id, step, due_version)
);

CREATE TRIGGER trg_sla_escalation_append_only
  BEFORE UPDATE OR DELETE ON platform.sla_escalation
  FOR EACH ROW EXECUTE FUNCTION platform.forbid_mutation();

-- ------------------------------------------------------------------ seeds

-- Chennai, Monday to Saturday, 09:30–18:30 India time. Only fixed-date holidays are
-- seeded; festival dates that move each year are added by operations as a new version.
INSERT INTO platform.business_calendar_version
  (calendar_key, version, time_zone, working_days, day_start, day_end, holidays, reason)
VALUES
  ('chennai', 1, 'Asia/Kolkata', ARRAY[1, 2, 3, 4, 5, 6]::smallint[], '09:30', '18:30',
   ARRAY['2026-01-26', '2026-05-01', '2026-08-15', '2026-10-02', '2026-12-25',
         '2027-01-26', '2027-05-01', '2027-08-15', '2027-10-02', '2027-12-25']::date[],
   'Launch calendar: Chennai working week and fixed-date public holidays');

-- One working day is 540 minutes. Step 1 is the due time and tells the owner (or the
-- team while nobody owns it); step 2, at twice the target, tells the whole team.
INSERT INTO platform.sla_policy_version (policy_key, version, calendar_key, target_minutes, escalation_steps, reason)
SELECT key, 1, 'chennai', minutes,
       jsonb_build_array(
         jsonb_build_object('step', 1, 'afterMinutes', minutes, 'notify', 'owner'),
         jsonb_build_object('step', 2, 'afterMinutes', minutes * 2, 'notify', 'escalation')),
       'Launch service targets'
  FROM (VALUES
    ('enquiries_awaiting_triage', 540),
    ('clarifications_awaiting_customer', 1080),
    ('supplier_files_awaiting_decision', 1080),
    ('supplier_applications_received', 1620),
    ('supplier_evidence_awaiting_review', 540),
    ('rfqs_in_evaluation', 540),
    ('approvals_pending', 240),
    ('orders_awaiting_release', 1080),
    ('purchase_orders_to_issue', 540),
    ('payments_unmatched', 540),
    ('baselines_to_release', 1080),
    ('work_packages_to_release', 540),
    ('milestones_to_verify', 540),
    ('leakage_reviews_open', 120)
  ) AS targets (key, minutes);

INSERT INTO platform.work_queue (key, label, owning_team, sla_policy_key) VALUES
  ('enquiries_awaiting_triage', 'Enquiries awaiting triage', 'Sourcing', 'enquiries_awaiting_triage'),
  ('clarifications_awaiting_customer', 'Clarifications with the customer', 'Sourcing', 'clarifications_awaiting_customer'),
  ('supplier_files_awaiting_decision', 'Supplier files awaiting a decision', 'Sourcing', 'supplier_files_awaiting_decision'),
  ('supplier_applications_received', 'Workshops asking to join', 'Sourcing', 'supplier_applications_received'),
  ('supplier_evidence_awaiting_review', 'Evidence awaiting review', 'Sourcing', 'supplier_evidence_awaiting_review'),
  ('suppliers_unmatchable', 'Admitted suppliers not matchable', 'Sourcing', NULL),
  ('rfqs_in_evaluation', 'Rounds to evaluate', 'Sourcing', 'rfqs_in_evaluation'),
  ('approvals_pending', 'Approvals waiting', 'Commercial', 'approvals_pending'),
  ('orders_awaiting_release', 'Orders waiting on payment or credit', 'Finance', 'orders_awaiting_release'),
  ('purchase_orders_to_issue', 'Purchase orders to issue', 'Sourcing', 'purchase_orders_to_issue'),
  ('payments_unmatched', 'Receipts in suspense', 'Finance', 'payments_unmatched'),
  ('baselines_to_release', 'Baselines to release', 'Engineering', 'baselines_to_release'),
  ('work_packages_to_release', 'Work packages waiting for release', 'Sourcing', 'work_packages_to_release'),
  ('milestones_to_verify', 'Milestone evidence to verify', 'Quality', 'milestones_to_verify'),
  ('leakage_reviews_open', 'Messages held for review', 'Support', 'leakage_reviews_open'),
  ('invitations_pending', 'Invitations not yet accepted', 'Platform', NULL);

-- Notifications for the sweep and for a hand-over (F-10.3 pipeline; allowlisted).
INSERT INTO communication.template_version (template_key, version, channel, audience, subject, body, variables) VALUES
  ('internal.sla_due', 1, 'in_app', 'internal',
   '{{reference}} is due — {{queueLabel}}',
   'It has reached its service target. Act on it or hand it on.', ARRAY['reference', 'queueLabel', 'link']),
  ('internal.sla_due', 1, 'email', 'internal',
   '{{reference}} is due — {{queueLabel}}',
   E'An item in {{queueLabel}} ({{reference}}) has reached its service target.\n\nOpen the queue to act on it or hand it on:\n{{link}}', ARRAY['reference', 'queueLabel', 'link']),

  ('internal.sla_escalated', 1, 'in_app', 'internal',
   '{{reference}} is overdue — {{queueLabel}}',
   'It is twice past its service target and has been raised with the team.', ARRAY['reference', 'queueLabel', 'link']),
  ('internal.sla_escalated', 1, 'email', 'internal',
   '{{reference}} is overdue — {{queueLabel}}',
   E'An item in {{queueLabel}} ({{reference}}) is twice past its service target, so the whole team is being told.\n\nOpen the queue:\n{{link}}', ARRAY['reference', 'queueLabel', 'link']),

  ('internal.queue_item_assigned', 1, 'in_app', 'internal',
   '{{reference}} was handed to you — {{queueLabel}}',
   'A colleague assigned it to you.', ARRAY['reference', 'queueLabel', 'link']),
  ('internal.queue_item_assigned', 1, 'email', 'internal',
   '{{reference}} was handed to you — {{queueLabel}}',
   E'A colleague assigned an item in {{queueLabel}} ({{reference}}) to you.\n\nOpen the queue:\n{{link}}', ARRAY['reference', 'queueLabel', 'link']);
