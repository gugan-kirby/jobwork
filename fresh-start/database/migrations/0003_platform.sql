-- Platform spine: audit, outbox, idempotency, inbox (doc 05 §12, BR-SYS-01..07).

CREATE SCHEMA platform;

CREATE TABLE platform.audit_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'service', 'system')),
  actor_id uuid,
  organization_id uuid,
  action text NOT NULL,
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  subject_version integer,
  reason text,
  correlation_id text NOT NULL,
  causation_id text,
  data jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX idx_audit_subject ON platform.audit_event (subject_type, subject_id, occurred_at DESC);
CREATE INDEX idx_audit_actor ON platform.audit_event (actor_id, occurred_at DESC);
CREATE INDEX idx_audit_time ON platform.audit_event (occurred_at DESC, id);
CREATE INDEX idx_audit_correlation ON platform.audit_event (correlation_id);

-- Append-only enforcement independent of connection role (BR-SYS-05).
CREATE FUNCTION platform.forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'platform.% is append-only', TG_TABLE_NAME;
END $$;

CREATE TRIGGER trg_audit_append_only
  BEFORE UPDATE OR DELETE ON platform.audit_event
  FOR EACH ROW EXECUTE FUNCTION platform.forbid_mutation();

CREATE TABLE platform.outbox_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  aggregate_version integer,
  organization_id uuid,
  actor jsonb NOT NULL DEFAULT '{}'::jsonb,
  correlation_id text NOT NULL,
  causation_id text,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'delivered', 'dead')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  delivered_at timestamptz,
  last_error text
);

CREATE INDEX idx_outbox_due ON platform.outbox_event (next_attempt_at)
  WHERE status IN ('pending', 'processing');
CREATE INDEX idx_outbox_aggregate ON platform.outbox_event (aggregate_type, aggregate_id);

CREATE TABLE platform.idempotency_record (
  scope_type text NOT NULL CHECK (scope_type IN ('user', 'service')),
  scope_id uuid NOT NULL,
  operation text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  status text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed', 'failed')),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (scope_id, operation, idempotency_key)
);

CREATE TABLE platform.inbox_receipt (
  consumer text NOT NULL,
  event_id text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (consumer, event_id)
);
