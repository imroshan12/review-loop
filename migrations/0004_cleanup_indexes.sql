-- Scheduled jobs (Release Guard, promise tracker, cleanup) run every 30 minutes.
-- Without these indexes each run scans whole tables that only grow, and D1 bills every row read.
CREATE INDEX idx_audit_created ON audit_log(created_at);
CREATE INDEX idx_billing_events_received ON billing_events(received_at);
CREATE INDEX idx_releases_released ON releases(released_at);
CREATE INDEX idx_issues_status ON issues(status, reminded_at);
