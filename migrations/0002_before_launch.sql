-- Broken-key handling: retry failing connections with backoff and tell the user once.
ALTER TABLE connections ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE connections ADD COLUMN next_sync_at TEXT;
ALTER TABLE connections ADD COLUMN failure_notified_at TEXT;
CREATE INDEX idx_connections_next_sync ON connections(next_sync_at);

-- AI spending cap: drafts and tokens per UTC day, across all users.
CREATE TABLE ai_daily (
  day TEXT PRIMARY KEY,                       -- YYYY-MM-DD (UTC)
  free_drafts INTEGER NOT NULL DEFAULT 0,
  total_drafts INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0
);

-- Founder dashboard funnel.
ALTER TABLE users ADD COLUMN sample_loaded_at TEXT;

-- Housekeeping deletes expired sessions by date.
CREATE INDEX idx_sessions_expires ON sessions(expires_at);
