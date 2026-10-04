-- A dead letter a person has decided needs no side effect (IN-11 F-11.4; doc 12 §4
-- "controlled replay"; DO-14). Replay puts a dead event back to `pending`; dismissal
-- closes it as `dismissed` — never `delivered`, which would claim a side effect that did
-- not happen. Both are audited commands with a reason; the row keeps its last error.
ALTER TABLE platform.outbox_event DROP CONSTRAINT outbox_event_status_check;
ALTER TABLE platform.outbox_event
  ADD CONSTRAINT outbox_event_status_check
  CHECK (status IN ('pending', 'processing', 'delivered', 'dead', 'dismissed'));
