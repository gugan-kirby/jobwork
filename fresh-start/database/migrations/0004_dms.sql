-- Document core: immutable file objects, logical documents, versions, audience grants,
-- upload sessions (doc 05 §7, FR-600 subset).

CREATE SCHEMA dms;

CREATE TABLE dms.file_object (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_key text NOT NULL UNIQUE,
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  declared_media_type text NOT NULL,
  detected_media_type text,
  sha256 text NOT NULL,
  scan_state text NOT NULL DEFAULT 'quarantined'
    CHECK (scan_state IN ('quarantined', 'scanning', 'clean', 'infected', 'unsupported', 'failed')),
  scan_detail text,
  owning_organization_id uuid NOT NULL REFERENCES iam.organization (id),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Byte identity is per-organization: dedupe must never merge access across tenants (doc 05 §7).
CREATE UNIQUE INDEX uq_file_sha_org ON dms.file_object (owning_organization_id, sha256);

CREATE TABLE dms.document (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owning_organization_id uuid NOT NULL REFERENCES iam.organization (id),
  logical_type text NOT NULL CHECK (logical_type IN
    ('cad_3d', 'drawing_2d', 'bom', 'specification', 'image', 'certificate', 'other')),
  title text NOT NULL,
  classification text NOT NULL DEFAULT 'confidential'
    CHECK (classification IN ('public', 'internal', 'confidential', 'restricted')),
  retention_class text NOT NULL DEFAULT 'standard',
  current_version_no integer NOT NULL DEFAULT 0,
  aggregate_version integer NOT NULL DEFAULT 1,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_document_org ON dms.document (owning_organization_id, created_at DESC);

CREATE TABLE dms.document_version (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES dms.document (id),
  version_no integer NOT NULL,
  file_object_id uuid NOT NULL REFERENCES dms.file_object (id),
  engineering_revision text,
  original_filename text NOT NULL,
  status text NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing', 'available', 'quarantined', 'revoked')),
  supersedes_version_id uuid REFERENCES dms.document_version (id),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, version_no)
);

CREATE TABLE dms.audience_grant (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_version_id uuid NOT NULL REFERENCES dms.document_version (id),
  audience_type text NOT NULL CHECK (audience_type IN
    ('internal', 'organization', 'auditor')),
  organization_id uuid REFERENCES iam.organization (id),
  actions text[] NOT NULL DEFAULT '{view,download}',
  granted_by uuid,
  valid_until timestamptz,
  revoked_at timestamptz,
  revoked_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_grant_org CHECK (
    (audience_type = 'organization') = (organization_id IS NOT NULL)
  )
);

CREATE INDEX idx_grant_version ON dms.audience_grant (document_version_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_grant_org ON dms.audience_grant (organization_id) WHERE revoked_at IS NULL;

CREATE TABLE dms.upload_session (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES iam.organization (id),
  created_by uuid NOT NULL,
  purpose text NOT NULL,
  declared_filename text NOT NULL,
  declared_media_type text NOT NULL,
  declared_byte_size bigint NOT NULL,
  storage_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'initiated'
    CHECK (status IN ('initiated', 'finalized', 'expired', 'aborted')),
  document_id uuid REFERENCES dms.document (id),
  document_version_id uuid REFERENCES dms.document_version (id),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Scan lifecycle is a one-way machine (doc 09 §4): quarantined → scanning → verdict.
-- clean/infected/unsupported are terminal; failed may retry to scanning. Fail closed.
CREATE FUNCTION dms.enforce_scan_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.scan_state = OLD.scan_state THEN
    RETURN NEW;
  END IF;
  IF (OLD.scan_state = 'quarantined' AND NEW.scan_state = 'scanning')
     OR (OLD.scan_state = 'scanning' AND NEW.scan_state IN ('clean', 'infected', 'unsupported', 'failed'))
     OR (OLD.scan_state = 'failed' AND NEW.scan_state = 'scanning') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid scan_state transition: % -> %', OLD.scan_state, NEW.scan_state;
END $$;

CREATE TRIGGER trg_file_scan_transition
  BEFORE UPDATE OF scan_state ON dms.file_object
  FOR EACH ROW EXECUTE FUNCTION dms.enforce_scan_transition();

-- Download access log: downloads before revocation are permanent facts (doc 19 §3).
CREATE TABLE dms.access_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_version_id uuid NOT NULL REFERENCES dms.document_version (id),
  actor_id uuid NOT NULL,
  organization_id uuid,
  action text NOT NULL CHECK (action IN ('preview', 'download')),
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_access_log_append_only
  BEFORE UPDATE OR DELETE ON dms.access_log
  FOR EACH ROW EXECUTE FUNCTION platform.forbid_mutation();
