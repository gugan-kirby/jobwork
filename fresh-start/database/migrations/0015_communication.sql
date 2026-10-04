-- Threads, contact-leakage review and notifications (IN-10; FR-1001..FR-1005; BR-AUTH-06;
-- doc 07 §12; doc 11 §9; doc 14 §11; D-18).
--
-- The in-app thread is the system of record; email, SMS and WhatsApp only deliver (D-18).
-- Every message states its audience when it is written and keeps it: external listings
-- select by that audience, so an internal note cannot reach a customer or a supplier
-- through a missed filter. A message that may leak a party's identity waits for a person,
-- and nothing a person wrote is ever rewritten in place.

CREATE SCHEMA communication;

-- ------------------------------------------------------------------ conversation

-- One thread per business context. `context_id` points into sourcing/orders by type, so
-- it carries no foreign key; the API resolves and authorizes the context on every read
-- and write, and never creates a conversation for a context it could not load.
CREATE TABLE communication.conversation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  context_type text NOT NULL CHECK (context_type IN ('enquiry', 'rfq', 'sales_order', 'purchase_order')),
  context_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (context_type, context_id)
);

-- The external organizations a conversation is held with: the customer of an enquiry
-- or order, each supplier that has exchanged messages on an RFQ, the supplier of a PO.
CREATE TABLE communication.participant (
  conversation_id uuid NOT NULL REFERENCES communication.conversation (id),
  organization_id uuid NOT NULL REFERENCES iam.organization (id),
  party text NOT NULL CHECK (party IN ('customer', 'supplier')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, organization_id)
);
CREATE INDEX idx_participant_org ON communication.participant (organization_id);

-- ------------------------------------------------------------------ message

CREATE TABLE communication.message (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES communication.conversation (id),
  audience text NOT NULL CHECK (audience IN ('internal', 'customer', 'supplier', 'shared_technical')),
  -- The one supplier a supplier-audience message is between JobWork and.
  counterpart_organization_id uuid REFERENCES iam.organization (id),
  author_user_id uuid NOT NULL REFERENCES iam.user_account (id),
  author_organization_id uuid NOT NULL REFERENCES iam.organization (id),
  author_party text NOT NULL CHECK (author_party IN ('internal', 'customer', 'supplier')),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 8000),
  body_sha256 text NOT NULL,
  status text NOT NULL DEFAULT 'visible' CHECK (status IN ('visible', 'held', 'rejected', 'superseded')),
  -- A redacted release or a question JobWork republished to every invited supplier is a
  -- new message pointing at its source; the source is never edited (doc 07 §12).
  derived_from_message_id uuid REFERENCES communication.message (id),
  derivation text CHECK (derivation IS NULL OR derivation IN ('redacted', 'shared')),
  posted_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  aggregate_version integer NOT NULL DEFAULT 1,
  CONSTRAINT chk_message_counterpart CHECK ((audience = 'supplier') = (counterpart_organization_id IS NOT NULL)),
  CONSTRAINT chk_message_derivation CHECK ((derived_from_message_id IS NULL) = (derivation IS NULL)),
  -- Notes between JobWork staff never wait for a leakage review: nobody outside sees them.
  CONSTRAINT chk_message_internal_visible CHECK (audience <> 'internal' OR status = 'visible'),
  CONSTRAINT chk_message_internal_author CHECK (audience <> 'internal' OR author_party = 'internal'),
  CONSTRAINT chk_message_shared_author CHECK (audience <> 'shared_technical' OR author_party = 'internal')
);

CREATE INDEX idx_message_thread ON communication.message (conversation_id, posted_at);
CREATE INDEX idx_message_counterpart ON communication.message (counterpart_organization_id)
  WHERE counterpart_organization_id IS NOT NULL;
CREATE INDEX idx_message_derived ON communication.message (derived_from_message_id)
  WHERE derived_from_message_id IS NOT NULL;
CREATE INDEX idx_message_author ON communication.message (author_user_id);
CREATE INDEX idx_message_author_org ON communication.message (author_organization_id);

-- What was said, to whom, by whom, is permanent. Only a held message's fate may change.
CREATE FUNCTION communication.forbid_message_rewrite() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'messages are append-only';
  END IF;
  IF NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
    OR NEW.audience IS DISTINCT FROM OLD.audience
    OR NEW.counterpart_organization_id IS DISTINCT FROM OLD.counterpart_organization_id
    OR NEW.author_user_id IS DISTINCT FROM OLD.author_user_id
    OR NEW.author_organization_id IS DISTINCT FROM OLD.author_organization_id
    OR NEW.author_party IS DISTINCT FROM OLD.author_party
    OR NEW.body IS DISTINCT FROM OLD.body
    OR NEW.body_sha256 IS DISTINCT FROM OLD.body_sha256
    OR NEW.derived_from_message_id IS DISTINCT FROM OLD.derived_from_message_id
    OR NEW.derivation IS DISTINCT FROM OLD.derivation
    OR NEW.posted_at IS DISTINCT FROM OLD.posted_at
  THEN
    RAISE EXCEPTION 'message % is immutable: audience, author and body never change', OLD.id;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
    AND NOT (OLD.status = 'held' AND NEW.status IN ('visible', 'rejected', 'superseded'))
  THEN
    RAISE EXCEPTION 'message % cannot move from % to %', OLD.id, OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_message_immutable
  BEFORE UPDATE OR DELETE ON communication.message
  FOR EACH ROW EXECUTE FUNCTION communication.forbid_message_rewrite();

-- Reserved for the file half of leakage review (doc 07 §12 stages 3–4); the API refuses
-- attachments until an external attachment can carry its own audience grant.
CREATE TABLE communication.message_attachment (
  message_id uuid NOT NULL REFERENCES communication.message (id),
  document_version_id uuid NOT NULL REFERENCES dms.document_version (id),
  PRIMARY KEY (message_id, document_version_id)
);
CREATE INDEX idx_message_attachment_version ON communication.message_attachment (document_version_id);

-- ------------------------------------------------------------------ leakage review

CREATE TABLE communication.leakage_review (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL UNIQUE REFERENCES communication.message (id),
  action text NOT NULL CHECK (action IN ('warn', 'quarantine')),
  -- Detector, kind, matched span and normalized evidence per finding. Never the
  -- registry entry itself beyond the matched text.
  findings jsonb NOT NULL CHECK (jsonb_typeof(findings) = 'array'),
  detector_version text NOT NULL,
  -- `noted`: a warning recorded on a message that is already visible; nobody must act.
  status text NOT NULL CHECK (status IN ('open', 'noted', 'released', 'released_redacted', 'rejected')),
  decided_by uuid REFERENCES iam.user_account (id),
  decided_at timestamptz,
  decision_reason text,
  derived_message_id uuid REFERENCES communication.message (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  aggregate_version integer NOT NULL DEFAULT 1,
  CONSTRAINT chk_review_undecided CHECK ((status IN ('open', 'noted')) = (decided_at IS NULL)),
  CONSTRAINT chk_review_decider CHECK ((decided_at IS NULL) = (decided_by IS NULL)),
  CONSTRAINT chk_review_warn CHECK (action = 'quarantine' OR status = 'noted'),
  CONSTRAINT chk_review_quarantine CHECK (action = 'warn' OR status <> 'noted'),
  CONSTRAINT chk_review_redacted CHECK ((status = 'released_redacted') = (derived_message_id IS NOT NULL)),
  CONSTRAINT chk_review_reason CHECK (decided_at IS NULL OR char_length(btrim(decision_reason)) >= 3)
);
CREATE INDEX idx_leakage_review_open ON communication.leakage_review (created_at) WHERE status = 'open';
CREATE INDEX idx_leakage_review_decider ON communication.leakage_review (decided_by) WHERE decided_by IS NOT NULL;
CREATE INDEX idx_leakage_review_derived ON communication.leakage_review (derived_message_id)
  WHERE derived_message_id IS NOT NULL;

-- ------------------------------------------------------------------ templates

-- A template version is what a notification was rendered from, so it never changes;
-- wording changes ship as a new version. `variables` is the allowlist: rendering refuses
-- a placeholder outside it (doc 11 "notification leak").
CREATE TABLE communication.template_version (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_key text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  locale text NOT NULL DEFAULT 'en-IN',
  channel text NOT NULL CHECK (channel IN ('in_app', 'email', 'sms', 'whatsapp')),
  audience text NOT NULL CHECK (audience IN ('customer', 'supplier', 'internal')),
  subject text NOT NULL,
  body text NOT NULL,
  variables text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_key, channel, locale, version),
  CONSTRAINT chk_template_key_audience CHECK (split_part(template_key, '.', 1) = audience)
);

CREATE FUNCTION communication.forbid_template_rewrite() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'template versions are immutable; add a new version instead';
END $$;

CREATE TRIGGER trg_template_version_immutable
  BEFORE UPDATE OR DELETE ON communication.template_version
  FOR EACH ROW EXECUTE FUNCTION communication.forbid_template_rewrite();

-- ------------------------------------------------------------------ notifications

-- One in-app notification per (committed event, recipient, template). The outbox is
-- never pruned today; if retention arrives, this reference moves to an archive first.
CREATE TABLE communication.notification (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_user_id uuid NOT NULL REFERENCES iam.user_account (id),
  recipient_organization_id uuid NOT NULL REFERENCES iam.organization (id),
  template_key text NOT NULL,
  template_version_id uuid NOT NULL REFERENCES communication.template_version (id),
  locale text NOT NULL,
  -- Transactional service messages only in this increment; marketing needs opt-in.
  consent_basis text NOT NULL CHECK (consent_basis IN ('transactional')),
  title text NOT NULL,
  body text NOT NULL,
  -- App-relative path to the authenticated page; never a token, never the message text.
  link text NOT NULL CHECK (link LIKE '/%'),
  source_event_id uuid NOT NULL REFERENCES platform.outbox_event (id),
  correlation_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  UNIQUE (source_event_id, recipient_user_id, template_key)
);
CREATE INDEX idx_notification_feed ON communication.notification (recipient_user_id, created_at DESC);
CREATE INDEX idx_notification_unread ON communication.notification (recipient_user_id) WHERE read_at IS NULL;
CREATE INDEX idx_notification_org ON communication.notification (recipient_organization_id);
CREATE INDEX idx_notification_template ON communication.notification (template_version_id);

CREATE FUNCTION communication.forbid_notification_rewrite() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'notifications are append-only';
  END IF;
  IF (to_jsonb(NEW) - 'read_at') IS DISTINCT FROM (to_jsonb(OLD) - 'read_at') THEN
    RAISE EXCEPTION 'notification % is immutable apart from its read state', OLD.id;
  END IF;
  IF OLD.read_at IS NOT NULL AND NEW.read_at IS DISTINCT FROM OLD.read_at THEN
    RAISE EXCEPTION 'notification % is already read', OLD.id;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_notification_immutable
  BEFORE UPDATE OR DELETE ON communication.notification
  FOR EACH ROW EXECUTE FUNCTION communication.forbid_notification_rewrite();

-- One row per try. `delivery_id` is stable across retries of the same notification on
-- the same channel, so a provider seeing it twice can deduplicate and so can we.
CREATE TABLE communication.delivery_attempt (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id uuid NOT NULL,
  notification_id uuid NOT NULL REFERENCES communication.notification (id),
  channel text NOT NULL CHECK (channel IN ('email', 'sms', 'whatsapp')),
  template_version_id uuid NOT NULL REFERENCES communication.template_version (id),
  destination text NOT NULL,
  attempt_no integer NOT NULL CHECK (attempt_no > 0),
  status text NOT NULL CHECK (status IN ('sending', 'sent', 'failed')),
  provider_reference text,
  error_code text,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (delivery_id, attempt_no),
  CONSTRAINT chk_delivery_completed CHECK ((status = 'sending') = (completed_at IS NULL))
);
-- At most one success per delivery: a duplicate report cannot make it look sent twice.
CREATE UNIQUE INDEX uq_delivery_sent ON communication.delivery_attempt (delivery_id) WHERE status = 'sent';
CREATE INDEX idx_delivery_notification ON communication.delivery_attempt (notification_id, channel);
CREATE INDEX idx_delivery_template ON communication.delivery_attempt (template_version_id);

-- ------------------------------------------------------------------ v1 templates

-- Wording rules (doc 14 §11, doc 11 "notification leak"): a notification names the
-- record and links to it; it never carries a message body, a price breakdown, or the
-- other party's identity. Every variable below is a reference the recipient can already see.
INSERT INTO communication.template_version (template_key, version, channel, audience, subject, body, variables) VALUES
  ('customer.clarification_requested', 1, 'in_app', 'customer',
   'JobWork has a question about {{enquiryReference}}',
   'Answer it so sourcing can continue.', ARRAY['enquiryReference', 'link']),
  ('customer.clarification_requested', 1, 'email', 'customer',
   'JobWork has a question about {{enquiryReference}}',
   E'JobWork needs more information about your enquiry {{enquiryReference}} before it can be sourced.\n\nSign in to read and answer the question:\n{{link}}', ARRAY['enquiryReference', 'link']),

  ('customer.quote_sent', 1, 'in_app', 'customer',
   'Your quotation {{quoteReference}} is ready',
   'Valid until {{validityUntil}}.', ARRAY['quoteReference', 'validityUntil', 'link']),
  ('customer.quote_sent', 1, 'email', 'customer',
   'Your quotation {{quoteReference}} is ready',
   E'JobWork has sent you quotation {{quoteReference}}. It is valid until {{validityUntil}}.\n\nSign in to review and accept it:\n{{link}}', ARRAY['quoteReference', 'validityUntil', 'link']),

  ('customer.invoice_issued', 1, 'in_app', 'customer',
   'Invoice {{invoiceNumber}} issued',
   'Due {{dueDate}}.', ARRAY['invoiceNumber', 'dueDate', 'link']),
  ('customer.invoice_issued', 1, 'email', 'customer',
   'Invoice {{invoiceNumber}} from JobWork',
   E'JobWork has issued invoice {{invoiceNumber}}, due {{dueDate}}.\n\nSign in to view and pay it:\n{{link}}', ARRAY['invoiceNumber', 'dueDate', 'link']),

  ('customer.payment_received', 1, 'in_app', 'customer',
   'Payment received for {{invoiceNumber}}',
   'Thank you. The receipt is on the invoice.', ARRAY['invoiceNumber', 'link']),
  ('customer.payment_received', 1, 'email', 'customer',
   'Payment received for {{invoiceNumber}}',
   E'JobWork has received your payment against invoice {{invoiceNumber}}.\n\nSign in to see the receipt:\n{{link}}', ARRAY['invoiceNumber', 'link']),

  ('customer.message_received', 1, 'in_app', 'customer',
   'New message about {{contextLabel}}',
   'Open the conversation to read it.', ARRAY['contextLabel', 'link']),
  ('customer.message_received', 1, 'email', 'customer',
   'New message about {{contextLabel}}',
   E'JobWork has sent you a message about {{contextLabel}}.\n\nSign in to read and reply:\n{{link}}', ARRAY['contextLabel', 'link']),

  ('supplier.rfq_invitation', 1, 'in_app', 'supplier',
   'New request for quotation {{rfqReference}}',
   'Respond by {{deadline}}.', ARRAY['rfqReference', 'deadline', 'link']),
  ('supplier.rfq_invitation', 1, 'email', 'supplier',
   'New request for quotation {{rfqReference}}',
   E'JobWork has invited you to quote on {{rfqReference}}. Responses close {{deadline}}.\n\nSign in to review the request:\n{{link}}', ARRAY['rfqReference', 'deadline', 'link']),

  ('supplier.purchase_order_issued', 1, 'in_app', 'supplier',
   'Purchase order {{purchaseOrderNumber}} issued',
   'Acknowledge it to confirm you will make it.', ARRAY['purchaseOrderNumber', 'link']),
  ('supplier.purchase_order_issued', 1, 'email', 'supplier',
   'Purchase order {{purchaseOrderNumber}} from JobWork',
   E'JobWork has issued purchase order {{purchaseOrderNumber}} to you.\n\nSign in to review and acknowledge it:\n{{link}}', ARRAY['purchaseOrderNumber', 'link']),

  ('supplier.transmittal_issued', 1, 'in_app', 'supplier',
   'Technical package {{transmittalNumber}} sent',
   'Acknowledge it before production starts.', ARRAY['transmittalNumber', 'link']),
  ('supplier.transmittal_issued', 1, 'email', 'supplier',
   'Technical package {{transmittalNumber}} from JobWork',
   E'JobWork has sent you technical package {{transmittalNumber}}. Production cannot start until you acknowledge it.\n\nSign in to review it:\n{{link}}', ARRAY['transmittalNumber', 'link']),

  ('supplier.evidence_rejected', 1, 'in_app', 'supplier',
   'Evidence returned for {{purchaseOrderNumber}}',
   'JobWork needs more evidence for a milestone.', ARRAY['purchaseOrderNumber', 'link']),
  ('supplier.evidence_rejected', 1, 'email', 'supplier',
   'Evidence returned for {{purchaseOrderNumber}}',
   E'JobWork could not verify a milestone on purchase order {{purchaseOrderNumber}} from the evidence submitted.\n\nSign in to see what is needed:\n{{link}}', ARRAY['purchaseOrderNumber', 'link']),

  ('supplier.message_received', 1, 'in_app', 'supplier',
   'New message about {{contextLabel}}',
   'Open the conversation to read it.', ARRAY['contextLabel', 'link']),
  ('supplier.message_received', 1, 'email', 'supplier',
   'New message about {{contextLabel}}',
   E'JobWork has sent you a message about {{contextLabel}}.\n\nSign in to read and reply:\n{{link}}', ARRAY['contextLabel', 'link']),

  ('internal.enquiry_submitted', 1, 'in_app', 'internal',
   'Enquiry {{enquiryReference}} submitted',
   'Waiting for triage.', ARRAY['enquiryReference', 'link']),
  ('internal.enquiry_submitted', 1, 'email', 'internal',
   'Enquiry {{enquiryReference}} submitted',
   E'Enquiry {{enquiryReference}} is waiting for triage.\n\n{{link}}', ARRAY['enquiryReference', 'link']),

  ('internal.clarification_answered', 1, 'in_app', 'internal',
   'Customer answered on {{enquiryReference}}',
   'Review the answers and continue triage.', ARRAY['enquiryReference', 'link']),
  ('internal.clarification_answered', 1, 'email', 'internal',
   'Customer answered on {{enquiryReference}}',
   E'The customer has answered the open questions on {{enquiryReference}}.\n\n{{link}}', ARRAY['enquiryReference', 'link']),

  ('internal.bid_submitted', 1, 'in_app', 'internal',
   'Bid received on {{rfqReference}}',
   'A supplier submitted a bid.', ARRAY['rfqReference', 'link']),
  ('internal.bid_submitted', 1, 'email', 'internal',
   'Bid received on {{rfqReference}}',
   E'A supplier has submitted a bid on {{rfqReference}}.\n\n{{link}}', ARRAY['rfqReference', 'link']),

  ('internal.approval_requested', 1, 'in_app', 'internal',
   'Approval requested: {{subjectLabel}}',
   'A decision is waiting for your role.', ARRAY['subjectLabel', 'link']),
  ('internal.approval_requested', 1, 'email', 'internal',
   'Approval requested: {{subjectLabel}}',
   E'{{subjectLabel}} is waiting for an approval your role can give.\n\n{{link}}', ARRAY['subjectLabel', 'link']),

  ('internal.quote_accepted', 1, 'in_app', 'internal',
   'Quotation {{quoteReference}} accepted',
   'The order has been created.', ARRAY['quoteReference', 'link']),
  ('internal.quote_accepted', 1, 'email', 'internal',
   'Quotation {{quoteReference}} accepted',
   E'The customer has accepted quotation {{quoteReference}} and the order has been created.\n\n{{link}}', ARRAY['quoteReference', 'link']),

  ('internal.evidence_submitted', 1, 'in_app', 'internal',
   'Milestone evidence to verify',
   'A supplier submitted evidence on {{purchaseOrderNumber}}.', ARRAY['purchaseOrderNumber', 'link']),
  ('internal.evidence_submitted', 1, 'email', 'internal',
   'Milestone evidence to verify on {{purchaseOrderNumber}}',
   E'A supplier has submitted milestone evidence on {{purchaseOrderNumber}}.\n\n{{link}}', ARRAY['purchaseOrderNumber', 'link']),

  ('internal.message_received', 1, 'in_app', 'internal',
   'New message about {{contextLabel}}',
   'Open the conversation to read it.', ARRAY['contextLabel', 'link']),
  ('internal.message_received', 1, 'email', 'internal',
   'New message about {{contextLabel}}',
   E'There is a new message about {{contextLabel}}.\n\n{{link}}', ARRAY['contextLabel', 'link']),

  ('internal.leakage_review_opened', 1, 'in_app', 'internal',
   'Message held for review on {{contextLabel}}',
   'It may name a party or carry contact details.', ARRAY['contextLabel', 'link']),
  ('internal.leakage_review_opened', 1, 'email', 'internal',
   'Message held for review on {{contextLabel}}',
   E'A message on {{contextLabel}} was held because it may name a party or carry contact details. It stays invisible until someone reviews it.\n\n{{link}}', ARRAY['contextLabel', 'link']);
