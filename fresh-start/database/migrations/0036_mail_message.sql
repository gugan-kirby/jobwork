-- F-CW.5 (ADR-0009): where mail goes when the environment sends none. The worker hands each
-- rendered message to the API, which keeps it here for platform admins to read on the
-- operations Mail page. One row per delivery, so a retried hand-over is not a second copy.
CREATE TABLE communication.mail_message (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id text        NOT NULL UNIQUE,
  recipient   text        NOT NULL,
  subject     text        NOT NULL,
  body        text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX mail_message_created_at ON communication.mail_message (created_at DESC);
