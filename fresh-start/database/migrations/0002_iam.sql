-- IAM: organizations, users, memberships, roles, sessions, invitations (doc 05 §4 iam schema).
-- created_by columns are soft references (no FK) to avoid org<->user bootstrap circularity;
-- application code always populates them from the acting session.

CREATE SCHEMA iam;

CREATE TABLE iam.organization (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL CHECK (type IN ('customer', 'supplier', 'internal')),
  legal_name text NOT NULL,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deactivated')),
  aggregate_version integer NOT NULL DEFAULT 1,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE iam.user_account (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext NOT NULL UNIQUE,
  password_hash text,
  password_params_version integer,
  status text NOT NULL DEFAULT 'pending_verification'
    CHECK (status IN ('pending_verification', 'active', 'suspended', 'deactivated')),
  display_name text NOT NULL DEFAULT '',
  email_verified_at timestamptz,
  failed_login_count integer NOT NULL DEFAULT 0,
  lockout_until timestamptz,
  mfa_totp_secret text,
  mfa_enrolled_at timestamptz,
  aggregate_version integer NOT NULL DEFAULT 1,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE iam.membership (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES iam.user_account (id),
  organization_id uuid NOT NULL REFERENCES iam.organization (id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'ended')),
  aggregate_version integer NOT NULL DEFAULT 1,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One live membership per user+organization; ended memberships remain as history.
CREATE UNIQUE INDEX uq_membership_live
  ON iam.membership (user_id, organization_id)
  WHERE status <> 'ended';
CREATE INDEX idx_membership_org ON iam.membership (organization_id, status);
CREATE INDEX idx_membership_user ON iam.membership (user_id, status);

CREATE TABLE iam.role (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  title text NOT NULL,
  org_type_scope text NOT NULL CHECK (org_type_scope IN ('customer', 'supplier', 'internal', 'any')),
  description text NOT NULL DEFAULT ''
);

CREATE TABLE iam.membership_role (
  membership_id uuid NOT NULL REFERENCES iam.membership (id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES iam.role (id),
  granted_by uuid,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (membership_id, role_id)
);

CREATE TABLE iam.approval_limit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  membership_id uuid NOT NULL REFERENCES iam.membership (id) ON DELETE CASCADE,
  limit_type text NOT NULL,
  amount_minor bigint NOT NULL,
  currency char(3) NOT NULL,
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE iam.session (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES iam.user_account (id),
  organization_id uuid REFERENCES iam.organization (id),
  auth_strength text NOT NULL DEFAULT 'password' CHECK (auth_strength IN ('password', 'password+totp')),
  mfa_pending boolean NOT NULL DEFAULT false,
  authenticated_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_reason text,
  ip text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_session_user_active ON iam.session (user_id) WHERE revoked_at IS NULL;

CREATE TABLE iam.invitation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES iam.organization (id),
  email citext NOT NULL,
  proposed_role_keys text[] NOT NULL,
  token_hash text NOT NULL UNIQUE,
  invited_by uuid,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  consumed_by uuid,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_invitation_org ON iam.invitation (organization_id, created_at DESC);

CREATE TABLE iam.mfa_recovery_code (
  user_id uuid NOT NULL REFERENCES iam.user_account (id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, code_hash)
);

-- Role catalogue (doc 03 §2) — global reference data, seeded here by design (doc 05 §16).
INSERT INTO iam.role (key, title, org_type_scope, description) VALUES
  ('org_admin', 'Organization administrator', 'any', 'Manage members and organization settings'),
  ('customer_requester', 'Customer requester', 'customer', 'Create enquiries, upload, clarify'),
  ('customer_approver', 'Customer approver', 'customer', 'Approve quotes, changes, deviations, deliveries within limits'),
  ('supplier_estimator', 'Supplier estimator', 'supplier', 'Read RFQs, clarify, submit feasibility and bids'),
  ('supplier_production', 'Supplier production', 'supplier', 'Acknowledge PO/baseline, plan, report progress'),
  ('supplier_quality', 'Supplier quality', 'supplier', 'Submit inspection evidence and NCR responses'),
  ('jobwork_sales', 'JobWork sales', 'internal', 'Customer relationship and sell-side quotation'),
  ('jobwork_sourcing', 'JobWork sourcing', 'internal', 'Supplier eligibility, RFQ, evaluation, award proposal'),
  ('jobwork_engineering', 'JobWork engineering', 'internal', 'Requirement validation, baseline and change control'),
  ('jobwork_quality', 'JobWork quality', 'internal', 'Quality plans, inspection review, NCR, release'),
  ('jobwork_finance', 'JobWork finance', 'internal', 'Receivables, payables, reconciliation'),
  ('jobwork_logistics', 'JobWork logistics', 'internal', 'Shipments, receiving, dispatch'),
  ('jobwork_support', 'JobWork support', 'internal', 'Disputes, warranty, case coordination'),
  ('platform_admin', 'Platform administrator', 'internal', 'Users, roles, configuration; no ambient business-data access'),
  ('security_admin', 'Security administrator', 'internal', 'Session revocation, incident response'),
  ('auditor', 'Auditor', 'internal', 'Scoped read-only evidence review');
