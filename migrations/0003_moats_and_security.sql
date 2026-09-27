-- Issues: one fix shared by many reviews, ranked by the stars it's costing.
CREATE TABLE issues (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  fix_note TEXT,
  target_version TEXT,
  status TEXT NOT NULL DEFAULT 'open',          -- open | shipped
  shipped_version TEXT,
  shipped_at TEXT,
  reminded_at TEXT,                             -- promise tracker reminder sent
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_issues_app ON issues(app_id, status);
CREATE INDEX idx_issues_user ON issues(user_id, status);

ALTER TABLE reviews ADD COLUMN issue_id TEXT REFERENCES issues(id) ON DELETE SET NULL;
CREATE INDEX idx_reviews_issue ON reviews(issue_id);

-- Public fix log and badge (opt-in per app).
ALTER TABLE apps ADD COLUMN public_slug TEXT;
ALTER TABLE apps ADD COLUMN public_log INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX idx_apps_public_slug ON apps(public_slug);

-- Release guard: low-star spike check after each release.
ALTER TABLE releases ADD COLUMN guard_status TEXT;    -- ok | spike
ALTER TABLE releases ADD COLUMN guard_ratio REAL;
ALTER TABLE releases ADD COLUMN guard_low INTEGER;
ALTER TABLE releases ADD COLUMN guard_checked_at TEXT;

-- Peer benchmarks, recomputed daily from all real-store data.
CREATE TABLE benchmarks (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  computed_at TEXT NOT NULL,
  data TEXT NOT NULL
);

-- Security activity per account.
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  detail TEXT,
  ip_hash TEXT,
  country TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_audit_user ON audit_log(user_id, created_at DESC);

ALTER TABLE users ADD COLUMN github_2fa INTEGER;
