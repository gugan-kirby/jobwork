-- Self-registration and supplier applications (F-MX.4, prototype tile 3).
--
-- A customer may register itself (doc 20 §2 "where policy allows"; policy: allowed,
-- email verified before the first sign-in). A supplier may only *apply*: the Vendor tab
-- of the prototype creates a request JobWork reviews, never an account, because
-- admission to the network is an explicit decision (F-SO).

ALTER TABLE iam.user_account
  ADD COLUMN phone text NOT NULL DEFAULT '';

/*
 * One-shot email verification. Same posture as invitations (AUTH-08): the raw token is
 * never stored, the link expires, and consumption is a guarded UPDATE so two clicks
 * cannot both succeed.
 */
CREATE TABLE iam.email_verification (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES iam.user_account (id),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_email_verification_user ON iam.email_verification (user_id)
  WHERE used_at IS NULL;

/*
 * A supplier's request to join the network. It carries what a workshop says about
 * itself at the door; nothing here is verified, matched, or visible to any customer.
 * Admission links the application to the organization it produced, so the trail from
 * "applied" to "admitted" is one join.
 */
CREATE TABLE supplier.network_application (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name text NOT NULL,
  contact_name text NOT NULL,
  email citext NOT NULL,
  phone text NOT NULL DEFAULT '',
  city text NOT NULL DEFAULT '',
  process_codes text[] NOT NULL DEFAULT '{}',
  note text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'admitted', 'declined')),
  decided_by uuid,
  decided_at timestamptz,
  decision_reason text NOT NULL DEFAULT '',
  admitted_organization_id uuid REFERENCES iam.organization (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- A decision is a who-and-when; an open application has neither.
  CONSTRAINT chk_application_decision CHECK (
    (status = 'received') = (decided_at IS NULL AND decided_by IS NULL)
  ),
  -- Admission produced an organization; a decline or an open request did not.
  CONSTRAINT chk_application_admitted_org CHECK (
    (status = 'admitted') = (admitted_organization_id IS NOT NULL)
  ),
  -- A decline names its reason (doc 03 §5: every negative decision carries one).
  CONSTRAINT chk_application_decline_reason CHECK (
    status <> 'declined' OR length(decision_reason) > 0
  )
);

CREATE INDEX idx_network_application_open ON supplier.network_application (created_at)
  WHERE status = 'received';
