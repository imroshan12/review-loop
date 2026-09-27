-- ReviewLoop schema. Timestamps are ISO-8601 UTC strings.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  github_id INTEGER UNIQUE,
  login TEXT NOT NULL,
  name TEXT,
  email TEXT,
  avatar_url TEXT,
  plan TEXT NOT NULL DEFAULT 'free',          -- free | pro
  plan_status TEXT,                           -- last status reported by the payment provider
  plan_renews_at TEXT,                        -- pro access lasts until this time
  billing_customer_id TEXT,
  billing_subscription_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,                -- sha256 of the cookie token
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  voice_notes TEXT NOT NULL DEFAULT '',
  signature TEXT NOT NULL DEFAULT '',
  support_contact TEXT NOT NULL DEFAULT '',
  alert_max_rating INTEGER NOT NULL DEFAULT 2,
  email_alerts INTEGER NOT NULL DEFAULT 1,
  slack_webhook TEXT,                         -- encrypted
  discord_webhook TEXT,                       -- encrypted
  auto_followup INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE connections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  store TEXT NOT NULL,                        -- apple | google | demo
  label TEXT NOT NULL,
  credentials TEXT NOT NULL,                  -- AES-GCM encrypted JSON
  status TEXT NOT NULL DEFAULT 'ok',          -- ok | error
  last_error TEXT,
  last_synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_connections_user ON connections(user_id);
CREATE INDEX idx_connections_sync ON connections(last_synced_at);

CREATE TABLE apps (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  store TEXT NOT NULL,
  store_app_id TEXT NOT NULL,                 -- Apple app id or Android package name
  name TEXT NOT NULL,
  bundle_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 0,
  latest_version TEXT,
  auto_release INTEGER NOT NULL DEFAULT 1,    -- 0 once the store refuses release lookups
  last_review_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (connection_id, store_app_id)
);
CREATE INDEX idx_apps_user ON apps(user_id);

CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  store TEXT NOT NULL,
  store_review_id TEXT NOT NULL,
  rating INTEGER NOT NULL,
  rating_before INTEGER,                      -- rating before the reviewer raised it
  rating_raised_at TEXT,
  title TEXT,
  body TEXT NOT NULL DEFAULT '',
  author TEXT,
  territory TEXT,
  language TEXT,
  app_version TEXT,
  device TEXT,
  reviewed_at TEXT NOT NULL,
  category TEXT,                              -- bug | feature_request | praise | pricing | question | other
  summary TEXT,
  draft TEXT,
  reply_text TEXT,
  reply_state TEXT NOT NULL DEFAULT 'none',   -- none | existing | sent | failed
  reply_error TEXT,
  replied_at TEXT,
  store_response_id TEXT,
  status TEXT NOT NULL DEFAULT 'open',        -- open | done | fix_pending | followup_ready | followed_up
  fix_note TEXT,
  fix_pending_at TEXT,
  fixed_in_version TEXT,
  followup_draft TEXT,
  followup_ai INTEGER NOT NULL DEFAULT 0,
  followed_up_at TEXT,
  alerted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (app_id, store_review_id)
);
CREATE INDEX idx_reviews_inbox ON reviews(user_id, status, reviewed_at DESC);
CREATE INDEX idx_reviews_app ON reviews(app_id, status);

CREATE TABLE releases (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  released_at TEXT NOT NULL,
  source TEXT NOT NULL,                       -- store | reviews | manual
  followups_created INTEGER NOT NULL DEFAULT 0,
  UNIQUE (app_id, version)
);

CREATE TABLE usage (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month TEXT NOT NULL,                        -- YYYY-MM
  ai_drafts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, month)
);

CREATE TABLE billing_events (
  id TEXT PRIMARY KEY,                        -- webhook-id header, for idempotency
  type TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
