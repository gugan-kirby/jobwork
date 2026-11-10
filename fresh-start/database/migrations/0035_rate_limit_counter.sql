-- F-CW.1 (ADR-0009): rate-limit counters for deployments without Redis. One row per key and
-- fixed window; the store reads the current and previous windows for its sliding estimate.
-- UNLOGGED: counters are disposable, so they skip the WAL and do not survive a crash.
CREATE UNLOGGED TABLE platform.rate_limit_counter (
  key          text        NOT NULL,
  window_index bigint      NOT NULL,
  count        integer     NOT NULL,
  expires_at   timestamptz NOT NULL,
  PRIMARY KEY (key, window_index)
);

CREATE INDEX rate_limit_counter_expires_at ON platform.rate_limit_counter (expires_at);
